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
	tabs     map[*socketSession]time.Time
	deadline time.Time
	timer    *time.Timer
}

type typingRequest struct {
	cmd       wsCommand
	expiresAt time.Time
}

type wsTypingPayload struct {
	ChatID    string    `json:"chat_id"`
	UserID    string    `json:"user_id"`
	IsTyping  bool      `json:"is_typing"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (ws *wsEndpoint) queueTyping(socket *socketSession, cmd wsCommand, receivedAt time.Time, wake chan<- struct{}) {
	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()

	if !cmd.isTyping {
		if pending := socket.pendingTyping; pending != nil && pending.cmd.chatID == cmd.chatID {
			socket.pendingTyping = nil
		}
		group := ws.typing.byUser[socket.userID][cmd.chatID]
		if group != nil {
			if _, active := group.tabs[socket]; active {
				delete(group.tabs, socket)
				ws.refreshTypingLocked(socket.userID, cmd.chatID, group, time.Now())
			}
		}
		return
	}

	if receivedAt.Before(socket.nextTypingAt) {
		return
	}
	// Reserve the whole socket's budget before any lookup, even on failure.
	socket.nextTypingAt = receivedAt.Add(typingMinGap)
	socket.pendingTyping = &typingRequest{cmd: cmd, expiresAt: receivedAt.Add(typingTTL)}
	select {
	case wake <- struct{}{}:
	default:
		// The worker reads the latest pending request when it wakes up.
	}
}

func (ws *wsEndpoint) runWSTyping(ctx context.Context, socket *socketSession, wake <-chan struct{}) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ws.stopping:
			return
		case <-wake:
			select {
			case <-ws.stopping:
				return
			default:
			}
			ws.typing.mu.Lock()
			request := socket.pendingTyping
			ws.typing.mu.Unlock()
			if request != nil {
				ws.handleTyping(ctx, socket, request)
			}
		}
	}
}

func (ws *wsEndpoint) handleTyping(ctx context.Context, socket *socketSession, request *typingRequest) {
	var peerID, problem string
	if ctx.Err() == nil && typingRequestAlive(socket, request, time.Now()) {
		peerID, problem = ws.typingPeer(ctx, socket.userID, request.cmd.chatID)
	}

	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()
	if socket.pendingTyping != request {
		return
	}
	socket.pendingTyping = nil
	now := time.Now()
	if ctx.Err() != nil || !typingRequestAlive(socket, request, now) {
		return
	}
	if problem != "" {
		ws.replyWSError(socket, request.cmd, problem)
		return
	}
	ws.applyTypingLocked(socket, request.cmd.chatID, peerID, request.expiresAt, now)
}

func typingRequestAlive(socket *socketSession, request *typingRequest, now time.Time) bool {
	return now.Before(request.expiresAt) && now.Before(socket.expiresAt)
}

func (ws *wsEndpoint) typingPeer(ctx context.Context, userID, chatID string) (string, string) {
	if ws.history == nil {
		return "", "temporarily_unavailable"
	}
	rpcCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	defer cancel()
	members, err := ws.history.GetChatMembers(rpcCtx, &historyv1.GetChatMembersRequest{
		ChatId:      chatID,
		RequesterId: userID,
	})
	if err != nil {
		return "", typingMembershipError(status.Code(err))
	}
	ids := members.GetUserIds()
	if len(ids) != 2 || ids[0] == ids[1] || !validWSUUID(ids[0]) || !validWSUUID(ids[1]) {
		return "", "forbidden"
	}
	switch userID {
	case ids[0]:
		return ids[1], ""
	case ids[1]:
		return ids[0], ""
	default:
		return "", "forbidden"
	}
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

func (ws *wsEndpoint) applyTypingLocked(socket *socketSession, chatID, peerID string, expiresAt, now time.Time) {
	chats := ws.typing.byUser[socket.userID]
	if chats == nil {
		chats = make(map[string]*typingGroup)
		ws.typing.byUser[socket.userID] = chats
	}
	group := chats[chatID]
	if group == nil {
		group = &typingGroup{tabs: make(map[*socketSession]time.Time)}
		chats[chatID] = group
	}
	group.tabs[socket] = expiresAt
	group.peerID = peerID
	ws.refreshTypingLocked(socket.userID, chatID, group, now)
}

// refreshTypingLocked reconciles the aggregate and schedules the next cleanup.
func (ws *wsEndpoint) refreshTypingLocked(userID, chatID string, group *typingGroup, now time.Time) {
	var deadline time.Time
	for socket, expiresAt := range group.tabs {
		if !now.Before(expiresAt) {
			delete(group.tabs, socket)
			continue
		}
		if deadline.Before(expiresAt) {
			deadline = expiresAt
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

	group.timer = time.AfterFunc(time.Until(deadline), func() {
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

	socket.pendingTyping = nil
	now := time.Now()
	for chatID, group := range ws.typing.byUser[socket.userID] {
		if _, exists := group.tabs[socket]; !exists {
			continue
		}
		delete(group.tabs, socket)
		ws.refreshTypingLocked(socket.userID, chatID, group, now)
	}
}
