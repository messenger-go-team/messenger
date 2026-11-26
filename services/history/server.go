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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/internal/metrics"
	"github.com/messenger-go-team/messenger/services/history/internal/authclient"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
	"google.golang.org/grpc"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func run(ctx context.Context, c config, logger *slog.Logger) error {
	dbcfg, err := pgx.ParseConfig(c.DatabaseURL)
	if err != nil {
		return errors.New("invalid HISTORY_DATABASE_URL")
	}
	db := stdlib.OpenDB(*dbcfg)
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	startup, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = db.PingContext(startup)
	cancel()
	if err != nil {
		return errors.New("connect to history database failed")
	}
	repo := &postgres.Repository{DB: db}
	savedRepo := &postgres.LaterRepository{DB: db}
	service := &chats.Service{Repo: repo, Users: authclient.New(c.AuthURL, c.InternalToken)}
	httpListener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", c.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen HTTP: %w", err)
	}
	defer func() { _ = httpListener.Close() }()
	grpcListener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", c.GRPCAddr)
	if err != nil {
		return fmt.Errorf("listen gRPC: %w", err)
	}
	defer func() { _ = grpcListener.Close() }()
	var ready atomic.Bool
	checkReady := historyReadiness(repo, savedRepo)
	rpcMetrics := metrics.NewRequests("history", "grpc")
	collectors := append(rpcMetrics.Collectors(), metrics.NewDBPoolCollector("history", db))
	routes := chatRoutes(service, c.JWTVerifier, &reading.Service{Repo: repo, Users: service.Users}, &later.Service{Repo: savedRepo})
	web := &http.Server{
		Handler:           newServiceHandlerWithReadiness(&ready, logger, routes, checkReady, collectors...),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	rpc := grpc.NewServer(
		grpc.ChainUnaryInterceptor(rpcMetrics.UnaryServerInterceptor(historyv1.HistoryService_ServiceDesc), rpcLogging(logger)),
		grpc.MaxRecvMsgSize(1<<20),
	)
	historyv1.RegisterHistoryServiceServer(rpc, &historyGRPC{repo: repo, presence: repo, messages: messages.New(repo), receipts: repo})
	healthpb.RegisterHealthServer(rpc, &historyHealth{ready: &ready, check: checkReady})
	return serveHistory(ctx, web, rpc, httpListener, grpcListener, &ready, c.ShutdownTimeout, logger)
}
func serveHistory(ctx context.Context, web *http.Server, rpc *grpc.Server, httpListener, grpcListener net.Listener, ready *atomic.Bool, timeout time.Duration, logger *slog.Logger) error {
	results := make(chan error, 2)
	go func() {
		err := web.Serve(httpListener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		results <- err
	}()
	connections := &grpcConnections{Listener: grpcListener, conns: make(map[*grpcConnection]struct{})}
	go func() { results <- rpc.Serve(connections) }()
	ready.Store(true)
	logger.Info("servers listening", "http_addr", httpListener.Addr().String(), "grpc_addr", grpcListener.Addr().String())
	var first error
	received := 0
	select {
	case <-ctx.Done():
	case first = <-results:
		received = 1
		if first == nil {
			first = errors.New("server stopped unexpectedly")
		}
	}
	ready.Store(false)
	shutdown, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	done := make(chan struct{})
	go func() { rpc.GracefulStop(); close(done) }()
	if err := web.Shutdown(shutdown); err != nil {
		_ = web.Close()
		first = errors.Join(first, errors.New("HTTP shutdown deadline exceeded"))
	}
	force := func() error {
		connections.forceClose()
		_ = web.Close()
		// Stop itself can wait behind GracefulStop. Completion of either
		// gRPC stop or Serve is not a prerequisite for returning a timeout.
		go rpc.Stop()
		logger.Error("shutdown deadline exceeded; transports closed")
		return errors.Join(first, errors.New("gRPC shutdown deadline exceeded"))
	}
	select {
	case <-done:
	case <-shutdown.Done():
		return force()
	}
	for received < 2 {
		select {
		case err := <-results:
			first = errors.Join(first, err)
			received++
		case <-shutdown.Done():
			return force()
		}
	}
	logger.Info("servers stopped")
	return first
}

// Readiness checks the schema and grants used by History's active endpoints.
// Keep the checks on the same runtime role rather than a migration-owner DSN.
func historyReadiness(repo *postgres.Repository, saved *postgres.LaterRepository) func(context.Context) error {
	return func(ctx context.Context) error {
		if err := repo.Ready(ctx); err != nil {
			return err
		}
		if err := repo.ReceiptsReady(ctx); err != nil {
			return err
		}
		return saved.Ready(ctx)
	}
}
