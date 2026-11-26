package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Membership and message handlers share the generated HistoryService registration.
type historyGRPC struct {
	historyv1.UnimplementedHistoryServiceServer
	repo     chats.Repository
	presence presenceRepository
	messages messageSaver
	receipts receiptAdvancer
}

func (s *historyGRPC) GetChatMembers(ctx context.Context, r *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
	if r == nil || !chats.ValidRPCID(r.ChatId) || !chats.ValidRPCID(r.RequesterId) {
		return nil, status.Error(codes.InvalidArgument, "invalid UUID")
	}
	ids, err := s.repo.Members(ctx, r.ChatId, r.RequesterId)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &historyv1.GetChatMembersResponse{UserIds: ids}, nil
}
func (s *historyGRPC) CheckMembership(ctx context.Context, r *historyv1.CheckMembershipRequest) (*historyv1.CheckMembershipResponse, error) {
	if r == nil || !chats.ValidRPCID(r.ChatId) || !chats.ValidRPCID(r.UserId) {
		return nil, status.Error(codes.InvalidArgument, "invalid UUID")
	}
	member, err := s.repo.Membership(ctx, r.ChatId, r.UserId)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &historyv1.CheckMembershipResponse{IsMember: member}, nil
}
func rpcError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return status.FromContextError(ctx.Err()).Err()
	}
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return status.FromContextError(err).Err()
	case errors.Is(err, chats.ErrNotFound):
		return status.Error(codes.NotFound, "chat not found")
	case errors.Is(err, chats.ErrForbidden):
		return status.Error(codes.PermissionDenied, "chat membership required")
	default:
		loggerFromContext(ctx).ErrorContext(ctx, "history RPC failed")
		return status.Error(codes.Unavailable, "history unavailable")
	}
}
func rpcLogging(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (response any, err error) {
		id := ""
		if md, ok := metadata.FromIncomingContext(ctx); ok {
			if values := md.Get("x-request-id"); len(values) == 1 {
				id = values[0]
			}
		}
		if !validRequestID.MatchString(id) {
			id = rand.Text()
		}
		requestLogger := logger.With("request_id", id)
		ctx = context.WithValue(ctx, requestLoggerKey{}, requestLogger)
		_ = grpc.SetHeader(ctx, metadata.Pairs("x-request-id", id))
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		start := time.Now()
		defer func() {
			if recover() != nil {
				requestLogger.ErrorContext(ctx, "RPC panic recovered")
				response = nil
				err = status.Error(codes.Internal, "internal error")
			}
			level := slog.LevelInfo
			if err == nil && (info.FullMethod == historyv1.HistoryService_ListPresencePeers_FullMethodName ||
				info.FullMethod == historyv1.HistoryService_AuthorizePresenceDelivery_FullMethodName) {
				// Healthy polling is visible in RPC metrics without a log per refresh.
				level = slog.LevelDebug
			}
			requestLogger.Log(ctx, level, "grpc request", "method", info.FullMethod, "code", status.Code(err).String(), "duration_ms", time.Since(start).Milliseconds())
		}()
		return handler(ctx, req)
	}
}
