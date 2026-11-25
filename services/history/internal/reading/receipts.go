package reading

import (
	"context"
	"errors"
	"strings"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

var (
	ErrReceiptChatType = errors.New("receipts require a personal chat")
	ErrReceiptSeq      = errors.New("receipt sequence out of range")
)

type PublicCursors struct {
	Delivered int64 `json:"last_delivered_seq"`
	Read      int64 `json:"last_read_seq"`
}

type MemberReceipt struct {
	UserID string `json:"user_id"`
	PublicCursors
}

type ChatReceipts struct {
	ChatID  string          `json:"chat_id"`
	Members []MemberReceipt `json:"members"`
}

func (s *Service) Receipts(ctx context.Context, chat, user string) (ChatReceipts, error) {
	user, err := identity(user)
	if err != nil {
		return ChatReceipts{}, err
	}
	chat = strings.ToLower(chat)
	if !chats.ValidRPCID(chat) {
		return ChatReceipts{}, chats.ErrInvalid
	}
	members, err := s.Repo.Receipts(ctx, chat, user)
	if err != nil {
		return ChatReceipts{}, err
	}
	return ChatReceipts{ChatID: chat, Members: members}, nil
}
