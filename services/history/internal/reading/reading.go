// Package reading implements REST history and the private MVP read cursor.
package reading

import (
	"context"
	"errors"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
)

type Message struct {
	ID        string    `json:"id"`
	ChatID    string    `json:"chat_id"`
	Seq       int64     `json:"seq"`
	SenderID  string    `json:"sender_id"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}
type Page struct {
	Messages   []Message `json:"messages"`
	Before     *int64    `json:"next_before_seq"`
	After      *int64    `json:"next_after_seq"`
	MoreBefore bool      `json:"has_more_before"`
	MoreAfter  bool      `json:"has_more_after"`
}

var ErrMessageNotFound = errors.New("message not found or inaccessible")

type MessageContext struct {
	TargetMessageID string    `json:"target_message_id"`
	Messages        []Message `json:"messages"`
	Before          int64     `json:"next_before_seq"`
	After           int64     `json:"next_after_seq"`
	MoreBefore      bool      `json:"has_more_before"`
	MoreAfter       bool      `json:"has_more_after"`
}

type Query struct {
	Before, After *int64
	Limit         int
}

func (q Query) Validate() error {
	if q.Limit < 1 || q.Limit > 100 || (q.Before != nil && q.After != nil) {
		return chats.ErrInvalid
	}
	if q.Before != nil && (*q.Before < 1 || *q.Before > messages.MaxSeq) {
		return chats.ErrInvalid
	}
	if q.After != nil && (*q.After < 0 || *q.After > messages.MaxSeq) {
		return chats.ErrInvalid
	}
	return nil
}

type ChatItem struct {
	ID          string       `json:"id"`
	Type        string       `json:"type"`
	CreatedAt   time.Time    `json:"created_at"`
	Members     []chats.User `json:"members"`
	LastMessage *Message     `json:"last_message"`
	Unread      int64        `json:"unread_count"`
}
type Repository interface {
	List(context.Context, string) ([]ChatItem, error)
	History(context.Context, string, string, Query) (Page, error)
	MessageContext(ctx context.Context, chat, user, target string, limit int) (MessageContext, error)
	MarkRead(context.Context, string, string, int64) error
}
type Service struct {
	Repo  Repository
	Users chats.Users
}

func identity(id string) (string, error) {
	id, err := chats.NormalizeID(id)
	if err != nil {
		return "", chats.ErrIdentity
	}
	return id, nil
}
func (s *Service) List(ctx context.Context, user string) ([]ChatItem, error) {
	user, err := identity(user)
	if err != nil {
		return nil, err
	}
	items, err := s.Repo.List(ctx, user)
	if err != nil {
		return nil, err
	}
	// Cache public summaries only for this request; membership is never cached.
	users := map[string]chats.User{}
	for i := range items {
		for j, member := range items[i].Members {
			u, ok := users[member.ID]
			if !ok {
				u, err = s.Users.Lookup(ctx, member.ID)
				if err != nil {
					return nil, chats.ErrUnavailable
				}
				users[member.ID] = u
			}
			items[i].Members[j] = u
		}
	}
	return items, nil
}
func (s *Service) History(ctx context.Context, chat, user string, q Query) (Page, error) {
	user, err := identity(user)
	if err != nil {
		return Page{}, err
	}
	chat, err = chats.NormalizeID(chat)
	if err != nil {
		return Page{}, err
	}
	if err = q.Validate(); err != nil {
		return Page{}, err
	}
	return s.Repo.History(ctx, chat, user, q)
}
func (s *Service) MessageContext(ctx context.Context, chat, user, target string, limit int) (MessageContext, error) {
	user, err := identity(user)
	if err != nil {
		return MessageContext{}, err
	}
	chat, err = chats.NormalizeID(chat)
	if err != nil {
		return MessageContext{}, err
	}
	target, err = chats.NormalizeID(target)
	if err != nil || limit < 1 || limit > 100 {
		return MessageContext{}, chats.ErrInvalid
	}
	return s.Repo.MessageContext(ctx, chat, user, target, limit)
}

func (s *Service) MarkRead(ctx context.Context, chat, user string, seq int64) error {
	user, err := identity(user)
	if err != nil {
		return err
	}
	chat, err = chats.NormalizeID(chat)
	if err != nil {
		return err
	}
	if seq < 0 || seq > messages.MaxSeq {
		return chats.ErrInvalid
	}
	return s.Repo.MarkRead(ctx, chat, user, seq)
}
