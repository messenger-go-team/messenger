package main

import (
	"sync"
	"time"
)

const sendBucketSweepInterval = time.Minute

// sendLimiter holds one token bucket per authenticated user on this Chat replica.
// fullAt is the time when all spent tokens will have been refilled.
type sendLimiter struct {
	mu        sync.Mutex
	now       func() time.Time
	interval  time.Duration
	window    time.Duration
	fullAt    map[string]time.Time
	nextSweep time.Time
}

func newSendLimiter(interval time.Duration, burst int, now func() time.Time) *sendLimiter {
	return &sendLimiter{
		now:      now,
		interval: interval,
		window:   interval * time.Duration(burst),
		fullAt:   make(map[string]time.Time),
	}
}

// take consumes one token or returns the wait until the next token.
func (l *sendLimiter) take(userID string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	// Dropping a fully refilled bucket is equivalent to keeping it.
	if !now.Before(l.nextSweep) {
		for user, fullAt := range l.fullAt {
			if !now.Before(fullAt) {
				delete(l.fullAt, user)
			}
		}
		l.nextSweep = now.Add(sendBucketSweepInterval)
	}

	fullAt := l.fullAt[userID]
	if fullAt.Before(now) {
		fullAt = now
	}
	if wait := fullAt.Sub(now) - (l.window - l.interval); wait > 0 {
		return wait
	}
	l.fullAt[userID] = fullAt.Add(l.interval)
	return 0
}
