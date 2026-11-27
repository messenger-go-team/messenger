package main

import (
	"bytes"
	"context"
	"sync"
	"time"
)

// Broker routes an encoded server event to every connection of each recipient.
// Successful publication is best effort and does not confirm receipt by a client.
type Broker interface {
	Publish(ctx context.Context, userIDs []string, event []byte) error
}

type memoryBroker struct {
	hub *connectionHub
}

func (b memoryBroker) Publish(ctx context.Context, userIDs []string, event []byte) error {
	// One immutable copy is shared by all queues. The caller can reuse its buffer.
	return b.hub.publish(ctx, userIDs, bytes.Clone(event))
}

type connectionHub struct {
	mu     sync.Mutex
	users  map[string]*hubUser
	active int
	closed bool

	// All presence state and per-socket outboxes share the hub lock.
	presenceVersion uint64
	watchers        map[string]map[*hubUser]struct{}
	offline         map[string]presenceActivity
	nextSweep       time.Time
}

type hubUser struct {
	id      string
	sockets map[*socketSession]struct{}
	ctx     context.Context
	cancel  context.CancelFunc
	wake    chan struct{}

	activity presenceActivity
	peers    map[string]struct{}
}

func newConnectionHub() *connectionHub {
	return &connectionHub{
		users:    make(map[string]*hubUser),
		watchers: make(map[string]map[*hubUser]struct{}),
		offline:  make(map[string]presenceActivity),
	}
}

// register returns the user only on its first live connection.
func (h *connectionHub) register(ctx context.Context, socket *socketSession) (*hubUser, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if h.closed || !now.Before(socket.expiresAt) {
		return nil, false
	}
	h.sweepOfflineLocked(now)
	h.presenceVersion++
	socket.presenceSince = h.presenceVersion
	user := h.users[socket.userID]
	first := user == nil
	if first {
		userCtx, cancel := context.WithCancel(ctx)
		user = &hubUser{
			id:      socket.userID,
			sockets: make(map[*socketSession]struct{}),
			ctx:     userCtx,
			cancel:  cancel,
			wake:    make(chan struct{}, 1),
			activity: presenceActivity{
				version: h.presenceVersion,
			},
		}
		delete(h.offline, socket.userID)
		h.users[socket.userID] = user
		h.wakeWatchersLocked(socket.userID)
	}
	user.activity.lastSeen = now
	user.sockets[socket] = struct{}{}
	h.active++
	user.wakePresence()
	if first {
		return user, true
	}
	return nil, true
}

func (h *connectionHub) unregister(socket *socketSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	user := h.users[socket.userID]
	if user == nil {
		return
	}
	if _, registered := user.sockets[socket]; !registered {
		return
	}
	socket.clearPendingPresence()
	delete(user.sockets, socket)
	h.active--
	if len(user.sockets) == 0 {
		delete(h.users, socket.userID)
		user.cancel()
		h.setPresencePeersLocked(user, nil)

		now := time.Now()
		h.sweepOfflineLocked(now)
		h.presenceVersion++
		user.activity.version = h.presenceVersion
		h.offline[socket.userID] = user.activity
		h.wakeWatchersLocked(socket.userID)
	}
}

func (h *connectionHub) confirmActivity(socket *socketSession, at time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	user := h.users[socket.userID]
	if user == nil || !at.Before(socket.expiresAt) || !at.After(user.activity.lastSeen) {
		return
	}
	if _, registered := user.sockets[socket]; registered {
		user.activity.lastSeen = at
	}
}

func (h *connectionHub) size() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.active
}

func (h *connectionHub) publish(ctx context.Context, userIDs []string, event []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	now := time.Now()
	for _, userID := range userIDs {
		user := h.users[userID]
		if user == nil {
			continue
		}
		for socket := range user.sockets {
			if now.Before(socket.expiresAt) {
				socket.enqueue(event)
			}
		}
	}
	return nil
}

func (h *connectionHub) forceClose() {
	h.mu.Lock()
	h.closed = true
	sockets := make([]*socketSession, 0, h.active)
	for _, user := range h.users {
		for socket := range user.sockets {
			sockets = append(sockets, socket)
		}
	}
	h.mu.Unlock()
	for _, socket := range sockets {
		_ = socket.conn.Close()
	}
}
