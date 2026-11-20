package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func TestChatReadinessChecksHistoryOverGRPC(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rpc := grpc.NewServer()
	historyHealth := health.NewServer()
	service := historyv1.HistoryService_ServiceDesc.ServiceName
	historyHealth.SetServingStatus(service, healthpb.HealthCheckResponse_NOT_SERVING)
	healthpb.RegisterHealthServer(rpc, historyHealth)
	served := make(chan error, 1)
	go func() { served <- rpc.Serve(listener) }()
	t.Cleanup(rpc.Stop)

	conn, err := newHistoryConn(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	logger := newLogger(io.Discard, "chat", cfg.LogLevel)
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming(), historyv1.NewHistoryServiceClient(conn), logger)
	t.Cleanup(ws.stopAccepting)
	handler := newServiceHandler(&ready, logger, ws, healthpb.NewHealthClient(conn))

	check := func(path string, want int) {
		t.Helper()
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, path, nil))
		if result.Code != want {
			t.Fatalf("%s = %d, want %d: %s", path, result.Code, want, result.Body.String())
		}
	}
	check("/readyz", http.StatusServiceUnavailable)
	historyHealth.SetServingStatus(service, healthpb.HealthCheckResponse_SERVING)
	check("/readyz", http.StatusOK)
	rpc.Stop()
	if err := <-served; err != nil {
		t.Fatal(err)
	}
	check("/readyz", http.StatusServiceUnavailable)
	check("/healthz", http.StatusOK)
}
