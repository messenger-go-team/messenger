package main

import (
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

type config struct {
	ServiceName       string
	HTTPAddr          string
	LogLevel          slog.Level
	ShutdownTimeout   time.Duration
	JWTVerifier       *jwtauth.Verifier
	AllowedOrigins    map[string]struct{}
	HistoryGRPCAddr   string
	HistoryRPCTimeout time.Duration
	SendInterval      time.Duration
	SendBurst         int
	RedisURL          string
	RedisPrefix       string
}

var redisPrefixPattern = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,64}$`)

func loadConfig(lookup func(string) (string, bool)) (config, error) {
	value := func(name, fallback string) string {
		if v, ok := lookup(name); ok {
			return v
		}
		return fallback
	}

	cfg := config{
		ServiceName:     value("SERVICE_NAME", "chat"),
		HTTPAddr:        value("HTTP_ADDR", ":8080"),
		HistoryGRPCAddr: value("HISTORY_GRPC_ADDR", "history:9090"),
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
	cfg.AllowedOrigins, err = parseAllowedOrigins(value("WS_ALLOWED_ORIGINS", ""))
	if err != nil {
		return config{}, err
	}
	historyHost, historyPort, err := net.SplitHostPort(cfg.HistoryGRPCAddr)
	if err != nil || historyHost == "" || strings.ContainsAny(historyHost, "/?#@ \t\r\n") {
		return config{}, fmt.Errorf("HISTORY_GRPC_ADDR must be host:port")
	}
	number, err = strconv.Atoi(historyPort)
	if err != nil || number < 1 || number > 65535 {
		return config{}, fmt.Errorf("HISTORY_GRPC_ADDR port must be an integer in 1..65535")
	}
	cfg.HistoryRPCTimeout, err = time.ParseDuration(value("HISTORY_RPC_TIMEOUT", "3s"))
	if err != nil || cfg.HistoryRPCTimeout <= 0 {
		return config{}, fmt.Errorf("HISTORY_RPC_TIMEOUT must be a positive duration")
	}
	cfg.SendInterval, err = time.ParseDuration(value("WS_SEND_INTERVAL", "200ms"))
	if err != nil || cfg.SendInterval <= 0 {
		return config{}, fmt.Errorf("WS_SEND_INTERVAL must be a positive duration")
	}
	cfg.SendBurst, err = strconv.Atoi(value("WS_SEND_BURST", "10"))
	if err != nil || cfg.SendBurst <= 0 || time.Duration(cfg.SendBurst) > math.MaxInt64/cfg.SendInterval {
		return config{}, fmt.Errorf("WS_SEND_BURST must be a positive integer with a representable refill duration")
	}
	switch value("CHAT_BROKER", "memory") {
	case "memory":
	case "redis":
		cfg.RedisURL = value("REDIS_URL", "")
		if !validRedisURL(cfg.RedisURL) {
			return config{}, fmt.Errorf("REDIS_URL must be a redis or rediss URL with a host and no query or fragment")
		}
		cfg.RedisPrefix = value("REDIS_CHANNEL_PREFIX", "messenger:chat")
		if !redisPrefixPattern.MatchString(cfg.RedisPrefix) {
			return config{}, fmt.Errorf("REDIS_CHANNEL_PREFIX must contain 1..64 letters, digits, colons, underscores or hyphens")
		}
	default:
		return config{}, fmt.Errorf("CHAT_BROKER must be memory or redis")
	}
	return cfg, nil
}

func validRedisURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") ||
		u.Hostname() == "" || u.ForceQuery || u.RawQuery != "" || strings.Contains(raw, "#") {
		return false
	}
	if port := u.Port(); port != "" {
		number, err := strconv.Atoi(port)
		return err == nil && number >= 1 && number <= 65535
	}
	return !strings.HasSuffix(u.Host, ":")
}

func parseAllowedOrigins(value string) (map[string]struct{}, error) {
	origins := make(map[string]struct{})
	for item := range strings.SplitSeq(value, ",") {
		origin := strings.TrimSpace(item)
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
			origin != u.Scheme+"://"+u.Host {
			return nil, fmt.Errorf("WS_ALLOWED_ORIGINS must list HTTP(S) origins without paths")
		}
		if port := u.Port(); port != "" || strings.HasSuffix(u.Host, ":") {
			number, err := strconv.Atoi(port)
			if err != nil || number < 1 || number > 65535 {
				return nil, fmt.Errorf("WS_ALLOWED_ORIGINS contains an invalid port")
			}
		}
		origins[origin] = struct{}{}
	}
	return origins, nil
}
