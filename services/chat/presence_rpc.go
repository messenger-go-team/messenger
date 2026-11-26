package main

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"
)

const (
	presenceRPCConcurrency = 4
	presenceRPCInterval    = 10 * time.Millisecond
	presenceBatchSize      = 128
	maxPresenceBackoff     = time.Minute
)

// All four batch workers share one limit on RPC starts.
type presenceRPCGate struct {
	mu   sync.Mutex
	next time.Time
}

func (gate *presenceRPCGate) wait(ctx context.Context) bool {
	for ctx.Err() == nil {
		gate.mu.Lock()
		now := time.Now()
		wait := gate.next.Sub(now)
		if wait <= 0 {
			gate.next = now.Add(presenceRPCInterval)
		}
		gate.mu.Unlock()
		if wait <= 0 {
			return true
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
		timer.Stop()
	}
	return false
}

func jitterPresence(delay time.Duration) time.Duration {
	spread := delay / 5
	return delay - spread + time.Duration(rand.Int64N(int64(2*spread+1)))
}

func (ws *wsEndpoint) runPresence(user *hubUser) {
	interval := ws.timing.presenceRefresh
	timer := time.NewTimer(jitterPresence(interval))
	defer timer.Stop()

	wake := user.wake
	backoff := interval
	for {
		select {
		case <-user.ctx.Done():
			return
		case <-wake:
		case <-timer.C:
			// Accumulated wakeups before a retry are covered by this lookup.
			select {
			case <-user.wake:
			default:
			}
		}
		if user.ctx.Err() != nil {
			return
		}
		if ws.refreshPresence(user) {
			backoff = interval
			wake = user.wake
			timer.Reset(jitterPresence(interval))
		} else {
			wake = nil
			timer.Reset(min(jitterPresence(backoff), maxPresenceBackoff))
			backoff = min(backoff*2, maxPresenceBackoff)
		}
	}
}
