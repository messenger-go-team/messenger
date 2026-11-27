package main

import (
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
	view    presenceView
	version uint64
	grant   *presenceGrant
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
		allowed, grant, ok := ws.authorizePresence(user, ids)
		if !ok {
			ws.hub.dropPendingPresence(user)
			return false
		}
		ws.hub.queuePresence(user, version, candidates, ids, allowed, grant)
		grant.finish()
	}
	return true
}

func (ws *wsEndpoint) discoverPresence(user *hubUser) (map[string]struct{}, uint64, bool) {
	result := ws.callPresence(user.ctx, &historyv1.PresenceOperation{
		Request: &historyv1.PresenceOperation_List{List: &historyv1.ListPresencePeersRequest{RequesterId: user.id}},
	})
	response := result.data.GetList()
	if response == nil || user.ctx.Err() != nil {
		return nil, 0, false
	}
	peers := make(map[string]struct{}, len(response.GetUserIds()))
	for _, id := range response.GetUserIds() {
		if id != user.id && validWSUUID(id) && strings.ToLower(id) == id {
			peers[id] = struct{}{}
		}
	}
	return peers, result.version, true
}

func (ws *wsEndpoint) authorizePresence(user *hubUser, ids []string) (map[string]struct{}, *presenceGrant, bool) {
	result := ws.callPresence(user.ctx, &historyv1.PresenceOperation{
		Request: &historyv1.PresenceOperation_Authorize{Authorize: &historyv1.AuthorizePresenceDeliveryRequest{
			RequesterId: user.id,
			UserIds:     ids,
		}},
	})
	response := result.data.GetAuthorize()
	if response == nil {
		return nil, nil, false
	}
	if len(response.GetUserIds()) == 0 && response.GetGrantId() == "" {
		return nil, nil, true
	}
	if !validWSUUID(response.GetGrantId()) || strings.ToLower(response.GetGrantId()) != response.GetGrantId() {
		return nil, nil, false
	}

	grant := &presenceGrant{
		id:      response.GetGrantId(),
		startBy: result.started.Add(presenceStartWindow),
		writeBy: result.started.Add(presenceGrantWindow),
		batcher: ws.presenceRPC,
	}
	grant.pending.Store(1)
	if user.ctx.Err() != nil || !time.Now().Before(grant.startBy) {
		grant.finish()
		return nil, nil, false
	}
	allowed := make(map[string]struct{}, len(response.GetUserIds()))
	for _, id := range response.GetUserIds() {
		allowed[id] = struct{}{}
	}
	return allowed, grant, true
}

func (h *connectionHub) dropPendingPresence(user *hubUser) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for socket := range user.sockets {
		socket.clearPendingPresence()
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
			if _, allowed := peers[id]; !allowed || !now.Before(pending.grant.startBy) {
				socket.dropPendingPresence(id)
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
	ids []string, allowed map[string]struct{}, grant *presenceGrant,
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
				socket.dropPendingPresence(id)
				delete(socket.presenceSent, id)
				continue
			}
			if socket.presenceSince > version || !now.Before(socket.expiresAt) || !now.Before(grant.startBy) ||
				changed != snapshot.version || current != snapshot.view {
				continue
			}
			if previous, sent := socket.presenceSent[id]; sent && previous == snapshot.view {
				continue
			}
			if socket.presencePending == nil {
				socket.presencePending = make(map[string]presenceSnapshot)
			}
			socket.dropPendingPresence(id)
			grant.pending.Add(1)
			snapshot.grant = grant
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

// All pending map mutations are serialized by the hub. A popped entry moves
// its reservation reference to the writer, which finishes it after the write.
func (socket *socketSession) dropPendingPresence(id string) {
	if pending, exists := socket.presencePending[id]; exists {
		delete(socket.presencePending, id)
		pending.grant.finish()
	}
}

func (socket *socketSession) clearPendingPresence() {
	for id := range socket.presencePending {
		socket.dropPendingPresence(id)
	}
	socket.presencePending = nil
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
		if !now.Before(pending.grant.startBy) || version != pending.version || view != pending.view {
			pending.grant.finish()
			continue
		}
		if previous, sent := socket.presenceSent[id]; sent && previous == pending.view {
			pending.grant.finish()
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
	if !time.Now().Before(snapshot.grant.writeBy) {
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
	defer snapshot.grant.finish()
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
	// Skip if there is no full ordinary write budget left. Once Gorilla is
	// writing, it gets exactly the same deadline as a regular message.
	if !now.Before(snapshot.grant.startBy) || !now.Before(deadline) || deadline.After(snapshot.grant.writeBy) {
		return nil
	}
	if err := writeSocketText(socket, data, deadline); err != nil {
		return err
	}
	ws.hub.markPresenceSent(socket, id, snapshot)
	return nil
}
