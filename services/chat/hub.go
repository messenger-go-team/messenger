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
	users  map[string]map[*socketSession]struct{}
	active int
	closed bool
}

func newConnectionHub() *connectionHub {
	return &connectionHub{users: make(map[string]map[*socketSession]struct{})}
}

func (h *connectionHub) register(socket *socketSession) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	sockets := h.users[socket.userID]
	if sockets == nil {
		sockets = make(map[*socketSession]struct{})
		h.users[socket.userID] = sockets
	}
	sockets[socket] = struct{}{}
	h.active++
	return true
}

func (h *connectionHub) unregister(socket *socketSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sockets := h.users[socket.userID]
	delete(sockets, socket)
	if len(sockets) == 0 {
		delete(h.users, socket.userID)
	}
	h.active--
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
		for socket := range h.users[userID] {
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
	for _, userSockets := range h.users {
		for socket := range userSockets {
			sockets = append(sockets, socket)
		}
	}
	h.mu.Unlock()
	for _, socket := range sockets {
		_ = socket.conn.Close()
	}
}
