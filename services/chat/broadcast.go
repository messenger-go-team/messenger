package main

import (
	"context"
	"fmt"
	"strings"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

// broadcastChat is called by server-side event handlers with the verified JWT identity.
// History checks that identity's membership and returns the current recipients.
func (ws *wsEndpoint) broadcastChat(ctx context.Context, requester jwtauth.Identity, chatID string, event []byte) error {
	fanoutCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	defer cancel()
	members, err := ws.history.GetChatMembers(fanoutCtx, &historyv1.GetChatMembersRequest{
		ChatId: strings.ToLower(chatID), RequesterId: requester.UserID,
	})
	if err != nil {
		return fmt.Errorf("get chat members: %w", err)
	}
	return ws.broker.Publish(fanoutCtx, members.GetUserIds(), event)
}
