package main

import (
	"context"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type presenceRepository interface {
	ListPresencePeers(ctx context.Context, requesterID string) ([]string, error)
	AuthorizePresenceDelivery(ctx context.Context, requesterID string, peerIDs []string) ([]string, string, error)
	ReleasePresenceDeliveries(ctx context.Context, ids []string) error
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
	allowed, grantID, err := s.presence.AuthorizePresenceDelivery(ctx, requesterID, ids)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &historyv1.AuthorizePresenceDeliveryResponse{UserIds: allowed, GrantId: grantID}, nil
}

func (s *historyGRPC) BatchPresence(ctx context.Context, request *historyv1.BatchPresenceRequest) (*historyv1.BatchPresenceResponse, error) {
	ops, released := request.GetOperations(), request.GetReleasedGrantIds()
	if len(ops) > 32 || len(released) > 128 {
		return nil, status.Error(codes.InvalidArgument, "presence batch is too large")
	}
	for _, id := range released {
		if !chats.ValidRPCID(id) {
			return nil, status.Error(codes.InvalidArgument, "invalid presence grant UUID")
		}
	}
	if len(released) != 0 {
		if err := s.presence.ReleasePresenceDeliveries(ctx, released); err != nil {
			return nil, rpcError(ctx, err)
		}
	}
	results := make([]*historyv1.PresenceResult, 0, len(ops))
	for _, op := range ops {
		result := &historyv1.PresenceResult{Response: &historyv1.PresenceResult_Failed{Failed: true}}
		switch r := op.GetRequest().(type) {
		case *historyv1.PresenceOperation_List:
			if out, err := s.ListPresencePeers(ctx, r.List); err == nil {
				result.Response = &historyv1.PresenceResult_List{List: out}
			}
		case *historyv1.PresenceOperation_Authorize:
			if out, err := s.AuthorizePresenceDelivery(ctx, r.Authorize); err == nil {
				result.Response = &historyv1.PresenceResult_Authorize{Authorize: out}
			}
		}
		results = append(results, result)
	}
	return &historyv1.BatchPresenceResponse{Results: results}, nil
}

type presenceGrantStore interface {
	ActivePresenceGrants(ctx context.Context) ([]string, error)
	ReleasePresenceDeliveries(ctx context.Context, ids []string) error
}

// A captured grant was already committed before the delay started. Its
// sender's window has elapsed by the time it can be reaped. The database
// and service don't need synchronized wall clocks to make this decision.
func reapPresenceGrants(ctx context.Context, store presenceGrantStore) {
	const hold = 12 * time.Second
	timer := time.NewTimer(hold)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ids, err := store.ActivePresenceGrants(queryCtx)
		cancel()
		if err == nil && len(ids) != 0 {
			timer.Reset(hold)
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			queryCtx, cancel = context.WithTimeout(ctx, 3*time.Second)
			_ = store.ReleasePresenceDeliveries(queryCtx, ids)
			cancel()
		}
		timer.Reset(hold)
	}
}
