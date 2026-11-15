package main

import (
	"strings"
	"testing"
)

func TestHistoryConfig(t *testing.T) {
	base := map[string]string{"JWT_SECRET": testSecret, "AUTH_INTERNAL_TOKEN": serviceSecret, "HISTORY_DATABASE_URL": "postgres://localhost/test"}
	load := func(values map[string]string) (config, error) {
		return loadConfig(func(k string) (string, bool) { v, ok := values[k]; return v, ok })
	}
	c, err := load(base)
	if err != nil || c.ServiceName != "history" || c.GRPCAddr != ":9090" {
		t.Fatal(c.ServiceName, err)
	}
	for k, values := range map[string][]string{"AUTH_INTERNAL_TOKEN": {"", testSecret, "short", strings.Repeat("a", 32) + " "}, "AUTH_BASE_URL": {"http://user:password@auth:8080", "file:///auth", "http://auth/path", "http://auth?secret=value"}, "GRPC_ADDR": {"bad", ":65536"}, "SHUTDOWN_TIMEOUT": {"0s"}, "HISTORY_DATABASE_URL": {""}} {
		for _, v := range values {
			cfg := map[string]string{}
			for key, value := range base {
				cfg[key] = value
			}
			cfg[k] = v
			if _, err = load(cfg); err == nil {
				t.Errorf("accepted invalid %s", k)
			} else if strings.Contains(err.Error(), "password") {
				t.Error("config error leaked credentials")
			}
		}
	}
}
