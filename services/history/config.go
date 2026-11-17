package main

import (
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

type config struct {
	ServiceName, HTTPAddr, GRPCAddr, DatabaseURL, AuthURL, InternalToken string
	LogLevel                                                             slog.Level
	ShutdownTimeout                                                      time.Duration
	JWTVerifier                                                          *jwtauth.Verifier
}

func loadConfig(lookup func(string) (string, bool)) (config, error) {
	value := func(k, d string) string {
		if v, ok := lookup(k); ok {
			return v
		}
		return d
	}
	c := config{ServiceName: value("SERVICE_NAME", "history"), HTTPAddr: value("HTTP_ADDR", ":8080"), GRPCAddr: value("GRPC_ADDR", ":9090"), DatabaseURL: value("HISTORY_DATABASE_URL", ""), AuthURL: value("AUTH_BASE_URL", "http://auth:8080"), InternalToken: value("AUTH_INTERNAL_TOKEN", "")}
	if strings.TrimSpace(c.ServiceName) == "" {
		return config{}, fmt.Errorf("SERVICE_NAME must not be empty")
	}
	for name, addr := range map[string]string{"HTTP_ADDR": c.HTTPAddr, "GRPC_ADDR": c.GRPCAddr} {
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			return config{}, fmt.Errorf("%s must be host:port", name)
		}
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 {
			return config{}, fmt.Errorf("%s port must be in 0..65535", name)
		}
	}
	if err := c.LogLevel.UnmarshalText([]byte(value("LOG_LEVEL", "INFO"))); err != nil {
		return config{}, fmt.Errorf("invalid LOG_LEVEL")
	}
	var err error
	c.ShutdownTimeout, err = time.ParseDuration(value("SHUTDOWN_TIMEOUT", "10s"))
	if err != nil || c.ShutdownTimeout <= 0 {
		return config{}, fmt.Errorf("SHUTDOWN_TIMEOUT must be positive")
	}
	secret := value("JWT_SECRET", "")
	c.JWTVerifier, err = jwtauth.New(secret)
	if err != nil {
		return config{}, err
	}
	if c.DatabaseURL == "" {
		return config{}, fmt.Errorf("HISTORY_DATABASE_URL is required")
	}
	u, err := url.Parse(c.AuthURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return config{}, fmt.Errorf("AUTH_BASE_URL must be an HTTP origin")
	}
	if len(c.InternalToken) < 32 || c.InternalToken == secret {
		return config{}, fmt.Errorf("AUTH_INTERNAL_TOKEN must be separate from JWT_SECRET and at least 32 bytes")
	}
	for _, b := range []byte(c.InternalToken) {
		if b < 0x21 || b > 0x7e {
			return config{}, fmt.Errorf("AUTH_INTERNAL_TOKEN must be printable ASCII without spaces")
		}
	}
	return c, nil
}
