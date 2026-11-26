package main

import (
	"context"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type presencePeerFinder interface {
	ListPresencePeers(ctx context.Context, requesterID string) ([]string, error)
}

func (s *historyGRPC) ListPresencePeers(ctx context.Context, request *historyv1.ListPresencePeersRequest) (*historyv1.ListPresencePeersResponse, error) {
	if !chats.ValidRPCID(request.GetRequesterId()) {
		return nil, status.Error(codes.InvalidArgument, "invalid UUID")
	}
	ids, err := s.presence.ListPresencePeers(ctx, request.GetRequesterId())
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &historyv1.ListPresencePeersResponse{UserIds: ids}, nil
}
