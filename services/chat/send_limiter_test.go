package main

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWSSendLimitConfig(t *testing.T) {
	cfg := testConfig(t)
	if cfg.SendInterval != 200*time.Millisecond || cfg.SendBurst != 10 {
		t.Fatalf("default send limit = %s, %d", cfg.SendInterval, cfg.SendBurst)
	}
	for _, tc := range []struct {
		interval string
		burst    string
		errorKey string
	}{
		{"750ms", "3", ""},
		{"0s", "3", "WS_SEND_INTERVAL"},
		{"-1s", "3", "WS_SEND_INTERVAL"},
		{"invalid", "3", "WS_SEND_INTERVAL"},
		{"1s", "0", "WS_SEND_BURST"},
		{"1s", "-1", "WS_SEND_BURST"},
		{"1s", "1.5", "WS_SEND_BURST"},
		{"2562047h", "2", "WS_SEND_BURST"},
	} {
		cfg, err := loadConfig(func(key string) (string, bool) {
			value, ok := map[string]string{
				"JWT_SECRET": testSecret, "WS_ALLOWED_ORIGINS": testOrigin,
				"WS_SEND_INTERVAL": tc.interval, "WS_SEND_BURST": tc.burst,
			}[key]
			return value, ok
		})
		if tc.errorKey != "" {
			if err == nil || !strings.Contains(err.Error(), tc.errorKey) {
				t.Errorf("limit %q/%q: got %v, want error for %s", tc.interval, tc.burst, err, tc.errorKey)
			}
		} else if err != nil || cfg.SendInterval != 750*time.Millisecond || cfg.SendBurst != 3 {
			t.Errorf("limit %q/%q: got %s/%d, %v", tc.interval, tc.burst, cfg.SendInterval, cfg.SendBurst, err)
		}
	}
}

func TestSendLimiterRefillsAndDropsFullBuckets(t *testing.T) {
	const interval = 200 * time.Millisecond
	start := time.Now()
	now := start
	limiter := newSendLimiter(interval, 2, func() time.Time { return now })
	for _, tc := range []struct {
		elapsed time.Duration
		user    string
		wait    time.Duration
	}{
		{0, "alice", 0},
		{0, "alice", 0},
		{0, "alice", interval},
		{0, "bob", 0},
		{interval - time.Nanosecond, "alice", time.Nanosecond},
		{interval, "alice", 0},
		{interval, "alice", interval},
		{2 * interval, "alice", 0},
		{5 * interval, "alice", 0},
		{5 * interval, "alice", 0},
		{5 * interval, "alice", interval},
		{sendBucketSweepInterval, "carol", 0},
	} {
		now = start.Add(tc.elapsed)
		if got := limiter.take(tc.user); got != tc.wait {
			t.Errorf("take(%s) at %s = %s, want %s", tc.user, tc.elapsed, got, tc.wait)
		}
	}
	if len(limiter.fullAt) != 1 || !limiter.fullAt["carol"].Equal(now.Add(interval)) {
		t.Fatalf("sweep kept fully replenished buckets: %v", limiter.fullAt)
	}
}

func TestSendLimiterConcurrentAttemptsShareBurst(t *testing.T) {
	const burst = 4
	now := time.Now()
	limiter := newSendLimiter(time.Second, burst, func() time.Time { return now })
	var accepted atomic.Int32
	var attempts sync.WaitGroup
	for range 50 {
		attempts.Go(func() {
			if limiter.take("same-user") == 0 {
				accepted.Add(1)
			}
		})
	}
	attempts.Wait()
	if got := accepted.Load(); got != burst {
		t.Fatalf("accepted %d commands, want %d", got, burst)
	}
}
