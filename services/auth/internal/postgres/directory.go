package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

var _ auth.DirectoryRepository = (*Repository)(nil)

func (r *Repository) GetUser(ctx context.Context, id string) (auth.User, error) {
	var user auth.User
	err := r.db.QueryRowContext(ctx, `SELECT id, username, created_at FROM auth.users WHERE id=$1`, id).Scan(&user.ID, &user.Username, &user.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.User{}, auth.ErrUserNotFound
	}
	if err != nil {
		return auth.User{}, errors.New("read user profile failed")
	}
	return user, nil
}

func (r *Repository) SearchUsers(ctx context.Context, prefix string) ([]auth.UserSummary, error) {
	// '_' is valid in a username and must be literal, not a LIKE wildcard.
	pattern := strings.ReplaceAll(prefix, "_", "!_") + "%"
	rows, err := r.db.QueryContext(ctx, `SELECT id,username FROM auth.users
 WHERE username_normalized LIKE $1 ESCAPE '!'
 ORDER BY username_normalized COLLATE "C" LIMIT 20`, pattern)
	if err != nil {
		return nil, errors.New("search users failed")
	}
	return readSummaries(rows)
}
func (r *Repository) ListContacts(ctx context.Context, owner string) ([]auth.UserSummary, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT u.id,u.username FROM auth.contacts c
 JOIN auth.users u ON u.id=c.contact_id WHERE c.user_id=$1
 ORDER BY u.username_normalized COLLATE "C"`, owner)
	if err != nil {
		return nil, errors.New("list contacts failed")
	}
	return readSummaries(rows)
}
func readSummaries(rows *sql.Rows) ([]auth.UserSummary, error) {
	defer func() { _ = rows.Close() }()
	users := make([]auth.UserSummary, 0)
	for rows.Next() {
		var user auth.UserSummary
		if err := rows.Scan(&user.ID, &user.Username); err != nil {
			return nil, errors.New("read public users failed")
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("read public users failed")
	}
	return users, nil
}
func (r *Repository) AddContact(ctx context.Context, owner, contact string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO auth.contacts(user_id,contact_id) VALUES($1,$2)
 ON CONFLICT(user_id,contact_id) DO NOTHING`, owner, contact)
	if err == nil {
		return nil
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23503" {
		switch pg.ConstraintName {
		case "contacts_contact_id_fkey":
			return auth.ErrUserNotFound
		case "contacts_user_id_fkey":
			return auth.ErrInvalidIdentity
		}
	}
	return errors.New("add contact failed")
}
func (r *Repository) RemoveContact(ctx context.Context, owner, contact string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM auth.contacts WHERE user_id=$1 AND contact_id=$2`, owner, contact)
	if err != nil {
		return errors.New("remove contact failed")
	}
	return nil
}
