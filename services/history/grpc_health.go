package main

import (
	"context"
	"sync/atomic"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc/codes"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

// historyHealth exposes the same storage readiness over History's private gRPC listener.
type historyHealth struct {
	healthpb.UnimplementedHealthServer
	ready *atomic.Bool
	check func(context.Context) error
}

func (h *historyHealth) Check(ctx context.Context, req *healthpb.HealthCheckRequest) (*healthpb.HealthCheckResponse, error) {
	switch req.GetService() {
	case "", historyv1.HistoryService_ServiceDesc.ServiceName:
	default:
		return nil, status.Error(codes.NotFound, "unknown service")
	}
	result := &healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_NOT_SERVING}
	if h.ready.Load() {
		checkCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if h.check(checkCtx) == nil && checkCtx.Err() == nil && h.ready.Load() {
			result.Status = healthpb.HealthCheckResponse_SERVING
		}
	}
	return result, nil
}
