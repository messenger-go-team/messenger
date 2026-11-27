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
	members, err := ws.chatMembers(fanoutCtx, chatID, requester.UserID)
	if err != nil {
		return err
	}
	return ws.broker.Publish(fanoutCtx, members, event)
}

func (ws *wsEndpoint) chatMembers(ctx context.Context, chatID, requesterID string) ([]string, error) {
	members, err := ws.history.GetChatMembers(ctx, &historyv1.GetChatMembersRequest{
		ChatId: strings.ToLower(chatID), RequesterId: requesterID,
	})
	if err != nil {
		return nil, fmt.Errorf("get chat members: %w", err)
	}
	return members.GetUserIds(), nil
}
