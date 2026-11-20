package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const wsMaxMessageSeq int64 = 9007199254740991

type wsEnvelope struct {
	Type    string    `json:"type"`
	ID      string    `json:"id"`
	TS      time.Time `json:"ts"`
	Payload any       `json:"payload"`
}

type wsAckPayload struct {
	ChatID      string    `json:"chat_id"`
	ClientMsgID string    `json:"client_msg_id"`
	MessageID   string    `json:"message_id"`
	Seq         int64     `json:"seq"`
	CreatedAt   time.Time `json:"created_at"`
}

type wsNewPayload struct {
	wsAckPayload
	SenderID string `json:"sender_id"`
	Body     string `json:"body"`
}

type wsErrorPayload struct {
	Code        string  `json:"code"`
	Message     string  `json:"message"`
	Retryable   bool    `json:"retryable"`
	RequestType *string `json:"request_type"`
	ClientMsgID *string `json:"client_msg_id"`
}

func (ws *wsEndpoint) handleWSCommand(ctx context.Context, socket *socketSession, data []byte) {
	cmd, problem := parseWSCommand(data)
	if problem != "" {
		ws.replyWSError(socket, cmd, problem)
		return
	}
	if ws.history == nil {
		ws.replyWSError(socket, cmd, "temporarily_unavailable")
		return
	}

	rpcCtx, cancel := context.WithTimeout(ctx, ws.historyTimeout)
	saved, err := ws.history.SaveMessage(rpcCtx, &historyv1.SaveMessageRequest{
		ChatId:      cmd.chatID,
		SenderId:    socket.userID,
		ClientMsgId: cmd.clientMsgID,
		Body:        cmd.body,
	})
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		rpcCode := status.Code(err)
		code := saveWSErrorCode(rpcCode)
		if code == "internal_error" {
			ws.logger.Warn("history rejected message save", "grpc_code", rpcCode.String())
		}
		ws.replyWSError(socket, cmd, code)
		return
	}

	created := saved.GetCreatedAt()
	seq := saved.GetSeq()
	if !validWSUUID(saved.GetMessageId()) || seq < 1 || seq > wsMaxMessageSeq ||
		created == nil || created.CheckValid() != nil {
		ws.logger.Warn("history returned invalid saved message metadata")
		ws.replyWSError(socket, cmd, "internal_error")
		return
	}

	ack := wsAckPayload{
		ChatID:      cmd.chatID,
		ClientMsgID: cmd.clientMsgID,
		MessageID:   strings.ToLower(saved.GetMessageId()),
		Seq:         seq,
		CreatedAt:   created.AsTime().UTC(),
	}
	ws.replyWSEvent(socket, newWSEnvelope("message.ack", cmd.id, ack))
	if saved.GetDuplicate() {
		return
	}

	event := newWSEnvelope("message.new", newWSEventID(), wsNewPayload{
		wsAckPayload: ack,
		SenderID:     socket.userID,
		Body:         cmd.body,
	})
	data, err = json.Marshal(event)
	if err != nil {
		ws.logger.Warn("could not encode message.new")
		return
	}
	if err := ws.broadcastChat(ctx, jwtauth.Identity{UserID: socket.userID}, cmd.chatID, data); err != nil && ctx.Err() == nil {
		ws.logger.Warn("saved message fanout failed")
	}
}

func saveWSErrorCode(code codes.Code) string {
	switch code {
	case codes.InvalidArgument:
		return "invalid_payload"
	case codes.NotFound, codes.PermissionDenied:
		return "forbidden"
	case codes.AlreadyExists:
		return "idempotency_conflict"
	case codes.ResourceExhausted:
		return "rate_limited"
	case codes.Canceled, codes.DeadlineExceeded, codes.Unavailable:
		return "temporarily_unavailable"
	default:
		return "internal_error"
	}
}

func (ws *wsEndpoint) replyWSError(socket *socketSession, cmd wsCommand, code string) {
	payload := wsErrorPayload{Code: code}
	if cmd.kind != "" {
		payload.RequestType = &cmd.kind
	}
	if cmd.clientMsgID != "" {
		payload.ClientMsgID = &cmd.clientMsgID
	}
	switch code {
	case "invalid_json":
		payload.Message = "Ожидается один JSON-объект."
	case "invalid_payload":
		payload.Message = "Некорректные поля команды."
	case "unsupported_type":
		payload.Message = "Команда не поддерживается."
	case "forbidden":
		payload.Message = "Нет доступа к чату."
	case "idempotency_conflict":
		payload.Message = "Этот идентификатор уже использован с другим текстом."
	case "rate_limited":
		payload.Message = "Сервис перегружен. Повторите позже."
		payload.Retryable = true
	case "temporarily_unavailable":
		payload.Message = "Не удалось подтвердить сохранение. Повторите позже."
		payload.Retryable = true
	default:
		payload.Message = "Внутренняя ошибка. Повторите позже."
		payload.Retryable = true
	}

	id := cmd.id
	if id == "" {
		id = newWSEventID()
	}
	ws.replyWSEvent(socket, newWSEnvelope("error", id, payload))
}

func newWSEnvelope(kind, id string, payload any) wsEnvelope {
	return wsEnvelope{Type: kind, ID: id, TS: time.Now().UTC(), Payload: payload}
}

func newWSEventID() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func (ws *wsEndpoint) replyWSEvent(socket *socketSession, event wsEnvelope) {
	data, err := json.Marshal(event)
	if len(data) > wsMaxMessageBytes {
		if problem, ok := event.Payload.(wsErrorPayload); ok {
			problem.RequestType = nil
			event.Payload = problem
			data, err = json.Marshal(event)
		}
	}
	if err != nil || len(data) > wsMaxMessageBytes {
		ws.logger.Warn("could not encode WebSocket reply")
		return
	}
	ws.hub.mu.Lock()
	defer ws.hub.mu.Unlock()
	if !ws.hub.closed && time.Now().Before(socket.expiresAt) {
		socket.enqueue(data)
	}
}
