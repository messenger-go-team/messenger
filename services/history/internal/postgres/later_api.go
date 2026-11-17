package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

var _ later.APIRepository = (*LaterRepository)(nil)

func projectLater(ctx context.Context, tx *sql.Tx, e later.Entry) (later.Result, error) {
	var at time.Time
	var m reading.Message
	err := tx.QueryRowContext(ctx, `SELECT statement_timestamp(),id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE id=$1`, e.MessageID).Scan(&at, &m.ID, &m.ChatID, &m.Seq, &m.SenderID, &m.Body, &m.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return later.Result{}, later.ErrNotFound
	}
	if err != nil {
		return later.Result{}, err
	}
	at = at.UTC()
	m.CreatedAt = m.CreatedAt.UTC()
	return later.Result{ServerTime: at, Entry: later.Project(e, m, at)}, nil
}

func (r *LaterRepository) SaveRecord(ctx context.Context, in later.SaveInput) (later.Result, bool, error) {
	var result later.Result
	_, created, err := r.save(ctx, in, func(tx *sql.Tx, e later.Entry) error {
		var err error
		result, err = projectLater(ctx, tx, e)
		return err
	})
	// Even a successful RETURNING/projection is not success before commit.
	if err != nil {
		return later.Result{}, false, err
	}
	return result, created, nil
}

func (r *LaterRepository) Reschedule(ctx context.Context, user, id string, due *time.Time) (later.Result, error) {
	ids, err := later.NormalizeIDs(user, id)
	if err != nil {
		return later.Result{}, err
	}
	user, id = ids[0], ids[1]
	due, err = later.DueTime(due)
	if err != nil {
		return later.Result{}, err
	}
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return later.Result{}, err
	}
	defer func() { _ = tx.Rollback() }()
	// Discover without entry-lock, preserving source -> entry order from #86.
	var chat, message string
	err = tx.QueryRowContext(ctx, `SELECT m.chat_id,e.message_id FROM history.later_entries e JOIN history.messages m ON m.id=e.message_id WHERE e.id=$1 AND e.user_id=$2 AND e.state='active'`, id, user).Scan(&chat, &message)
	if errors.Is(err, sql.ErrNoRows) {
		return later.Result{}, later.ErrNotFound
	}
	if err != nil {
		return later.Result{}, err
	}
	if err = lockLaterSource(ctx, tx, user, chat, message); err != nil {
		return later.Result{}, err
	}
	// WHERE state is re-evaluated after a concurrent Complete releases the row.
	e, err := scanLater(tx.QueryRowContext(ctx, `UPDATE history.later_entries SET due_at=$3,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND state='active' RETURNING id,user_id,message_id,due_at,state,created_at,updated_at`, id, user, due))
	if errors.Is(err, sql.ErrNoRows) {
		return later.Result{}, later.ErrNotFound
	}
	if err != nil {
		return later.Result{}, err
	}
	result, err := projectLater(ctx, tx, e)
	if err != nil {
		return later.Result{}, err
	}
	if err = tx.Commit(); err != nil {
		return later.Result{}, err
	}
	return result, nil
}

func (r *LaterRepository) ListRecords(ctx context.Context, user string) (later.List, error) {
	ids, err := later.NormalizeIDs(user)
	if err != nil {
		return later.List{}, err
	}
	// Timestamp, membership and messages share one repeatable-read snapshot.
	// An empty list still returns database time; dependency failures stay errors.
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return later.List{}, err
	}
	defer func() { _ = tx.Rollback() }()
	out := later.List{Entries: []later.Record{}}
	if err = tx.QueryRowContext(ctx, `SELECT statement_timestamp()`).Scan(&out.ServerTime); err != nil {
		return later.List{}, err
	}
	out.ServerTime = out.ServerTime.UTC()
	rows, err := tx.QueryContext(ctx, `SELECT e.id,e.due_at,e.created_at,e.updated_at,m.id,m.chat_id,m.seq,m.sender_id,m.body,m.created_at
 FROM history.later_entries e
 JOIN history.messages m ON m.id=e.message_id
 JOIN history.chats c ON c.id=m.chat_id
 JOIN history.chat_members cm ON cm.chat_id=c.id AND cm.user_id=e.user_id
 WHERE e.user_id=$1 AND e.state='active'
 ORDER BY CASE WHEN e.due_at IS NULL THEN 2 WHEN e.due_at<=$2 THEN 0 ELSE 1 END,
 e.due_at ASC NULLS LAST,e.created_at ASC,e.id ASC`, ids[0], out.ServerTime)
	if err != nil {
		return later.List{}, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var e later.Entry
		var m reading.Message
		var due sql.NullTime
		if err = rows.Scan(&e.ID, &due, &e.CreatedAt, &e.UpdatedAt, &m.ID, &m.ChatID, &m.Seq, &m.SenderID, &m.Body, &m.CreatedAt); err != nil {
			return later.List{}, err
		}
		e.CreatedAt = e.CreatedAt.UTC()
		e.UpdatedAt = e.UpdatedAt.UTC()
		m.CreatedAt = m.CreatedAt.UTC()
		if due.Valid {
			at := due.Time.UTC()
			e.DueAt = &at
		}
		out.Entries = append(out.Entries, later.Project(e, m, out.ServerTime))
	}
	if err = rows.Err(); err != nil {
		return later.List{}, err
	}
	if err = rows.Close(); err != nil {
		return later.List{}, err
	}
	if err = tx.Commit(); err != nil {
		return later.List{}, err
	}
	return out, nil
}
