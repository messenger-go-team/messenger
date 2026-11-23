package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func (r *Repository) Receipts(ctx context.Context, chat, user string) ([]reading.MemberReceipt, error) {
	// Authorization, type and both participants' public values share one MVCC snapshot.
	rows, err := r.DB.QueryContext(ctx, `
		SELECT c.type, mine.user_id IS NOT NULL, m.user_id,
		       m.public_last_delivered_seq, m.public_last_read_seq
		FROM history.chats c
		LEFT JOIN history.chat_members mine ON mine.chat_id=c.id AND mine.user_id=$2
		LEFT JOIN history.chat_members m ON m.chat_id=c.id AND mine.user_id IS NOT NULL AND c.type='personal'
		WHERE c.id=$1 ORDER BY m.user_id LIMIT 3`, chat, user)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	members := make([]reading.MemberReceipt, 0, 2)
	for rows.Next() {
		var kind string
		var allowed bool
		var id sql.NullString
		var delivered, read sql.NullInt64
		if err := rows.Scan(&kind, &allowed, &id, &delivered, &read); err != nil {
			return nil, err
		}
		if !allowed {
			return nil, chats.ErrForbidden
		}
		if kind != "personal" {
			return nil, reading.ErrReceiptChatType
		}
		members = append(members, reading.MemberReceipt{
			UserID:        id.String,
			PublicCursors: reading.PublicCursors{Delivered: delivered.Int64, Read: read.Int64},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, chats.ErrNotFound
	}
	if len(members) != 2 {
		return nil, chats.ErrUnavailable
	}
	return members, nil
}

func (r *Repository) AdvanceReceipt(ctx context.Context, chat, actor string, seq int64, markRead bool) (reading.PublicCursors, bool, error) {
	var cursors reading.PublicCursors
	// Reject outsiders before waiting on a write in another user's chat.
	member, err := r.Membership(ctx, chat, actor)
	if err != nil {
		return cursors, false, err
	}
	if !member {
		return cursors, false, chats.ErrForbidden
	}
	tx, err := r.DB.BeginTx(ctx, nil)
	if err != nil {
		return cursors, false, err
	}
	defer func() { _ = tx.Rollback() }()

	// SaveMessage and REST read acquire the chat lock before membership locks.
	var kind string
	var last int64
	err = tx.QueryRowContext(ctx, `SELECT type,last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, chat).Scan(&kind, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return cursors, false, chats.ErrNotFound
	}
	if err != nil {
		return cursors, false, err
	}
	var oldDelivered int64
	err = tx.QueryRowContext(ctx, `SELECT public_last_delivered_seq FROM history.chat_members
		WHERE chat_id=$1 AND user_id=$2 FOR UPDATE`, chat, actor).Scan(&oldDelivered)
	if errors.Is(err, sql.ErrNoRows) {
		return cursors, false, chats.ErrForbidden
	}
	if err != nil {
		return cursors, false, err
	}
	if kind != "personal" {
		return cursors, false, reading.ErrReceiptChatType
	}
	if seq < 0 || seq > last || seq > messages.MaxSeq {
		return cursors, false, reading.ErrReceiptSeq
	}

	update := `UPDATE history.chat_members SET public_last_delivered_seq=GREATEST(public_last_delivered_seq,$3)
		WHERE chat_id=$1 AND user_id=$2 RETURNING public_last_delivered_seq,public_last_read_seq`
	if markRead {
		update = `UPDATE history.chat_members SET
			public_last_delivered_seq=GREATEST(public_last_delivered_seq,$3),
			public_last_read_seq=GREATEST(public_last_read_seq,$3),
			last_read_seq=GREATEST(last_read_seq,$3),
			last_delivered_seq=GREATEST(last_delivered_seq,last_read_seq,$3)
			WHERE chat_id=$1 AND user_id=$2 RETURNING public_last_delivered_seq,public_last_read_seq`
	}
	err = tx.QueryRowContext(ctx, update, chat, actor, seq).Scan(&cursors.Delivered, &cursors.Read)
	if err != nil {
		return reading.PublicCursors{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return reading.PublicCursors{}, false, err
	}
	return cursors, cursors.Delivered > oldDelivered, nil
}

func (r *Repository) ReceiptsReady(ctx context.Context) error {
	var allowed bool
	err := r.DB.QueryRowContext(ctx, `SELECT
		has_column_privilege('history.chat_members','public_last_delivered_seq','UPDATE') AND
		has_column_privilege('history.chat_members','public_last_read_seq','UPDATE')`).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return chats.ErrUnavailable
	}
	return nil
}
