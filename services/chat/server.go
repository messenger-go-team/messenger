package main

import (
	"context"
	"errors"
	"fmt"
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
	var ready atomic.Bool
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming())
	handler := newServiceHandler(&ready, logger, ws)
	server := newHTTPServer(cfg, handler, logger)
	return serve(ctx, server, listener, ws, cfg.ShutdownTimeout, logger)
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
	ws *wsEndpoint, timeout time.Duration, logger *slog.Logger,
) error {
	serveResult := make(chan error, 1)
	ws.ready.Store(true)
	go func() {
		serveResult <- server.Serve(listener)
	}()
	logger.Info("server listening", "addr", listener.Addr().String())

	var serveErr error
	select {
	case serveErr = <-serveResult:
		serveResult = nil
	case <-ctx.Done():
	}
	ws.stopAccepting()
	defer ws.forceClose()
	logger.Info("shutdown started")

	// The signal context is already cancelled; draining needs its own deadline.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var httpErr error
	if err := server.Shutdown(shutdownCtx); err != nil {
		// Stop accepting work even if a handler cannot drain in time.
		if closeErr := server.Close(); closeErr != nil {
			logger.Error("force close HTTP", "error", closeErr)
		}
		httpErr = fmt.Errorf("shutdown HTTP: %w", err)
	}
	wsErr := ws.wait(shutdownCtx)
	if serveResult != nil {
		serveErr = <-serveResult
	}
	if err := errors.Join(httpErr, wsErr, serveError(serveErr)); err != nil {
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
