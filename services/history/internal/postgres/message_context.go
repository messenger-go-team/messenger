package postgres

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func (r *Repository) MessageContext(ctx context.Context, chat, user, target string, limit int) (reading.MessageContext, error) {
	// Authorization, the target and both sides of the window share a read-only snapshot.
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return reading.MessageContext{}, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `SELECT m.id,m.chat_id,m.seq,m.sender_id,m.body,m.created_at
 FROM history.messages m JOIN history.chat_members member ON member.chat_id=m.chat_id
 WHERE m.chat_id=$1 AND member.user_id=$2 AND m.id=$3`, chat, user, target)
	message, err := scanHistoryMessage(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return reading.MessageContext{}, reading.ErrMessageNotFound
	}
	if err != nil {
		return reading.MessageContext{}, err
	}

	// Each side fetches one extra row to detect a continuation across gaps in seq.
	beforeLimit := (limit - 1) / 2
	afterLimit := limit - 1 - beforeLimit
	before, err := readMessagePage(ctx, tx, chat, message.Seq, beforeLimit+1, false)
	if err != nil {
		return reading.MessageContext{}, err
	}
	after, err := readMessagePage(ctx, tx, chat, message.Seq, afterLimit+1, true)
	if err != nil {
		return reading.MessageContext{}, err
	}
	moreBefore, moreAfter := len(before) > beforeLimit, len(after) > afterLimit
	before = before[:min(len(before), beforeLimit)]
	after = after[:min(len(after), afterLimit)]
	slices.Reverse(before)

	window := make([]reading.Message, 0, len(before)+1+len(after))
	window = append(window, before...)
	window = append(window, message)
	window = append(window, after...)
	if err = tx.Commit(); err != nil {
		return reading.MessageContext{}, err
	}
	return reading.MessageContext{
		TargetMessageID: message.ID,
		Messages:        window,
		Before:          window[0].Seq,
		After:           window[len(window)-1].Seq,
		MoreBefore:      moreBefore,
		MoreAfter:       moreAfter,
	}, nil
}
