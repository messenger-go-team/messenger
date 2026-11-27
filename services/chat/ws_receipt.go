package main

import (
	"context"
	"encoding/json"
	"strings"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type wsReceiptPayload struct {
	ChatID string `json:"chat_id"`
	UserID string `json:"user_id"`
	Seq    int64  `json:"seq"`
}

func (ws *wsEndpoint) handleWSReceipt(ctx context.Context, socket *socketSession, cmd wsCommand) {
	if ws.history == nil {
		ws.replyWSError(socket, cmd, "temporarily_unavailable")
		return
	}
	kind := historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED
	if cmd.kind == wsReadType {
		kind = historyv1.ReceiptKind_RECEIPT_KIND_READ
	}

	rpcCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	receipt, err := ws.history.AdvanceReceipt(rpcCtx, &historyv1.AdvanceReceiptRequest{
		ChatId: cmd.chatID, ActorId: socket.userID, Kind: kind, Seq: &cmd.seq,
	})
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			code := receiptWSErrorCode(err)
			if code == "internal_error" {
				ws.logger.Warn("history rejected receipt", "grpc_code", status.Code(err).String())
			}
			ws.replyWSError(socket, cmd, code)
		}
		return
	}
	if !validReceiptResult(cmd, receipt) {
		ws.logger.Warn("history returned invalid receipt cursors")
		if ctx.Err() == nil {
			ws.replyWSError(socket, cmd, "internal_error")
		}
		return
	}

	// Fanout of a committed receipt can continue after the initiating socket closes.
	if err := ws.broadcastReceipt(cmd, socket.userID, receipt); err != nil && ws.fanoutCtx.Err() == nil {
		ws.logger.Warn("committed receipt fanout failed", "grpc_code", status.Code(err).String())
		if ctx.Err() == nil {
			ws.replyWSError(socket, cmd, receiptWSErrorCode(err))
		}
	}
}

func validReceiptResult(cmd wsCommand, receipt *historyv1.AdvanceReceiptResponse) bool {
	if receipt == nil {
		return false
	}
	delivered, read := receipt.GetLastDeliveredSeq(), receipt.GetLastReadSeq()
	if read < 0 || read > delivered || delivered > wsMaxMessageSeq || delivered < cmd.seq {
		return false
	}
	// An increase sets delivered to the requested seq; zero cannot advance it.
	if receipt.GetDeliveredAdvanced() && (cmd.seq == 0 || delivered != cmd.seq) {
		return false
	}
	return cmd.kind != wsReadType || read >= cmd.seq
}

func (ws *wsEndpoint) broadcastReceipt(cmd wsCommand, actor string, receipt *historyv1.AdvanceReceiptResponse) error {
	ctx, cancel := context.WithTimeout(ws.fanoutCtx, ws.historyTimeout)
	defer cancel()
	members, err := ws.chatMembers(ctx, cmd.chatID, actor)
	if err != nil {
		return err
	}
	if len(members) != 2 || members[0] == members[1] || (members[0] != actor && members[1] != actor) {
		return status.Error(codes.Internal, "expected two current members including the actor")
	}
	for _, id := range members {
		if !validWSUUID(id) || id != strings.ToLower(id) {
			return status.Error(codes.Internal, "invalid receipt recipient")
		}
	}

	payload := wsReceiptPayload{ChatID: cmd.chatID, UserID: actor, Seq: receipt.GetLastDeliveredSeq()}
	if cmd.kind == wsReadType {
		if receipt.GetDeliveredAdvanced() {
			if err := ws.publishReceiptEvent(ctx, members, wsDeliveredType, payload); err != nil {
				return err
			}
		}
		payload.Seq = receipt.GetLastReadSeq()
	}
	return ws.publishReceiptEvent(ctx, members, cmd.kind, payload)
}

func (ws *wsEndpoint) publishReceiptEvent(ctx context.Context, members []string, kind string, payload wsReceiptPayload) error {
	data, err := json.Marshal(newWSEnvelope(kind, newWSEventID(), payload))
	if err != nil {
		return err
	}
	return ws.broker.Publish(ctx, members, data)
}

func receiptWSErrorCode(err error) string {
	code := status.Code(err)
	if code == codes.Unknown {
		code = status.FromContextError(err).Code()
	}
	switch code {
	case codes.InvalidArgument:
		return "invalid_payload"
	case codes.OutOfRange:
		return "invalid_seq"
	case codes.NotFound, codes.PermissionDenied:
		return "forbidden"
	case codes.FailedPrecondition:
		return "unsupported_type"
	case codes.Unavailable, codes.DeadlineExceeded, codes.Canceled, codes.Unimplemented:
		return "temporarily_unavailable"
	default:
		return "internal_error"
	}
}
