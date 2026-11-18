package postgres

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	"github.com/lib/pq"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func (r *Repository) List(ctx context.Context, user string) ([]reading.ChatItem, error) {
	// One statement supplies membership, the latest seq, and the unread count
	// from the same snapshot. No last_seq-last_read_seq arithmetic: gaps and
	// the viewer's own messages are not unread messages.
	rows, err := r.DB.QueryContext(ctx, `SELECT c.id,c.type,c.created_at,
  ARRAY(SELECT m.user_id::text FROM history.chat_members m WHERE m.chat_id=c.id ORDER BY m.user_id),
  last.id,last.chat_id,last.seq,last.sender_id,last.body,last.created_at,
  (SELECT count(*) FROM history.messages x WHERE x.chat_id=c.id AND x.seq>mine.last_read_seq AND x.sender_id<>$1)
 FROM history.chat_members mine JOIN history.chats c ON c.id=mine.chat_id
 LEFT JOIN LATERAL (SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE chat_id=c.id ORDER BY seq DESC LIMIT 1) last ON true
 WHERE mine.user_id=$1 ORDER BY last.created_at DESC NULLS LAST,c.id ASC`, user)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []reading.ChatItem{}
	for rows.Next() {
		var item reading.ChatItem
		var ids pq.StringArray
		var id, chat, sender, body sql.NullString
		var seq sql.NullInt64
		var created sql.NullTime
		if err = rows.Scan(&item.ID, &item.Type, &item.CreatedAt, &ids, &id, &chat, &seq, &sender, &body, &created, &item.Unread); err != nil {
			return nil, err
		}
		if item.Type != "personal" || len(ids) != 2 || !slices.Contains(ids, user) {
			return nil, chats.ErrUnavailable
		}
		item.CreatedAt = item.CreatedAt.UTC()
		item.Members = make([]chats.User, len(ids))
		for i, id := range ids {
			item.Members[i] = chats.User{ID: id}
		}
		if id.Valid {
			item.LastMessage = &reading.Message{ID: id.String, ChatID: chat.String, Seq: seq.Int64, SenderID: sender.String, Body: body.String, CreatedAt: created.Time.UTC()}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) History(ctx context.Context, chat, user string, q reading.Query) (reading.Page, error) {
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return reading.Page{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var exists, member bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM history.chats WHERE id=$1),EXISTS(SELECT 1 FROM history.chat_members WHERE chat_id=$1 AND user_id=$2)`, chat, user).Scan(&exists, &member)
	if err != nil {
		return reading.Page{}, err
	}
	if !exists {
		return reading.Page{}, chats.ErrNotFound
	}
	if !member {
		return reading.Page{}, chats.ErrForbidden
	}
	cursor := messages.MaxSeq + 1 // MaxSeq+1 includes the last permissible seq.
	if q.Before != nil {
		cursor = *q.Before
	}
	if q.After != nil {
		cursor = *q.After
	}
	items, err := readMessagePage(ctx, tx, chat, cursor, q.Limit, q.After != nil)
	if err != nil {
		return reading.Page{}, err
	}
	page := reading.Page{Messages: items}
	if q.After == nil {
		slices.Reverse(page.Messages)
	}
	if len(page.Messages) > 0 {
		first, last := page.Messages[0].Seq, page.Messages[len(page.Messages)-1].Seq
		page.Before, page.After = &first, &last
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM history.messages WHERE chat_id=$1 AND seq<$2),EXISTS(SELECT 1 FROM history.messages WHERE chat_id=$1 AND seq>$3)`, chat, first, last).Scan(&page.MoreBefore, &page.MoreAfter)
		if err != nil {
			return reading.Page{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return reading.Page{}, err
	}
	return page, nil
}

// readMessagePage returns neighbors nearest to the cursor first in the chosen direction.
func readMessagePage(ctx context.Context, tx *sql.Tx, chat string, cursor int64, limit int, after bool) ([]reading.Message, error) {
	query := `SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE chat_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3`
	if after {
		query = `SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE chat_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3`
	}
	rows, err := tx.QueryContext(ctx, query, chat, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []reading.Message{}
	for rows.Next() {
		item, err := scanHistoryMessage(rows.Scan)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanHistoryMessage(scan func(...any) error) (reading.Message, error) {
	var item reading.Message
	err := scan(&item.ID, &item.ChatID, &item.Seq, &item.SenderID, &item.Body, &item.CreatedAt)
	item.CreatedAt = item.CreatedAt.UTC()
	return item, err
}

func (r *Repository) MarkRead(ctx context.Context, chat, user string, seq int64) error {
	// Reject non-members without waiting behind a writer to someone else's chat.
	// This snapshot is only a fast rejection; access is rechecked under lock below.
	member, err := r.Membership(ctx, chat, user)
	if err != nil {
		return err
	}
	if !member {
		return chats.ErrForbidden
	}
	tx, err := r.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Match SaveMessage's lock order: chat first, then the current membership.
	var last int64
	err = tx.QueryRowContext(ctx, `SELECT last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, chat).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return chats.ErrNotFound
	}
	if err != nil {
		return err
	}
	var membership int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM history.chat_members WHERE chat_id=$1 AND user_id=$2 FOR UPDATE`, chat, user).Scan(&membership)
	if errors.Is(err, sql.ErrNoRows) {
		return chats.ErrForbidden
	}
	if err != nil {
		return err
	}
	if seq > last {
		return chats.ErrInvalid
	}
	// Reading confirms delivery too, preserving the schema's read<=delivered
	// invariant without publishing the future phase-2 message.read event.
	_, err = tx.ExecContext(ctx, `UPDATE history.chat_members SET last_read_seq=GREATEST(last_read_seq,$3),last_delivered_seq=GREATEST(last_delivered_seq,$3) WHERE chat_id=$1 AND user_id=$2`, chat, user, seq)
	if err != nil {
		return err
	}
	return tx.Commit()
}
