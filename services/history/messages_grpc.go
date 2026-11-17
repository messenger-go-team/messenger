package main

import (
	"context"
	"errors"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type messageSaver interface {
	Save(context.Context, messages.Input) (messages.Saved, error)
}

func (s *historyGRPC) SaveMessage(ctx context.Context, r *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
	if r == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid message")
	}
	in := messages.Input{ChatID: r.ChatId, SenderID: r.SenderId, ClientID: r.ClientMsgId, Body: r.Body}
	if err := messages.Validate(in); err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid message")
	}
	if s.messages == nil {
		return nil, status.Error(codes.Unavailable, "message storage unavailable")
	}
	saved, err := s.messages.Save(ctx, in)
	if err != nil {
		// Cancellation takes precedence over a storage diagnostic.
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		switch {
		case errors.Is(err, messages.ErrInvalid):
			return nil, status.Error(codes.InvalidArgument, "invalid message")
		case errors.Is(err, messages.ErrChatNotFound):
			return nil, status.Error(codes.NotFound, "chat not found")
		case errors.Is(err, messages.ErrNotMember):
			return nil, status.Error(codes.PermissionDenied, "chat membership required")
		case errors.Is(err, messages.ErrConflict):
			return nil, status.Error(codes.AlreadyExists, "idempotency conflict")
		case errors.Is(err, messages.ErrSeqExhausted):
			return nil, status.Error(codes.OutOfRange, "chat sequence exhausted")
		default:
			return nil, rpcError(ctx, err)
		}
	}
	timestamp := timestamppb.New(saved.CreatedAt)
	if !chats.ValidRPCID(saved.ID) || saved.Seq < 1 || saved.Seq > messages.MaxSeq || timestamp.CheckValid() != nil {
		return nil, status.Error(codes.DataLoss, "invalid stored message metadata")
	}
	return &historyv1.SaveMessageResponse{MessageId: saved.ID, Seq: saved.Seq, CreatedAt: timestamp, Duplicate: saved.Duplicate}, nil
}
