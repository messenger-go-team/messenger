package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc/codes"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

func TestHistoryGRPCHealthChecksRuntimeReadiness(t *testing.T) {
	var ready atomic.Bool
	var storageErr error
	checks := 0
	server := &historyHealth{ready: &ready, check: func(ctx context.Context) error {
		checks++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("storage readiness has no deadline")
		}
		return storageErr
	}}
	request := &healthpb.HealthCheckRequest{Service: historyv1.HistoryService_ServiceDesc.ServiceName}
	check := func(want healthpb.HealthCheckResponse_ServingStatus) {
		t.Helper()
		result, err := server.Check(t.Context(), request)
		if err != nil || result.GetStatus() != want {
			t.Fatalf("check = %v, %v, want %s", result, err, want)
		}
	}
	check(healthpb.HealthCheckResponse_NOT_SERVING)
	if checks != 0 {
		t.Fatal("storage check ran while server was unready")
	}
	ready.Store(true)
	check(healthpb.HealthCheckResponse_SERVING)
	storageErr = errors.New("storage unavailable")
	check(healthpb.HealthCheckResponse_NOT_SERVING)
	storageErr = nil
	check(healthpb.HealthCheckResponse_SERVING)
	if _, err := server.Check(t.Context(), &healthpb.HealthCheckRequest{Service: "unrelated"}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown service: %v", err)
	}
}
