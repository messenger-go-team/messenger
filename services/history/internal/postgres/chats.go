package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

type Repository struct{ DB *sql.DB }

func (r *Repository) Personal(ctx context.Context, a, b string) (chats.Chat, bool, error) {
	if a > b {
		a, b = b, a
	}
	tx, err := r.DB.BeginTx(ctx, nil)
	if err != nil {
		return chats.Chat{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	// Stable pair ordering and a transaction lock serialize both directions.
	// Hash collisions only serialize unrelated pairs; the unique pair is authoritative.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, a+":"+b); err != nil {
		return chats.Chat{}, false, err
	}
	var c chats.Chat
	err = tx.QueryRowContext(ctx, `SELECT c.id,c.type,c.created_at,c.last_seq FROM history.personal_chat_pairs p JOIN history.chats c ON c.id=p.chat_id WHERE p.user_low_id=$1 AND p.user_high_id=$2 FOR UPDATE OF c`, a, b).Scan(&c.ID, &c.Type, &c.CreatedAt, &c.LastSeq)
	created := errors.Is(err, sql.ErrNoRows)
	if created {
		err = tx.QueryRowContext(ctx, `INSERT INTO history.chats(type) VALUES('personal') RETURNING id,type,created_at,last_seq`).Scan(&c.ID, &c.Type, &c.CreatedAt, &c.LastSeq)
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO history.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')`, c.ID, a, b)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO history.personal_chat_pairs(user_low_id,user_high_id,chat_id) VALUES($1,$2,$3)`, a, b, c.ID)
		}
	}
	if err != nil {
		return chats.Chat{}, false, err
	}
	if !created {
		var count int
		var matching bool
		if err = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(bool_and(user_id IN ($2::uuid,$3::uuid)),false) FROM history.chat_members WHERE chat_id=$1`, c.ID, a, b).Scan(&count, &matching); err != nil {
			return chats.Chat{}, false, err
		}
		if count != 2 || !matching {
			return chats.Chat{}, false, chats.ErrUnavailable
		}
	}
	if err = tx.Commit(); err != nil {
		return chats.Chat{}, false, err
	}
	c.CreatedAt = c.CreatedAt.UTC()
	return c, created, nil
}
func (r *Repository) Membership(ctx context.Context, chat, user string) (bool, error) {
	var exists, member bool
	err := r.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM history.chats WHERE id=$1), EXISTS(SELECT 1 FROM history.chat_members WHERE chat_id=$1 AND user_id=$2)`, chat, user).Scan(&exists, &member)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, chats.ErrNotFound
	}
	return member, nil
}
func (r *Repository) Members(ctx context.Context, chat, requester string) ([]string, error) {
	rows, err := r.DB.QueryContext(ctx, `SELECT m.user_id,EXISTS(SELECT 1 FROM history.chat_members x WHERE x.chat_id=c.id AND x.user_id=$2) FROM history.chats c LEFT JOIN history.chat_members m ON m.chat_id=c.id WHERE c.id=$1 ORDER BY m.user_id`, chat, requester)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	exists := false
	for rows.Next() {
		exists = true
		var id sql.NullString
		var allowed bool
		if err = rows.Scan(&id, &allowed); err != nil {
			return nil, err
		}
		if !allowed {
			return nil, chats.ErrForbidden
		}
		if id.Valid {
			ids = append(ids, id.String)
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if !exists {
		return nil, chats.ErrNotFound
	}
	return ids, nil
}
func (r *Repository) Ready(ctx context.Context) error {
	for _, q := range []string{
		`SELECT id,type,created_at,last_seq FROM history.chats LIMIT 0`,
		`SELECT chat_id,user_id,role FROM history.chat_members LIMIT 0`,
		`SELECT user_low_id,user_high_id,chat_id FROM history.personal_chat_pairs LIMIT 0`,
		`SELECT id,chat_id,seq,sender_id,client_msg_id,body,created_at FROM history.messages LIMIT 0`,
	} {
		rows, err := r.DB.QueryContext(ctx, q)
		if err != nil {
			return err
		}
		if err = rows.Close(); err != nil {
			return err
		}
	}
	var allowed bool
	err := r.DB.QueryRowContext(ctx, `SELECT bool_and(has_table_privilege(t,p)) FROM unnest(ARRAY['history.chats','history.chat_members','history.personal_chat_pairs','history.messages']) t CROSS JOIN unnest(ARRAY['SELECT','INSERT']) p`).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return chats.ErrUnavailable
	}
	err = r.DB.QueryRowContext(ctx, `SELECT has_column_privilege('history.chats','last_seq','UPDATE') AND has_any_column_privilege('history.chat_members','UPDATE')`).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return chats.ErrUnavailable
	}
	return nil
}
