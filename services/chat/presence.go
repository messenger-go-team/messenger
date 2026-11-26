package main

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
)

const (
	defaultPresenceRefresh = 5 * time.Second
	presenceRetention      = 24 * time.Hour
	presenceSweepInterval  = time.Minute
)

type presenceActivity struct {
	lastSeen time.Time
	version  uint64
}

type presenceView struct {
	online   bool
	lastSeen time.Time
}

type presenceSnapshot struct {
	view     presenceView
	version  uint64
	deadline time.Time
}

type wsPresencePayload struct {
	UserID     string     `json:"user_id"`
	Status     string     `json:"status"`
	LastSeenAt *time.Time `json:"last_seen_at"`
}

func (ws *wsEndpoint) refreshPresence(user *hubUser) bool {
	peers, version, ok := ws.discoverPresence(user)
	if !ok {
		ws.hub.dropPendingPresence(user)
		return false
	}

	candidates := ws.hub.preparePresence(user, peers, version)
	for ids := range slices.Chunk(slices.Sorted(maps.Keys(candidates)), presenceBatchSize) {
		allowed, deadline, ok := ws.authorizePresence(user, ids)
		if !ok {
			ws.hub.dropPendingPresence(user)
			return false
		}
		ws.hub.queuePresence(user, version, candidates, ids, allowed, deadline)
	}
	return true
}

func (ws *wsEndpoint) discoverPresence(user *hubUser) (map[string]struct{}, uint64, bool) {
	if !ws.presenceRPC.enter(user.ctx) {
		return nil, 0, false
	}
	defer ws.presenceRPC.leave()

	ws.hub.mu.Lock()
	version := ws.hub.presenceVersion
	ws.hub.mu.Unlock()

	ctx, cancel := context.WithTimeout(user.ctx, ws.historyTimeout)
	defer cancel()
	response, err := ws.history.ListPresencePeers(ctx, &historyv1.ListPresencePeersRequest{RequesterId: user.id})
	if err != nil || ctx.Err() != nil {
		return nil, 0, false
	}
	peers := make(map[string]struct{}, len(response.GetUserIds()))
	for _, id := range response.GetUserIds() {
		if id != user.id && validWSUUID(id) && strings.ToLower(id) == id {
			peers[id] = struct{}{}
		}
	}
	return peers, version, true
}

func (ws *wsEndpoint) authorizePresence(user *hubUser, ids []string) (map[string]struct{}, time.Time, bool) {
	if !ws.presenceRPC.enter(user.ctx) {
		return nil, time.Time{}, false
	}
	defer ws.presenceRPC.leave()

	// The write window starts before the request. Transport delay, queuing
	// at the socket, and the write itself all use the same deadline.
	deadline := time.Now().Add(min(ws.historyTimeout, presenceDeliveryWindow))
	ctx, cancel := context.WithDeadline(user.ctx, deadline)
	defer cancel()
	response, err := ws.history.AuthorizePresenceDelivery(ctx, &historyv1.AuthorizePresenceDeliveryRequest{
		RequesterId: user.id,
		UserIds:     ids,
	})
	if err != nil || ctx.Err() != nil {
		return nil, time.Time{}, false
	}
	allowed := make(map[string]struct{}, len(response.GetUserIds()))
	for _, id := range response.GetUserIds() {
		allowed[id] = struct{}{}
	}
	return allowed, deadline, true
}

func (h *connectionHub) dropPendingPresence(user *hubUser) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for socket := range user.sockets {
		socket.presencePending = nil
	}
}

func (h *connectionHub) preparePresence(user *hubUser, peers map[string]struct{}, version uint64) map[string]presenceSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[user.id] != user || user.ctx.Err() != nil {
		return nil
	}

	now := time.Now()
	h.sweepOfflineLocked(now)
	h.setPresencePeersLocked(user, peers)
	candidates := make(map[string]presenceSnapshot)
	for socket := range user.sockets {
		for id := range socket.presenceSent {
			if _, allowed := peers[id]; !allowed {
				delete(socket.presenceSent, id)
			}
		}
		for id, pending := range socket.presencePending {
			if _, allowed := peers[id]; !allowed || !now.Before(pending.deadline) {
				delete(socket.presencePending, id)
			}
		}
		if socket.presenceSince > version || !now.Before(socket.expiresAt) {
			continue
		}
		for id := range peers {
			current, changed := h.presenceOfLocked(id, now)
			if changed > version {
				user.wakePresence()
				continue
			}
			if previous, sent := socket.presenceSent[id]; sent && previous == current {
				continue
			}
			if pending, queued := socket.presencePending[id]; queued && pending.version == changed && pending.view == current {
				continue
			}
			candidates[id] = presenceSnapshot{view: current, version: changed}
		}
	}
	return candidates
}

func (h *connectionHub) queuePresence(user *hubUser, version uint64, candidates map[string]presenceSnapshot,
	ids []string, allowed map[string]struct{}, deadline time.Time,
) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[user.id] != user || user.ctx.Err() != nil {
		return
	}

	now := time.Now()
	for _, id := range ids {
		snapshot := candidates[id]
		current, changed := h.presenceOfLocked(id, now)
		_, authorized := allowed[id]
		for socket := range user.sockets {
			if !authorized {
				delete(socket.presencePending, id)
				delete(socket.presenceSent, id)
				continue
			}
			if socket.presenceSince > version || !now.Before(socket.expiresAt) || !now.Before(deadline) ||
				changed != snapshot.version || current != snapshot.view {
				continue
			}
			if previous, sent := socket.presenceSent[id]; sent && previous == snapshot.view {
				continue
			}
			if socket.presencePending == nil {
				socket.presencePending = make(map[string]presenceSnapshot)
			}
			snapshot.deadline = deadline
			socket.presencePending[id] = snapshot
			socket.wakePresenceWriter()
		}
	}
}

func (h *connectionHub) presenceOfLocked(id string, now time.Time) (presenceView, uint64) {
	if user := h.users[id]; user != nil {
		return presenceView{online: true}, user.activity.version
	}
	activity := h.offline[id]
	if now.Sub(activity.lastSeen) >= presenceRetention {
		return presenceView{}, activity.version
	}
	return presenceView{lastSeen: activity.lastSeen}, activity.version
}

func (h *connectionHub) sweepOfflineLocked(now time.Time) {
	if now.Before(h.nextSweep) {
		return
	}
	h.nextSweep = now.Add(presenceSweepInterval)
	for id, entry := range h.offline {
		if now.Sub(entry.lastSeen) >= presenceRetention {
			delete(h.offline, id)
		}
	}
}

// The reverse index only wakes workers. Every queued status needs a fresh lookup.
func (h *connectionHub) setPresencePeersLocked(user *hubUser, peers map[string]struct{}) {
	for id := range user.peers {
		if _, keep := peers[id]; !keep {
			watchers := h.watchers[id]
			delete(watchers, user)
			if len(watchers) == 0 {
				delete(h.watchers, id)
			}
		}
	}
	for id := range peers {
		if _, known := user.peers[id]; !known {
			if h.watchers[id] == nil {
				h.watchers[id] = make(map[*hubUser]struct{})
			}
			h.watchers[id][user] = struct{}{}
		}
	}
	user.peers = peers
}

func (h *connectionHub) wakeWatchersLocked(id string) {
	for user := range h.watchers[id] {
		user.wakePresence()
	}
}

func (user *hubUser) wakePresence() {
	select {
	case user.wake <- struct{}{}:
	default:
	}
}

func (socket *socketSession) wakePresenceWriter() {
	if len(socket.presencePending) > 0 {
		select {
		case socket.presenceReady <- struct{}{}:
		default:
		}
	}
}

func (h *connectionHub) popPresence(socket *socketSession) (string, presenceSnapshot) {
	h.mu.Lock()
	defer h.mu.Unlock()
	user := h.users[socket.userID]
	if user == nil || user.ctx.Err() != nil {
		return "", presenceSnapshot{}
	}
	if _, registered := user.sockets[socket]; !registered {
		return "", presenceSnapshot{}
	}
	now := time.Now()
	for id, pending := range socket.presencePending {
		delete(socket.presencePending, id)
		view, version := h.presenceOfLocked(id, now)
		if !now.Before(pending.deadline) || version != pending.version || view != pending.view {
			continue
		}
		if previous, sent := socket.presenceSent[id]; sent && previous == pending.view {
			continue
		}
		socket.wakePresenceWriter()
		return id, pending
	}
	return "", presenceSnapshot{}
}

func (h *connectionHub) markPresenceSent(socket *socketSession, id string, snapshot presenceSnapshot) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// A later authorization round may have removed this peer while the writer
	// was rescheduled after handing the frame to the socket.
	if !time.Now().Before(snapshot.deadline) {
		return
	}
	if socket.presenceSent == nil {
		socket.presenceSent = make(map[string]presenceView)
	}
	socket.presenceSent[id] = snapshot.view
}

func (ws *wsEndpoint) writePresenceEvent(socket *socketSession) error {
	id, snapshot := ws.hub.popPresence(socket)
	if id == "" {
		return nil
	}
	view := snapshot.view
	payload := wsPresencePayload{UserID: id, Status: "offline"}
	if view.online {
		payload.Status = "online"
	} else if !view.lastSeen.IsZero() {
		lastSeen := view.lastSeen.UTC()
		payload.LastSeenAt = &lastSeen
	}
	data, err := json.Marshal(newWSEnvelope("presence", newWSEventID(), payload))
	if err != nil {
		ws.logger.Warn("could not encode WebSocket presence")
		return nil
	}
	now := time.Now()
	deadline := ws.socketWriteDeadline(socket, now)
	if snapshot.deadline.Before(deadline) {
		deadline = snapshot.deadline
	}
	if !now.Before(deadline) {
		return nil
	}
	if err := writeSocketText(socket, data, deadline); err != nil {
		return err
	}
	ws.hub.markPresenceSent(socket, id, snapshot)
	return nil
}
