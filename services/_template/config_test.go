package main

import (
	"log/slog"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want config
	}{
		{"defaults", nil, config{"template", ":8080", slog.LevelInfo, 10 * time.Second, nil}},
		{"custom", map[string]string{
			"SERVICE_NAME": "auth", "HTTP_ADDR": "127.0.0.1:9090",
			"LOG_LEVEL": "debug", "SHUTDOWN_TIMEOUT": "2s",
		}, config{"auth", "127.0.0.1:9090", slog.LevelDebug, 2 * time.Second, nil}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := loadConfig(func(key string) (string, bool) {
				if key == "JWT_SECRET" {
					return "test-template-secret-at-least-32-bytes", true
				}
				value, ok := tt.env[key]
				return value, ok
			})
			if err != nil {
				t.Fatal(err)
			}
			if cfg.JWTVerifier == nil {
				t.Fatal("expected configured JWT verifier")
			}
			cfg.JWTVerifier = nil
			if cfg != tt.want {
				t.Fatalf("got %+v, want %+v", cfg, tt.want)
			}
		})
	}
}

func TestLoadConfigRejectsInvalidValues(t *testing.T) {
	for _, tt := range []struct{ key, value string }{
		{"SERVICE_NAME", ""}, {"SERVICE_NAME", "  "},
		{"HTTP_ADDR", ""}, {"HTTP_ADDR", "8080"}, {"HTTP_ADDR", ":abc"},
		{"HTTP_ADDR", ":-1"}, {"HTTP_ADDR", ":65536"},
		{"LOG_LEVEL", ""}, {"LOG_LEVEL", "verbose"},
		{"SHUTDOWN_TIMEOUT", "bad"}, {"SHUTDOWN_TIMEOUT", "0s"},
		{"SHUTDOWN_TIMEOUT", "-1s"},
		{"JWT_SECRET", ""}, {"JWT_SECRET", "too-short"},
	} {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			_, err := loadConfig(func(key string) (string, bool) {
				return tt.value, key == tt.key
			})
			if err == nil {
				t.Fatal("expected a configuration error")
			}
		})
	}
}
