package main

import (
	"strings"
	"testing"
)

func TestRedisBrokerConfig(t *testing.T) {
	for _, tt := range []struct {
		name, mode, url, prefix string
		errorField              string
	}{
		{name: "default memory mode"},
		{name: "explicit memory mode ignores Redis URL", mode: "memory", url: "malformed"},
		{name: "local Redis", mode: "redis", url: "redis://127.0.0.1:6379/0"},
		{name: "authenticated TLS and isolated prefix", mode: "redis", url: "rediss://app:local-test-only@localhost:6379/0", prefix: "messenger:test_1"},
		{name: "unsupported mode", mode: "other", errorField: "CHAT_BROKER"},
		{name: "missing URL", mode: "redis", errorField: "REDIS_URL"},
		{name: "wrong scheme", mode: "redis", url: "https://localhost:6379/0", errorField: "REDIS_URL"},
		{name: "missing host", mode: "redis", url: "redis:///0", errorField: "REDIS_URL"},
		{name: "port above range", mode: "redis", url: "redis://localhost:65536", errorField: "REDIS_URL"},
		{name: "option in URL", mode: "redis", url: "redis://app:local-test-only@localhost?dial_timeout=1h", errorField: "REDIS_URL"},
		{name: "fragment in URL", mode: "redis", url: "redis://localhost/0#fragment", errorField: "REDIS_URL"},
		{name: "ambiguous namespace", mode: "redis", url: "redis://localhost", prefix: "test *", errorField: "REDIS_CHANNEL_PREFIX"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			values := map[string]string{
				"JWT_SECRET":         strings.Repeat("x", 32),
				"WS_ALLOWED_ORIGINS": "http://127.0.0.1:5173",
			}
			if tt.mode != "" {
				values["CHAT_BROKER"] = tt.mode
			}
			if tt.url != "" {
				values["REDIS_URL"] = tt.url
			}
			if tt.prefix != "" {
				values["REDIS_CHANNEL_PREFIX"] = tt.prefix
			}
			cfg, err := loadConfig(func(name string) (string, bool) { v, ok := values[name]; return v, ok })
			if tt.errorField != "" {
				if err == nil || !strings.Contains(err.Error(), tt.errorField) || strings.Contains(err.Error(), "local-test-only") {
					t.Fatalf("expected redacted validation error for %s", tt.errorField)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.mode != "redis" {
				if cfg.RedisURL != "" || cfg.RedisPrefix != "" {
					t.Fatal("unexpected Redis configuration in memory mode")
				}
				return
			}
			prefix := tt.prefix
			if prefix == "" {
				prefix = "messenger:chat"
			}
			if cfg.RedisURL != tt.url || cfg.RedisPrefix != prefix {
				t.Fatal("unexpected Redis configuration")
			}
		})
	}
}
