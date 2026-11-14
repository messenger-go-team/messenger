package main

import (
	"strings"
	"testing"
	"time"
)

func TestAuthConfig(t *testing.T) {
	base := map[string]string{"JWT_SECRET": strings.Repeat("x", 32), "AUTH_DATABASE_URL": "postgres://auth:password@localhost/auth?sslmode=disable"}
	lookup := func(name string) (string, bool) { v, ok := base[name]; return v, ok }
	cfg, err := loadConfig(lookup)
	if err != nil || cfg.ServiceName != "auth" || cfg.HTTPAddr != ":8080" || cfg.ShutdownTimeout != 10*time.Second {
		t.Fatal("invalid defaults", err)
	}
	for _, tc := range []struct{ name, value string }{
		{"SERVICE_NAME", ""}, {"HTTP_ADDR", "localhost"}, {"HTTP_ADDR", ":65536"}, {"HTTP_ADDR", ":-1"},
		{"LOG_LEVEL", "verbose"}, {"SHUTDOWN_TIMEOUT", "0s"}, {"SHUTDOWN_TIMEOUT", "bad"},
		{"JWT_SECRET", ""}, {"JWT_SECRET", strings.Repeat("x", 31)}, {"AUTH_DATABASE_URL", ""},
	} {
		t.Run(tc.name+tc.value, func(t *testing.T) {
			value, exists := base[tc.name]
			base[tc.name] = tc.value
			defer func() {
				if exists {
					base[tc.name] = value
				} else {
					delete(base, tc.name)
				}
			}()
			if _, err := loadConfig(lookup); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}
