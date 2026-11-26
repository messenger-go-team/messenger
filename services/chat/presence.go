package main

import (
	"context"
	"encoding/json"
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
}

type wsPresencePayload struct {
	UserID     string     `json:"user_id"`
	Status     string     `json:"status"`
	LastSeenAt *time.Time `json:"last_seen_at"`
}

func (ws *wsEndpoint) runPresence(user *hubUser) {
	ticker := time.NewTicker(ws.timing.presenceRefresh)
	defer ticker.Stop()
	for {
		select {
		case <-user.ctx.Done():
			return
		case <-user.wake:
		case <-ticker.C:
		}
		if user.ctx.Err() != nil {
			return
		}
		ws.refreshPresence(user)
	}
}

func (ws *wsEndpoint) refreshPresence(user *hubUser) {
	h := ws.hub
	h.mu.Lock()
	version := h.presenceVersion
	h.mu.Unlock()

	ctx, cancel := context.WithTimeout(user.ctx, ws.historyTimeout)
	defer cancel()
	response, err := ws.history.ListPresencePeers(ctx, &historyv1.ListPresencePeersRequest{RequesterId: user.id})
	var peers map[string]struct{}
	if err == nil {
		peers = make(map[string]struct{}, len(response.GetUserIds()))
		for _, id := range response.GetUserIds() {
			if id != user.id && validWSUUID(id) && strings.ToLower(id) == id {
				peers[id] = struct{}{}
			}
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[user.id] != user || user.ctx.Err() != nil {
		return
	}
	if err != nil || ctx.Err() != nil {
		// Keep wakeup hints for the next authorized lookup.
		for socket := range user.sockets {
			socket.presencePending = nil
		}
		return
	}
	now := time.Now()
	h.sweepOfflineLocked(now)
	h.applyPresenceLocked(user, peers, version, now)
}

func (h *connectionHub) applyPresenceLocked(user *hubUser, peers map[string]struct{}, version uint64, now time.Time) {
	h.setPresencePeersLocked(user, peers)
	views := make(map[string]presenceSnapshot, len(peers))
	for id := range peers {
		current, changed := h.presenceOfLocked(id, now)
		if changed > version {
			// A transition during the lookup needs another authorization snapshot.
			user.wakePresence()
			continue
		}
		views[id] = presenceSnapshot{view: current, version: changed}
	}

	for socket := range user.sockets {
		if socket.presenceSince > version || !now.Before(socket.expiresAt) {
			continue
		}
		for id := range socket.presenceSent {
			if _, allowed := peers[id]; !allowed {
				delete(socket.presenceSent, id)
			}
		}
		clear(socket.presencePending)
		for id, current := range views {
			if previous, sent := socket.presenceSent[id]; !sent || previous != current.view {
				if socket.presencePending == nil {
					socket.presencePending = make(map[string]presenceSnapshot)
				}
				socket.presencePending[id] = current
			}
		}
		socket.wakePresenceWriter()
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

func (h *connectionHub) popPresence(socket *socketSession) (string, presenceView) {
	h.mu.Lock()
	defer h.mu.Unlock()
	user := h.users[socket.userID]
	if user == nil || user.ctx.Err() != nil {
		return "", presenceView{}
	}
	if _, registered := user.sockets[socket]; !registered {
		return "", presenceView{}
	}
	now := time.Now()
	for id, pending := range socket.presencePending {
		delete(socket.presencePending, id)
		view, version := h.presenceOfLocked(id, now)
		if version != pending.version || view != pending.view {
			continue
		}
		if socket.presenceSent == nil {
			socket.presenceSent = make(map[string]presenceView)
		}
		socket.presenceSent[id] = view
		socket.wakePresenceWriter()
		return id, view
	}
	return "", presenceView{}
}

func (ws *wsEndpoint) takePresenceEvent(socket *socketSession) []byte {
	id, view := ws.hub.popPresence(socket)
	if id == "" {
		return nil
	}
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
	return data
}
