package main

import (
	"context"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type presenceRepository interface {
	ListPresencePeers(ctx context.Context, requesterID string) ([]string, error)
	AuthorizePresenceDelivery(ctx context.Context, requesterID string, peerIDs []string) ([]string, error)
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

func (s *historyGRPC) AuthorizePresenceDelivery(ctx context.Context, request *historyv1.AuthorizePresenceDeliveryRequest) (*historyv1.AuthorizePresenceDeliveryResponse, error) {
	requesterID, ids := request.GetRequesterId(), request.GetUserIds()
	if !chats.ValidRPCID(requesterID) || len(ids) == 0 || len(ids) > 128 {
		return nil, status.Error(codes.InvalidArgument, "invalid presence delivery request")
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate || !chats.ValidRPCID(id) || id == requesterID {
			return nil, status.Error(codes.InvalidArgument, "invalid presence peer UUID")
		}
		seen[id] = struct{}{}
	}
	allowed, err := s.presence.AuthorizePresenceDelivery(ctx, requesterID, ids)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &historyv1.AuthorizePresenceDeliveryResponse{UserIds: allowed}, nil
}
