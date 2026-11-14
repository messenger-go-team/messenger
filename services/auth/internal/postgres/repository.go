// Package postgres implements the auth repository against auth-owned tables.
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

type Repository struct{ db *sql.DB }

var _ auth.Repository = (*Repository)(nil)

func New(db *sql.DB) *Repository { return &Repository{db: db} }

func (r *Repository) CreateUser(ctx context.Context, username, hash string) (auth.User, error) {
	var user auth.User
	err := r.db.QueryRowContext(ctx, `INSERT INTO auth.users (username, username_normalized, password_hash)
 VALUES ($1, $2, $3) RETURNING id, username, created_at`, username, strings.ToLower(username), hash).
		Scan(&user.ID, &user.Username, &user.CreatedAt)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "users_username_normalized_uq" {
			return auth.User{}, auth.ErrUsernameTaken
		}
		return auth.User{}, errors.New("create auth user failed")
	}
	return user, nil
}

func (r *Repository) FindAccount(ctx context.Context, normalized string) (auth.Account, error) {
	var account auth.Account
	err := r.db.QueryRowContext(ctx, `SELECT id, username, created_at, password_hash FROM auth.users WHERE username_normalized = $1`, normalized).
		Scan(&account.ID, &account.Username, &account.CreatedAt, &account.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Account{}, auth.ErrUserNotFound
	}
	if err != nil {
		return auth.Account{}, errors.New("find auth account failed")
	}
	return account, nil
}

func (r *Repository) CreateRefresh(ctx context.Context, userID, hash string, ttl time.Duration) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO auth.refresh_tokens (user_id, token_hash, expires_at)
 VALUES ($1, $2, clock_timestamp() + $3 * interval '1 second')`, userID, hash, ttl.Seconds())
	if err != nil {
		return errors.New("create refresh session failed")
	}
	return nil
}

// consume locks before checking expiry. now()/CURRENT_TIMESTAMP are the start
// of the transaction and could accept a token that expired while waiting.
func consume(ctx context.Context, tx *sql.Tx, hash string) (string, error) {
	var id, userID string
	err := tx.QueryRowContext(ctx, `SELECT id FROM auth.refresh_tokens WHERE token_hash = $1 FOR UPDATE`, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", auth.ErrInvalidRefreshToken
	}
	if err != nil {
		return "", errors.New("lock refresh session failed")
	}
	err = tx.QueryRowContext(ctx, `UPDATE auth.refresh_tokens SET revoked_at = clock_timestamp()
 WHERE id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING user_id`, id).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", auth.ErrInvalidRefreshToken
	}
	if err != nil {
		return "", errors.New("revoke refresh session failed")
	}
	return userID, nil
}

func (r *Repository) RotateRefresh(ctx context.Context, previous, next string, ttl time.Duration) (auth.User, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.User{}, errors.New("begin refresh rotation failed")
	}
	defer func() { _ = tx.Rollback() }()
	userID, err := consume(ctx, tx, previous)
	if err != nil {
		return auth.User{}, err
	}
	var user auth.User
	if err := tx.QueryRowContext(ctx, `SELECT id, username, created_at FROM auth.users WHERE id = $1`, userID).
		Scan(&user.ID, &user.Username, &user.CreatedAt); err != nil {
		return auth.User{}, errors.New("read refresh user failed")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO auth.refresh_tokens (user_id, token_hash, expires_at)
 VALUES ($1, $2, clock_timestamp() + $3 * interval '1 second')`, userID, next, ttl.Seconds()); err != nil {
		return auth.User{}, errors.New("insert rotated refresh session failed")
	}
	// A lost commit acknowledgement has an unknown outcome. Never retry here.
	if err := tx.Commit(); err != nil {
		return auth.User{}, errors.New("commit refresh rotation failed")
	}
	return user, nil
}

func (r *Repository) RevokeRefresh(ctx context.Context, hash string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return errors.New("begin refresh revocation failed")
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := consume(ctx, tx, hash); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return errors.New("commit refresh revocation failed")
	}
	return nil
}
