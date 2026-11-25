package main

import (
	"context"
	"errors"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type receiptAdvancer interface {
	AdvanceReceipt(ctx context.Context, chat, actor string, seq int64, markRead bool) (reading.PublicCursors, bool, error)
}

func (s *historyGRPC) AdvanceReceipt(ctx context.Context, r *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
	if r == nil || r.Seq == nil || !chats.ValidRPCID(r.ChatId) || !chats.ValidRPCID(r.ActorId) {
		return nil, status.Error(codes.InvalidArgument, "invalid receipt")
	}
	if r.Kind != historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED && r.Kind != historyv1.ReceiptKind_RECEIPT_KIND_READ {
		return nil, status.Error(codes.InvalidArgument, "invalid receipt kind")
	}
	if s.receipts == nil {
		return nil, status.Error(codes.Unavailable, "receipt storage unavailable")
	}
	cursors, advanced, err := s.receipts.AdvanceReceipt(ctx, r.ChatId, r.ActorId, *r.Seq, r.Kind == historyv1.ReceiptKind_RECEIPT_KIND_READ)
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		switch {
		case errors.Is(err, reading.ErrReceiptChatType):
			return nil, status.Error(codes.FailedPrecondition, "receipts require a personal chat")
		case errors.Is(err, reading.ErrReceiptSeq):
			return nil, status.Error(codes.OutOfRange, "receipt sequence out of range")
		default:
			return nil, rpcError(ctx, err)
		}
	}
	return &historyv1.AdvanceReceiptResponse{
		LastDeliveredSeq: cursors.Delivered, LastReadSeq: cursors.Read, DeliveredAdvanced: advanced,
	}, nil
}
