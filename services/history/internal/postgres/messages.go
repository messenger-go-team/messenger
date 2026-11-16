package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/messenger-go-team/messenger/services/history/internal/messages"
)

func (r *Repository) Save(ctx context.Context, in messages.Input) (messages.Saved, error) {
	tx, err := r.DB.BeginTx(ctx, nil)
	if err != nil {
		return messages.Saved{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var last int64
	err = tx.QueryRowContext(ctx, `SELECT last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, in.ChatID).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return messages.Saved{}, messages.ErrChatNotFound
	}
	if err != nil {
		return messages.Saved{}, err
	}
	// Keep the sender's membership stable until commit, including duplicates.
	var member int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM history.chat_members WHERE chat_id=$1 AND user_id=$2 FOR KEY SHARE`, in.ChatID, in.SenderID).Scan(&member)
	if errors.Is(err, sql.ErrNoRows) {
		return messages.Saved{}, messages.ErrNotMember
	}
	if err != nil {
		return messages.Saved{}, err
	}
	var saved messages.Saved
	var body string
	err = tx.QueryRowContext(ctx, `SELECT id,seq,created_at,body FROM history.messages WHERE chat_id=$1 AND sender_id=$2 AND client_msg_id=$3`, in.ChatID, in.SenderID, in.ClientID).Scan(&saved.ID, &saved.Seq, &saved.CreatedAt, &body)
	if err == nil {
		if body != in.Body {
			return messages.Saved{}, messages.ErrConflict
		}
		saved.Duplicate = true
	} else {
		if !errors.Is(err, sql.ErrNoRows) {
			return messages.Saved{}, err
		}
		if last >= messages.MaxSeq {
			return messages.Saved{}, messages.ErrSeqExhausted
		}
		err = tx.QueryRowContext(ctx, `UPDATE history.chats SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq`, in.ChatID).Scan(&saved.Seq)
		if err != nil {
			return messages.Saved{}, err
		}
		err = tx.QueryRowContext(ctx, `INSERT INTO history.messages(chat_id,seq,sender_id,client_msg_id,body,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING id,created_at`, in.ChatID, saved.Seq, in.SenderID, in.ClientID, in.Body).Scan(&saved.ID, &saved.CreatedAt)
		if err != nil {
			return messages.Saved{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return messages.Saved{}, err
	}
	saved.CreatedAt = saved.CreatedAt.UTC()
	return saved, nil
}
