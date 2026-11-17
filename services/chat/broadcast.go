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
	rpcCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	members, err := ws.history.GetChatMembers(rpcCtx, &historyv1.GetChatMembersRequest{
		ChatId: strings.ToLower(chatID), RequesterId: requester.UserID,
	})
	cancel()
	if err != nil {
		return fmt.Errorf("get chat members: %w", err)
	}
	return ws.broker.Publish(ctx, members.GetUserIds(), event)
}
