package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	typingTTL    = 5 * time.Second
	typingMinGap = 2 * time.Second
)

type typingTracker struct {
	mu     sync.Mutex
	byUser map[string]map[string]*typingGroup
}

type typingGroup struct {
	peerID   string
	tabs     map[*socketSession]typingTab
	deadline time.Time
	timer    *time.Timer
}

type typingTab struct {
	expiresAt  time.Time
	nextTrueAt time.Time
}

type wsTypingPayload struct {
	ChatID    string    `json:"chat_id"`
	UserID    string    `json:"user_id"`
	IsTyping  bool      `json:"is_typing"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (ws *wsEndpoint) handleTyping(ctx context.Context, socket *socketSession, cmd wsCommand, receivedAt time.Time) {
	if cmd.isTyping &&
		(!time.Now().Before(receivedAt.Add(typingTTL)) || ws.typingLimited(socket, cmd.chatID, receivedAt)) {
		return
	}

	rpcCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	members, err := ws.history.GetChatMembers(rpcCtx, &historyv1.GetChatMembersRequest{
		ChatId:      cmd.chatID,
		RequesterId: socket.userID,
	})
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		ws.replyWSError(socket, cmd, typingMembershipError(status.Code(err)))
		return
	}

	ids := members.GetUserIds()
	if len(ids) != 2 || ids[0] == ids[1] || !validWSUUID(ids[0]) || !validWSUUID(ids[1]) {
		ws.replyWSError(socket, cmd, "forbidden")
		return
	}
	var peerID string
	switch socket.userID {
	case ids[0]:
		peerID = ids[1]
	case ids[1]:
		peerID = ids[0]
	default:
		ws.replyWSError(socket, cmd, "forbidden")
		return
	}
	ws.applyTyping(socket, cmd, peerID, receivedAt)
}

func typingMembershipError(code codes.Code) string {
	switch code {
	case codes.PermissionDenied, codes.NotFound:
		return "forbidden"
	case codes.Canceled, codes.DeadlineExceeded, codes.Unavailable:
		return "temporarily_unavailable"
	default:
		return "internal_error"
	}
}

func (ws *wsEndpoint) typingLimited(socket *socketSession, chatID string, receivedAt time.Time) bool {
	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()

	group := ws.typing.byUser[socket.userID][chatID]
	return group != nil && receivedAt.Before(group.tabs[socket].nextTrueAt)
}

func (ws *wsEndpoint) applyTyping(socket *socketSession, cmd wsCommand, peerID string, receivedAt time.Time) {
	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()

	now := time.Now()
	if !now.Before(socket.expiresAt) {
		return
	}
	chats := ws.typing.byUser[socket.userID]
	group := chats[cmd.chatID]
	if cmd.isTyping {
		expiresAt := receivedAt.Add(typingTTL)
		if !now.Before(expiresAt) {
			return
		}
		if group == nil {
			if chats == nil {
				chats = make(map[string]*typingGroup)
				ws.typing.byUser[socket.userID] = chats
			}
			group = &typingGroup{tabs: make(map[*socketSession]typingTab)}
			chats[cmd.chatID] = group
		}
		group.tabs[socket] = typingTab{
			expiresAt:  expiresAt,
			nextTrueAt: receivedAt.Add(typingMinGap),
		}
	} else {
		if group == nil {
			return
		}
		tab, exists := group.tabs[socket]
		if !exists {
			return
		}
		tab.expiresAt = time.Time{}
		group.tabs[socket] = tab
	}
	group.peerID = peerID
	ws.refreshTypingLocked(socket.userID, cmd.chatID, group, now)
}

// refreshTypingLocked reconciles the aggregate and schedules the next cleanup.
func (ws *wsEndpoint) refreshTypingLocked(userID, chatID string, group *typingGroup, now time.Time) {
	var deadline, wakeAt time.Time
	for socket, tab := range group.tabs {
		// A queued frame received during cooldown can still be within its TTL.
		discardAt := tab.nextTrueAt.Add(typingTTL)
		if now.Before(tab.expiresAt) {
			if deadline.Before(tab.expiresAt) {
				deadline = tab.expiresAt
			}
		} else if !now.Before(discardAt) {
			delete(group.tabs, socket)
			continue
		}
		if wakeAt.Before(discardAt) {
			wakeAt = discardAt
		}
	}

	if !deadline.Equal(group.deadline) {
		group.deadline = deadline
		ws.publishTypingLocked(userID, chatID, group, now)
	}
	if group.timer != nil {
		group.timer.Stop()
	}
	if len(group.tabs) == 0 {
		chats := ws.typing.byUser[userID]
		delete(chats, chatID)
		if len(chats) == 0 {
			delete(ws.typing.byUser, userID)
		}
		return
	}

	if !deadline.IsZero() {
		wakeAt = deadline
	}
	group.timer = time.AfterFunc(time.Until(wakeAt), func() {
		ws.typing.mu.Lock()
		defer ws.typing.mu.Unlock()
		if ws.typing.byUser[userID][chatID] == group {
			ws.refreshTypingLocked(userID, chatID, group, time.Now())
		}
	})
}

// publishTypingLocked serializes updates before the in-process broker queues them.
func (ws *wsEndpoint) publishTypingLocked(userID, chatID string, group *typingGroup, now time.Time) {
	payload := wsTypingPayload{
		ChatID:    chatID,
		UserID:    userID,
		IsTyping:  !group.deadline.IsZero(),
		ExpiresAt: group.deadline.UTC(),
	}
	if !payload.IsTyping {
		payload.ExpiresAt = now.UTC()
	}
	event := wsEnvelope{
		Type:    wsTypingType,
		ID:      newWSEventID(),
		TS:      now.UTC(),
		Payload: payload,
	}
	data, err := json.Marshal(event)
	if err != nil {
		ws.logger.Warn("could not encode typing event")
		return
	}
	if err := ws.broker.Publish(ws.fanoutCtx, []string{group.peerID}, data); err != nil && ws.fanoutCtx.Err() == nil {
		ws.logger.Warn("typing fanout failed")
	}
}

func (ws *wsEndpoint) clearSocketTyping(socket *socketSession) {
	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()

	now := time.Now()
	for chatID, group := range ws.typing.byUser[socket.userID] {
		if _, exists := group.tabs[socket]; !exists {
			continue
		}
		delete(group.tabs, socket)
		ws.refreshTypingLocked(socket.userID, chatID, group, now)
	}
}
