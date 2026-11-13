package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	os.Exit(mainCode())
}

func mainCode() int {
	cfg, err := loadConfig(os.LookupEnv)
	if err != nil {
		newLogger(os.Stderr, "chat", slog.LevelInfo).Error("invalid configuration", "error", err)
		return 1
	}
	logger := newLogger(os.Stdout, cfg.ServiceName, cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("service stopped with error", "error", err)
		return 1
	}
	return 0
}
