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
		allow   bool
	}{
		{0, "alice", true},
		{0, "alice", true},
		{0, "alice", false},
		{0, "bob", true},
		{interval - time.Nanosecond, "alice", false},
		{interval, "alice", true},
		{interval, "alice", false},
		{2 * interval, "alice", true},
		{5 * interval, "alice", true},
		{5 * interval, "alice", true},
		{5 * interval, "alice", false},
		{sendBucketSweepInterval, "carol", true},
	} {
		now = start.Add(tc.elapsed)
		if got := limiter.allow(tc.user); got != tc.allow {
			t.Errorf("allow(%s) at %s = %t, want %t", tc.user, tc.elapsed, got, tc.allow)
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
			if limiter.allow("same-user") {
				accepted.Add(1)
			}
		})
	}
	attempts.Wait()
	if got := accepted.Load(); got != burst {
		t.Fatalf("accepted %d commands, want %d", got, burst)
	}
}
