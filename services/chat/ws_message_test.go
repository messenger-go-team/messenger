package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	sendTestClientID  = "30000000-0000-4000-8000-00000000001a"
	sendTestMessageID = "40000000-0000-4000-8000-00000000001a"
)

type messageTestServer struct {
	membershipTestServer
	save func(context.Context, *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error)
}

func (s messageTestServer) SaveMessage(ctx context.Context, r *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
	return s.save(ctx, r)
}

func sendTestMessage(t *testing.T, conn *websocket.Conn, id, clientID, body string) {
	t.Helper()
	event := newWSEnvelope(wsSendType, id, map[string]string{
		"chat_id": strings.ToUpper(fanoutChat), "client_msg_id": clientID, "body": body,
	})
	if err := conn.WriteJSON(event); err != nil {
		t.Fatal(err)
	}
}

func readTestEvent(t *testing.T, conn *websocket.Conn, want string, payload any) string {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	kind, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Type    string          `json:"type"`
		ID      string          `json:"id"`
		TS      time.Time       `json:"ts"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	if kind != websocket.TextMessage || envelope.Type != want ||
		!validWSUUID(envelope.ID) || envelope.TS.IsZero() {
		t.Fatalf("unexpected frame %d: %s; want %s", kind, data, want)
	}
	if err := json.Unmarshal(envelope.Payload, payload); err != nil {
		t.Fatal(err)
	}
	return envelope.ID
}

func readTestSendError(t *testing.T, conn *websocket.Conn, id, code string, retryable bool) wsErrorPayload {
	t.Helper()
	var problem wsErrorPayload
	gotID := readTestEvent(t, conn, "error", &problem)
	if gotID != id || problem.Code != code || problem.Retryable != retryable ||
		problem.RequestType == nil || *problem.RequestType != wsSendType ||
		problem.ClientMsgID == nil || *problem.ClientMsgID != sendTestClientID {
		t.Fatalf("error envelope %s %#v, want %s/%s retryable=%v", gotID, problem, id, code, retryable)
	}
	if strings.Contains(problem.Message, "private test detail") {
		t.Fatal("raw gRPC error text reached the WebSocket client")
	}
	return problem
}

func TestWSMessageSendAndRetry(t *testing.T) {
	const body = "  Привет 👋\n"
	created := time.Date(2026, 11, 20, 9, 30, 0, 0, time.UTC)
	entered, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	t.Cleanup(unblock)
	var saves, lookups atomic.Int32
	history := startTestHistoryRPC(t, messageTestServer{
		membershipTestServer: membershipTestServer{members: func(_ context.Context, r *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			lookups.Add(1)
			if r.GetChatId() != fanoutChat || r.GetRequesterId() != fanoutAlice {
				t.Errorf("wrong fanout request: %v", r)
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		save: func(ctx context.Context, r *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			call := saves.Add(1)
			if r.GetChatId() != fanoutChat || r.GetClientMsgId() != sendTestClientID {
				t.Errorf("wrong save request: %v", r)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Error("SaveMessage has no deadline")
			}
			if r.GetSenderId() == fanoutCarol {
				return nil, status.Error(codes.PermissionDenied, "private test detail")
			}
			if r.GetSenderId() != fanoutAlice {
				t.Errorf("wrong sender: %s", r.GetSenderId())
			}
			switch r.GetBody() {
			case "storage unavailable":
				return nil, status.Error(codes.Unavailable, "private test detail")
			case body:
				if call == 1 {
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
						return nil, status.FromContextError(ctx.Err()).Err()
					}
				}
				return &historyv1.SaveMessageResponse{
					MessageId: sendTestMessageID, Seq: 42, CreatedAt: timestamppb.New(created),
					Duplicate: call != 1,
				}, nil
			default:
				return nil, status.Error(codes.AlreadyExists, "private test detail")
			}
		},
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	aliceTab, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	carol, _ := dialTestUser(t, url, fanoutCarol)
	waitForConnections(t, ws, 4)

	invalidID := newWSEventID()
	sendTestMessage(t, alice, invalidID, sendTestClientID, "a\x00b")
	readTestSendError(t, alice, invalidID, "invalid_payload", false)
	if saves.Load() != 0 {
		t.Fatal("invalid body reached History")
	}

	firstID := newWSEventID()
	sendTestMessage(t, alice, firstID, strings.ToUpper(sendTestClientID), body)
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("SaveMessage was not called")
	}
	for _, client := range []struct {
		user string
		conn *websocket.Conn
	}{{fanoutAlice, alice}, {fanoutBob, bob}, {fanoutCarol, carol}} {
		assertNoBroadcast(t, ws, client.user, client.conn)
	}
	assertTextFrame(t, aliceTab, `{"marker":true}`)
	unblock()

	var ack wsAckPayload
	gotID := readTestEvent(t, alice, "message.ack", &ack)
	if gotID != firstID || ack.MessageID != sendTestMessageID || ack.Seq != 42 ||
		ack.ChatID != fanoutChat || ack.ClientMsgID != sendTestClientID || !ack.CreatedAt.Equal(created) {
		t.Fatalf("wrong ack: %s %#v", gotID, ack)
	}
	var newID string
	for _, conn := range []*websocket.Conn{alice, aliceTab, bob} {
		var event wsNewPayload
		id := readTestEvent(t, conn, "message.new", &event)
		if newID == "" {
			newID = id
		}
		if id == firstID || id != newID || event.wsAckPayload != ack ||
			event.SenderID != fanoutAlice || event.Body != body {
			t.Fatalf("wrong fanout event: %s %#v", id, event)
		}
	}
	assertNoBroadcast(t, ws, fanoutCarol, carol)

	retryID := newWSEventID()
	sendTestMessage(t, alice, retryID, sendTestClientID, body)
	var retry wsAckPayload
	if id := readTestEvent(t, alice, "message.ack", &retry); id != retryID || retry != ack {
		t.Fatalf("retry ack differs: %s %#v; original %#v", id, retry, ack)
	}

	conflictID := newWSEventID()
	sendTestMessage(t, alice, conflictID, sendTestClientID, "different text")
	readTestSendError(t, alice, conflictID, "idempotency_conflict", false)
	assertNoBroadcast(t, ws, fanoutAlice, alice)
	assertTextFrame(t, aliceTab, `{"marker":true}`)
	assertNoBroadcast(t, ws, fanoutBob, bob)

	forbiddenID := newWSEventID()
	sendTestMessage(t, carol, forbiddenID, sendTestClientID, body)
	readTestSendError(t, carol, forbiddenID, "forbidden", false)

	unavailableID := newWSEventID()
	sendTestMessage(t, alice, unavailableID, sendTestClientID, "storage unavailable")
	readTestSendError(t, alice, unavailableID, "temporarily_unavailable", true)
	if saves.Load() != 5 || lookups.Load() != 1 {
		t.Fatalf("want 5 SaveMessage calls and 1 GetChatMembers call, got %d and %d", saves.Load(), lookups.Load())
	}
}

func TestWSMessageSendKeepsHeartbeatAlive(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var lookups atomic.Int32
	history := startTestHistoryRPC(t, messageTestServer{
		membershipTestServer: membershipTestServer{members: func(context.Context, *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			lookups.Add(1)
			return nil, status.Error(codes.Unavailable, "private test detail")
		}},
		save: func(ctx context.Context, _ *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			close(entered)
			select {
			case <-release:
				return &historyv1.SaveMessageResponse{
					MessageId: sendTestMessageID, Seq: 1, CreatedAt: timestamppb.Now(),
				}, nil
			case <-ctx.Done():
				return nil, status.FromContextError(ctx.Err()).Err()
			}
		},
	})
	timing := wsTiming{
		pingInterval: 100 * time.Millisecond,
		pongTimeout:  time.Second,
		writeTimeout: time.Second,
	}
	ws, url := startTestWSEndpoint(t, timing, history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	waitForConnections(t, ws, 1)
	pongs := 0
	pong := alice.PingHandler()
	alice.SetPingHandler(func(payload string) error {
		if err := pong(payload); err != nil {
			return err
		}
		pongs++
		if pongs == 2 {
			close(release)
		}
		return nil
	})

	id := newWSEventID()
	sendTestMessage(t, alice, id, sendTestClientID, "heartbeat")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("SaveMessage was not called")
	}
	var ack wsAckPayload
	if gotID := readTestEvent(t, alice, "message.ack", &ack); gotID != id ||
		pongs < 2 || ack.MessageID != sendTestMessageID || ack.Seq != 1 {
		t.Fatalf("wrong ack after heartbeat: %s, %#v, pongs=%d", gotID, ack, pongs)
	}
	invalidID := newWSEventID()
	sendTestMessage(t, alice, invalidID, sendTestClientID, "")
	readTestSendError(t, alice, invalidID, "invalid_payload", false)
	if lookups.Load() != 1 {
		t.Fatalf("want a single fanout attempt, got %d", lookups.Load())
	}
}

func TestWSMessageFanoutSurvivesSenderDisconnect(t *testing.T) {
	lookupStarted, releaseLookup := make(chan struct{}), make(chan struct{})
	history := startTestHistoryRPC(t, messageTestServer{
		membershipTestServer: membershipTestServer{members: func(ctx context.Context, _ *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			close(lookupStarted)
			select {
			case <-releaseLookup:
				return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
			case <-ctx.Done():
				return nil, status.FromContextError(ctx.Err()).Err()
			}
		}},
		save: func(context.Context, *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			return &historyv1.SaveMessageResponse{
				MessageId: sendTestMessageID, Seq: 1, CreatedAt: timestamppb.Now(),
			}, nil
		},
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	waitForConnections(t, ws, 2)

	const body = "deliver after sender disconnects"
	id := newWSEventID()
	sendTestMessage(t, alice, id, sendTestClientID, body)
	var ack wsAckPayload
	if got := readTestEvent(t, alice, "message.ack", &ack); got != id || ack.MessageID != sendTestMessageID {
		t.Fatalf("unexpected ack: %s %#v", got, ack)
	}
	select {
	case <-lookupStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("membership RPC did not start")
	}
	if err := alice.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	assertSocketClose(t, alice, websocket.CloseNormalClosure)
	// The server closes the transport after canceling Alice's socket context.
	// Wait for that close before allowing the membership RPC to finish.
	var remaining [1]byte
	if _, err := alice.NetConn().Read(remaining[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("expected sender transport EOF, got %v", err)
	}
	close(releaseLookup)

	var event wsNewPayload
	readTestEvent(t, bob, "message.new", &event)
	if event.wsAckPayload != ack || event.SenderID != fanoutAlice || event.Body != body {
		t.Fatalf("wrong fanout event after sender disconnect: %#v", event)
	}
}

func TestWSCommandValidation(t *testing.T) {
	const id = "10000000-0000-4000-8000-000000000001"
	const prefix = `{"type":"message.send","id":"` + id +
		`","ts":"2026-11-20T09:30:00Z","payload":{"chat_id":"` + fanoutChat +
		`","client_msg_id":"` + sendTestClientID + `","body":`
	command := func(bodyJSON string) string { return prefix + bodyJSON + "}}" }
	valid := command(`"hello"`)
	for _, tt := range []struct {
		name, raw, code, body string
		correlated            bool
	}{
		{"explicit NUL", command(`"a\u0000b"`), "invalid_payload", "", true},
		{"literal slash", command(`"a\\u0000b"`), "", `a\u0000b`, true},
		{"surrogate pair", command(`"\ud83d\udc4b"`), "", "👋", true},
		{"unpaired high", command(`"\ud83d"`), "invalid_payload", "", true},
		{"unpaired low", command(`"\udc4b"`), "invalid_payload", "", true},
		{"replacement rune", command(`"\ufffd"`), "", "�", true},
		{"unicode spaces only", command(`"\u2003\n\t"`), "invalid_payload", "", true},
		{"text limit", command(`"` + strings.Repeat("🙂", 4096) + `"`), "", strings.Repeat("🙂", 4096), true},
		{"too many runes", command(`"` + strings.Repeat("🙂", 4097) + `"`), "invalid_payload", "", true},
		{"invalid datetime", strings.Replace(valid, "09:30:00Z", "09:30:00+03:00", 1), "invalid_payload", "", true},
		{"single-digit hour", strings.Replace(valid, "09:30:00Z", "9:30:00Z", 1), "invalid_payload", "", true},
		{"fraction with comma", strings.Replace(valid, "09:30:00Z", "09:30:00,1Z", 1), "invalid_payload", "", true},
		{"fraction with period", strings.Replace(valid, "09:30:00Z", "09:30:00.1Z", 1), "", "hello", true},
		{"UTC offset", strings.Replace(valid, "09:30:00Z", "09:30:00+00:00", 1), "", "hello", true},
		{"lowercase datetime", strings.Replace(valid, "T09:30:00Z", "t09:30:00z", 1), "", "hello", true},
		{"duplicate timestamp", strings.Replace(valid, `"payload":`, `"ts":"2026-11-20T09:30:01Z","payload":`, 1), "invalid_payload", "", true},
		{"duplicate envelope id", strings.Replace(valid, `"payload":`, `"id":"`+id+`","payload":`, 1), "invalid_payload", "", false},
		{"incorrect field casing", strings.Replace(valid, "chat_id", "Chat_ID", 1), "invalid_payload", "", true},
		{"server-only field", prefix + `"hello","sender_id":"ignored"}}`, "invalid_payload", "", true},
		{"duplicate body", prefix + `"hello","body":"again"}}`, "invalid_payload", "", true},
		{"unsupported", strings.Replace(valid, wsSendType, "message.read", 1), "unsupported_type", "", true},
		{"second object", valid + `{}`, "invalid_json", "", false},
		{"not an object", `[]`, "invalid_json", "", false},
		{"syntax", `{"type":`, "invalid_json", "", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd, problem := parseWSCommand([]byte(tt.raw))
			if problem != tt.code {
				t.Fatalf("got %q, want %q", problem, tt.code)
			}
			wantID := ""
			if tt.correlated {
				wantID = id
			}
			if cmd.id != wantID {
				t.Fatalf("correlation id %q, want %q", cmd.id, wantID)
			}
			if problem == "" && cmd.body != tt.body {
				t.Fatal("decoded body changed")
			}
		})
	}
}
