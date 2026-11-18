package reading

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

func TestMessageContextValidationBeforeStorage(t *testing.T) {
	const targetID = "cc6ac191-7856-4a41-8a1f-59c49af76ec0"
	for _, tc := range []struct {
		chat, user, target string
		limit              int
		want               error
	}{
		{"bad", "bad", "bad", 0, chats.ErrIdentity},
		{"bad", readerID, targetID, 1, chats.ErrInvalid},
		{chatID, readerID, "bad", 1, chats.ErrInvalid},
		{chatID, readerID, targetID, 0, chats.ErrInvalid},
		{chatID, readerID, targetID, 101, chats.ErrInvalid},
	} {
		if _, err := (&Service{}).MessageContext(t.Context(), tc.chat, tc.user, tc.target, tc.limit); !errors.Is(err, tc.want) {
			t.Fatalf("%+v: got %v, want %v", tc, err, tc.want)
		}
	}

	ctx := t.Context()
	repo := repositoryFuncs{window: func(gotCtx context.Context, chat, user, target string, limit int) (MessageContext, error) {
		if gotCtx != ctx || chat != chatID || user != readerID || target != targetID || limit != 100 {
			t.Fatalf("unexpected arguments: %q %q %q %d", chat, user, target, limit)
		}
		return MessageContext{}, ErrMessageNotFound
	}}
	service := &Service{Repo: repo}
	_, err := service.MessageContext(ctx, strings.ToUpper(chatID), strings.ToUpper(readerID), strings.ToUpper(targetID), 100)
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("lost repository error: %v", err)
	}
}
