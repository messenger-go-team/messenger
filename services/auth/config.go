package main

import (
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

type config struct {
	ServiceName     string
	HTTPAddr        string
	LogLevel        slog.Level
	ShutdownTimeout time.Duration
	JWTSecret       string
	DatabaseURL     string
	InternalToken   string
}

func loadConfig(lookup func(string) (string, bool)) (config, error) {
	value := func(name, fallback string) string {
		if v, ok := lookup(name); ok {
			return v
		}
		return fallback
	}

	cfg := config{
		ServiceName: value("SERVICE_NAME", "auth"),
		HTTPAddr:    value("HTTP_ADDR", ":8080"),
	}
	if strings.TrimSpace(cfg.ServiceName) == "" {
		return config{}, fmt.Errorf("SERVICE_NAME must not be empty")
	}
	_, port, err := net.SplitHostPort(cfg.HTTPAddr)
	if err != nil {
		return config{}, fmt.Errorf("HTTP_ADDR must be host:port: %w", err)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 0 || number > 65535 {
		return config{}, fmt.Errorf("HTTP_ADDR port must be an integer in 0..65535")
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(value("LOG_LEVEL", "INFO"))); err != nil {
		return config{}, fmt.Errorf("LOG_LEVEL: %w", err)
	}
	cfg.ShutdownTimeout, err = time.ParseDuration(value("SHUTDOWN_TIMEOUT", "10s"))
	if err != nil {
		return config{}, fmt.Errorf("SHUTDOWN_TIMEOUT: %w", err)
	}
	if cfg.ShutdownTimeout <= 0 {
		return config{}, fmt.Errorf("SHUTDOWN_TIMEOUT must be positive")
	}
	cfg.JWTSecret = value(jwtauth.SecretEnv, "")
	_, err = jwtauth.New(cfg.JWTSecret)
	if err != nil {
		return config{}, err
	}
	cfg.DatabaseURL = value("AUTH_DATABASE_URL", "")
	if cfg.DatabaseURL == "" {
		return config{}, fmt.Errorf("AUTH_DATABASE_URL must not be empty")
	}
	cfg.InternalToken = value("AUTH_INTERNAL_TOKEN", "")
	if err := validateInternalToken(cfg.InternalToken); err != nil {
		return config{}, err
	}
	if cfg.InternalToken == cfg.JWTSecret {
		return config{}, fmt.Errorf("AUTH_INTERNAL_TOKEN must differ from JWT_SECRET")
	}
	return cfg, nil
}

func validateInternalToken(token string) error {
	if len(token) < 32 {
		return fmt.Errorf("AUTH_INTERNAL_TOKEN must contain at least 32 bytes")
	}
	for _, b := range []byte(token) {
		if b < 0x21 || b > 0x7e {
			return fmt.Errorf("AUTH_INTERNAL_TOKEN must contain printable ASCII without spaces")
		}
	}
	return nil
}
