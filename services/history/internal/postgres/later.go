package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/messenger-go-team/messenger/services/history/internal/later"
)

// LaterRepository is not registered as an HTTP endpoint in #86. Owner IDs must
// come from a verified identity when #87 wires these operations into the API.
type LaterRepository struct{ DB *sql.DB }

var _ later.Repository = (*LaterRepository)(nil)

// lockLaterSource follows chat -> membership -> message order. These row locks
// preserve access and the source until commit, including an upsert of an entry
// that already exists. Loss of access must not delete the saved entry itself.
func lockLaterSource(ctx context.Context, tx *sql.Tx, user, chat, message string) error {
	// Reject inaccessible sources without waiting behind a writer to the chat.
	// This snapshot does not authorize the write: each row is rechecked and
	// locked below, using fresh Read Committed snapshots after any lock wait.
	var accessible bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM history.messages m
 JOIN history.chats c ON c.id=m.chat_id
 JOIN history.chat_members cm ON cm.chat_id=c.id AND cm.user_id=$1
 WHERE c.id=$2 AND m.id=$3)`, user, chat, message).Scan(&accessible)
	if err != nil {
		return err
	}
	if !accessible {
		return later.ErrNotFound
	}
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`SELECT 1 FROM history.chats WHERE id=$1 FOR KEY SHARE`, []any{chat}},
		{`SELECT 1 FROM history.chat_members WHERE chat_id=$1 AND user_id=$2 FOR KEY SHARE`, []any{chat, user}},
		{`SELECT 1 FROM history.messages WHERE id=$1 AND chat_id=$2 FOR KEY SHARE`, []any{message, chat}},
	} {
		var one int
		err := tx.QueryRowContext(ctx, query.sql, query.args...).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return later.ErrNotFound
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func scanLater(row *sql.Row) (later.Entry, error) {
	var e later.Entry
	var due sql.NullTime
	err := row.Scan(&e.ID, &e.UserID, &e.MessageID, &due, &e.State, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return later.Entry{}, err
	}
	e.CreatedAt = e.CreatedAt.UTC()
	e.UpdatedAt = e.UpdatedAt.UTC()
	if due.Valid {
		utc := due.Time.UTC()
		e.DueAt = &utc
	}
	return e, nil
}

func (r *LaterRepository) Save(ctx context.Context, in later.SaveInput) (later.Entry, bool, error) {
	ids, err := later.NormalizeIDs(in.UserID, in.ChatID, in.MessageID)
	if err != nil {
		return later.Entry{}, false, err
	}
	in.UserID, in.ChatID, in.MessageID = ids[0], ids[1], ids[2]
	in.DueAt, err = later.DueTime(in.DueAt)
	if err != nil {
		return later.Entry{}, false, err
	}
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return later.Entry{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err = lockLaterSource(ctx, tx, in.UserID, in.ChatID, in.MessageID); err != nil {
		return later.Entry{}, false, err
	}
	// Compare a fresh server candidate with the returned primary key, rather than
	// exposing MVCC system columns (xmax) or doing a racy existence pre-check.
	var candidate string
	if err = tx.QueryRowContext(ctx, `SELECT gen_random_uuid()`).Scan(&candidate); err != nil {
		return later.Entry{}, false, err
	}
	e, err := scanLater(tx.QueryRowContext(ctx, `INSERT INTO history.later_entries(id,user_id,message_id,due_at)
 VALUES($1,$2,$3,$4)
 ON CONFLICT (user_id,message_id) WHERE state='active'
 DO UPDATE SET due_at=EXCLUDED.due_at,updated_at=clock_timestamp()
 RETURNING id,user_id,message_id,due_at,state,created_at,updated_at`, candidate, in.UserID, in.MessageID, in.DueAt))
	if err != nil {
		return later.Entry{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return later.Entry{}, false, err
	}
	return e, e.ID == candidate, nil
}

func (r *LaterRepository) Complete(ctx context.Context, user, id string) error {
	ids, err := later.NormalizeIDs(user, id)
	if err != nil {
		return err
	}
	user, id = ids[0], ids[1]
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Discover the source without locking the entry first: source locks always
	// precede the entry lock, matching Save and avoiding inverse lock order.
	var chat, message string
	err = tx.QueryRowContext(ctx, `SELECT m.chat_id,e.message_id FROM history.later_entries e JOIN history.messages m ON m.id=e.message_id WHERE e.id=$1 AND e.user_id=$2`, id, user).Scan(&chat, &message)
	if errors.Is(err, sql.ErrNoRows) {
		return later.ErrNotFound
	}
	if err != nil {
		return err
	}
	if err = lockLaterSource(ctx, tx, user, chat, message); err != nil {
		return err
	}
	var state string
	err = tx.QueryRowContext(ctx, `SELECT state FROM history.later_entries WHERE id=$1 AND user_id=$2 AND message_id=$3 FOR UPDATE`, id, user, message).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return later.ErrNotFound
	}
	if err != nil {
		return err
	}
	if state == "active" {
		_, err = tx.ExecContext(ctx, `UPDATE history.later_entries SET state='done',updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2`, id, user)
		if err != nil {
			return err
		}
	}
	// Repeating an old done ID cannot complete a later active entry of the same message.
	return tx.Commit()
}

// Ready validates storage requirements without adding Later to the running
// service's readiness before the #87 endpoints are implemented.
func (r *LaterRepository) Ready(ctx context.Context) error {
	rows, err := r.DB.QueryContext(ctx, `SELECT id,user_id,message_id,due_at,state,created_at,updated_at FROM history.later_entries LIMIT 0`)
	if err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	var allowed bool
	err = r.DB.QueryRowContext(ctx, `SELECT
 has_table_privilege('history.later_entries','SELECT') AND
 has_table_privilege('history.later_entries','INSERT') AND
 has_column_privilege('history.later_entries','due_at','UPDATE') AND
 has_column_privilege('history.later_entries','state','UPDATE') AND
 has_column_privilege('history.later_entries','updated_at','UPDATE') AND
 (SELECT bool_and(has_table_privilege(t,'SELECT') AND has_any_column_privilege(t,'UPDATE'))
 FROM unnest(ARRAY['history.chats','history.chat_members','history.messages']) t)`).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.New("later storage privileges unavailable")
	}
	return nil
}
