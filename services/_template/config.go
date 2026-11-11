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
	JWTVerifier     *jwtauth.Verifier
}

func loadConfig(lookup func(string) (string, bool)) (config, error) {
	value := func(name, fallback string) string {
		if v, ok := lookup(name); ok {
			return v
		}
		return fallback
	}

	cfg := config{
		ServiceName: value("SERVICE_NAME", "template"),
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
	cfg.JWTVerifier, err = jwtauth.New(value(jwtauth.SecretEnv, ""))
	if err != nil {
		return config{}, err
	}
	return cfg, nil
}
