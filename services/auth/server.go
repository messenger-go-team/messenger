package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
	"github.com/messenger-go-team/messenger/services/auth/internal/postgres"
	"log/slog"
	"net"
	"net/http"
	"sync/atomic"
	"time"
)

func run(ctx context.Context, cfg config, logger *slog.Logger) error {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen HTTP: %w", err)
	}
	// Close the listener even if dependency initialization fails.
	defer func() { _ = listener.Close() }()
	databaseConfig, err := pgx.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("invalid AUTH_DATABASE_URL")
	}
	db := stdlib.OpenDB(*databaseConfig)
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	defer func() { _ = db.Close() }()
	startup, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = db.PingContext(startup)
	cancel()
	if err != nil {
		return errors.New("connect to auth database failed")
	}
	repository := postgres.New(db)
	application, err := auth.NewService(repository, cfg.JWTSecret)
	if err != nil {
		return err
	}
	var ready atomic.Bool
	handler := newAuthHandler(&ready, logger, application, repository.CheckReady)
	server := newHTTPServer(cfg, handler, logger)
	return serve(ctx, server, listener, &ready, cfg.ShutdownTimeout, logger)
}

func newHTTPServer(cfg config, handler http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
}

func serve(ctx context.Context, server *http.Server, listener net.Listener,
	ready *atomic.Bool, timeout time.Duration, logger *slog.Logger,
) error {
	serveResult := make(chan error, 1)
	ready.Store(true)
	go func() {
		serveResult <- server.Serve(listener)
	}()
	logger.Info("server listening", "addr", listener.Addr().String())

	select {
	case err := <-serveResult:
		ready.Store(false)
		return serveError(err)
	case <-ctx.Done():
		ready.Store(false)
		logger.Info("shutdown started")
	}

	// The signal context is already cancelled; draining needs its own deadline.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		// Stop accepting work even if a handler cannot drain in time.
		if closeErr := server.Close(); closeErr != nil {
			logger.Error("force close HTTP", "error", closeErr)
		}
		return errors.Join(fmt.Errorf("shutdown HTTP: %w", err), serveError(<-serveResult))
	}
	if err := serveError(<-serveResult); err != nil {
		return err
	}
	logger.Info("server stopped")
	return nil
}

func serveError(err error) error {
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("serve HTTP: %w", err)
}
