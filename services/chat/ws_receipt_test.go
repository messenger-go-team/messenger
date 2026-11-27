package main

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestWSReceiptCommandValidation(t *testing.T) {
	id := newWSEventID()
	const chatField = `"chat_id":"` + fanoutChat + `"`
	for _, tt := range []struct {
		name, fields, problem string
		seq                   int64
	}{
		{"zero", chatField + `,"seq":0`, "", 0},
		{"uppercase chat UUID", `"chat_id":"` + strings.ToUpper(fanoutChat) + `","seq":42`, "", 42},
		{"safe maximum", chatField + `,"seq":9007199254740991`, "", wsMaxMessageSeq},
		{"negative", chatField + `,"seq":-1`, "invalid_seq", 0},
		{"above safe maximum", chatField + `,"seq":9007199254740992`, "invalid_seq", 0},
		{"overflow", chatField + `,"seq":9223372036854775808`, "invalid_seq", 0},
		{"underflow", chatField + `,"seq":-9223372036854775809`, "invalid_seq", 0},
		{"missing seq", chatField, "invalid_payload", 0},
		{"missing chat", `"seq":3`, "invalid_payload", 0},
		{"zero chat UUID", `"chat_id":"00000000-0000-0000-0000-000000000000","seq":3`, "invalid_payload", 0},
		{"null", chatField + `,"seq":null`, "invalid_payload", 0},
		{"decimal", chatField + `,"seq":42.0`, "invalid_payload", 0},
		{"exponent", chatField + `,"seq":42e0`, "invalid_payload", 0},
		{"quoted", chatField + `,"seq":"42"`, "invalid_payload", 0},
		{"boolean", chatField + `,"seq":true`, "invalid_payload", 0},
		{"object", chatField + `,"seq":{}`, "invalid_payload", 0},
		{"duplicate", chatField + `,"seq":1,"seq":2`, "invalid_payload", 0},
		{"unexpected field", chatField + `,"seq":1,"client_msg_id":"` + sendTestClientID + `"`, "invalid_payload", 0},
		{"actor in payload", chatField + `,"seq":1,"actor_id":"` + fanoutBob + `"`, "invalid_payload", 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			for _, kind := range []string{wsDeliveredType, wsReadType} {
				raw := fmt.Sprintf(`{"type":%q,"id":%q,"ts":"2026-11-26T10:00:00Z","payload":{%s}}`, kind, id, tt.fields)
				cmd, problem := parseWSCommand([]byte(raw))
				if problem != tt.problem || cmd.kind != kind || cmd.id != id || cmd.clientMsgID != "" {
					t.Fatalf("%s: got %+v, problem %q; want problem %q", kind, cmd, problem, tt.problem)
				}
				if problem == "" && (cmd.chatID != fanoutChat || cmd.seq != tt.seq) {
					t.Fatalf("%s: got %s/%d; want %s/%d", kind, cmd.chatID, cmd.seq, fanoutChat, tt.seq)
				}
			}
		})
	}
}

const (
	testReceiptDelivered = historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED
	testReceiptRead      = historyv1.ReceiptKind_RECEIPT_KIND_READ
)

type receiptTestServer struct {
	membershipTestServer
	advance func(context.Context, *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error)
	save    func(context.Context, *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error)
}

func (s receiptTestServer) AdvanceReceipt(ctx context.Context, req *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
	return s.advance(ctx, req)
}

func (s receiptTestServer) SaveMessage(ctx context.Context, req *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
	if s.save == nil {
		return s.UnimplementedHistoryServiceServer.SaveMessage(ctx, req)
	}
	return s.save(ctx, req)
}

type receiptTestUpdate struct {
	kind string
	seq  int64
}

func sendTestReceipt(t *testing.T, conn *websocket.Conn, kind string, payload any) string {
	t.Helper()
	id := newWSEventID()
	if err := conn.WriteJSON(newWSEnvelope(kind, id, payload)); err != nil {
		t.Fatal(err)
	}
	return id
}

func readTestReceipt(t *testing.T, conn *websocket.Conn, update receiptTestUpdate, actor, requestID string) string {
	t.Helper()
	var got wsReceiptPayload
	id := readTestEvent(t, conn, update.kind, &got)
	want := wsReceiptPayload{ChatID: fanoutChat, UserID: actor, Seq: update.seq}
	if got != want || id == requestID {
		t.Fatalf("%s %s %+v; want %+v and an independent server ID", update.kind, id, got, want)
	}
	return id
}

func readTestReceiptError(t *testing.T, conn *websocket.Conn, id, code string, retryable bool) {
	t.Helper()
	var got wsErrorPayload
	if gotID := readTestEvent(t, conn, "error", &got); gotID != id || got.Code != code ||
		got.RequestType == nil || *got.RequestType != wsReadType || got.ClientMsgID != nil || got.Retryable != retryable ||
		got.RetryAfterMS != 0 || strings.Contains(got.Message, "private test detail") {
		t.Fatalf("error %s %+v; want %s with code %s, retryable=%t", gotID, got, id, code, retryable)
	}
}

func TestWSReceiptsAcrossTabsAndRetry(t *testing.T) {
	steps := []struct {
		name, kind           string
		seq, delivered, read int64
		advanced             bool
		events               []receiptTestUpdate
	}{
		{"explicit zero", wsDeliveredType, 0, 0, 0, false, []receiptTestUpdate{{wsDeliveredType, 0}}},
		{"delivery", wsDeliveredType, 2, 2, 0, true, []receiptTestUpdate{{wsDeliveredType, 2}}},
		{"read advances both", wsReadType, 4, 4, 4, true, []receiptTestUpdate{{wsDeliveredType, 4}, {wsReadType, 4}}},
		{"repeat read", wsReadType, 4, 4, 4, false, []receiptTestUpdate{{wsReadType, 4}}},
		{"older read", wsReadType, 3, 4, 4, false, []receiptTestUpdate{{wsReadType, 4}}},
		{"older delivery", wsDeliveredType, 2, 4, 4, false, []receiptTestUpdate{{wsDeliveredType, 4}}},
		{"later delivery", wsDeliveredType, 6, 6, 4, true, []receiptTestUpdate{{wsDeliveredType, 6}}},
		{"read behind delivered", wsReadType, 5, 6, 5, false, []receiptTestUpdate{{wsReadType, 5}}},
	}
	entered, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	var advances, lookups atomic.Int32
	history := startTestHistoryRPC(t, receiptTestServer{
		membershipTestServer: membershipTestServer{members: func(ctx context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			lookups.Add(1)
			if req.GetChatId() != fanoutChat || req.GetRequesterId() != fanoutBob {
				t.Errorf("wrong recipient lookup: %v", req)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Error("GetChatMembers has no deadline")
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		advance: func(ctx context.Context, req *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
			n := int(advances.Add(1)) - 1
			if n >= len(steps) {
				t.Errorf("extra receipt RPC: %v", req)
				return nil, status.Error(codes.Internal, "extra call")
			}
			step := steps[n]
			kind := testReceiptDelivered
			if step.kind == wsReadType {
				kind = testReceiptRead
			}
			if req.GetChatId() != fanoutChat || req.GetActorId() != fanoutBob || req.Seq == nil ||
				req.GetSeq() != step.seq || req.GetKind() != kind {
				t.Errorf("wrong AdvanceReceipt request for %s: %v", step.name, req)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Error("AdvanceReceipt has no deadline")
			}
			if n == 0 {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return nil, status.FromContextError(ctx.Err()).Err()
				}
			}
			return &historyv1.AdvanceReceiptResponse{
				LastDeliveredSeq: step.delivered, LastReadSeq: step.read, DeliveredAdvanced: step.advanced,
			}, nil
		},
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice1, _ := dialTestUser(t, url, fanoutAlice)
	alice2, _ := dialTestUser(t, url, fanoutAlice)
	bob1, _ := dialTestUser(t, url, strings.ToUpper(fanoutBob))
	bob2, _ := dialTestUser(t, url, fanoutBob)
	carol, _ := dialTestUser(t, url, fanoutCarol)
	t.Cleanup(unblock)
	waitForConnections(t, ws, 5)

	for i, step := range steps {
		t.Run(step.name, func(t *testing.T) {
			sender := bob1
			if i%2 != 0 {
				sender = bob2
			}
			id := sendTestReceipt(t, sender, step.kind, map[string]any{"chat_id": strings.ToUpper(fanoutChat), "seq": step.seq})
			if i == 0 {
				select {
				case <-entered:
				case <-time.After(2 * time.Second):
					t.Fatal("AdvanceReceipt did not start")
				}
				assertNoBroadcast(t, ws, fanoutBob, bob1)
				assertTextFrame(t, bob2, `{"marker":true}`)
				assertNoBroadcast(t, ws, fanoutAlice, alice1)
				assertTextFrame(t, alice2, `{"marker":true}`)
				if lookups.Load() != 0 {
					t.Fatal("recipient lookup preceded the committed response")
				}
				unblock()
			}

			for _, event := range step.events {
				serverID := readTestReceipt(t, alice1, event, fanoutBob, id)
				for _, conn := range []*websocket.Conn{alice2, bob1, bob2} {
					if got := readTestReceipt(t, conn, event, fanoutBob, id); got != serverID {
						t.Fatalf("fanout event ID varies between tabs: %s, %s", got, serverID)
					}
				}
			}
			assertNoBroadcast(t, ws, fanoutBob, bob1)
			assertTextFrame(t, bob2, `{"marker":true}`)
			assertNoBroadcast(t, ws, fanoutAlice, alice1)
			assertTextFrame(t, alice2, `{"marker":true}`)
			if got := lookups.Load(); got != int32(i+1) {
				t.Fatalf("want one post-commit recipient lookup per command, got %d", got)
			}
		})
	}
	assertNoBroadcast(t, ws, fanoutCarol, carol)
}

func TestWSReceiptErrorsArePrivate(t *testing.T) {
	type failure struct {
		name, code  string
		grpc        codes.Code
		payloadSeq  any
		retryable   bool
		result      *historyv1.AdvanceReceiptResponse
		members     []string
		lookupError codes.Code
	}
	tests := []failure{
		{name: "fractional seq", code: "invalid_payload", payloadSeq: json.Number("2.0")},
		{name: "negative seq", code: "invalid_seq", payloadSeq: -2},
		{name: "wrong chat", grpc: codes.PermissionDenied, code: "forbidden"},
		{name: "missing chat", grpc: codes.NotFound, code: "forbidden"},
		{name: "future seq", grpc: codes.OutOfRange, code: "invalid_seq"},
		{name: "group chat", grpc: codes.FailedPrecondition, code: "unsupported_type"},
		{name: "History rejects invalid fields", grpc: codes.InvalidArgument, code: "invalid_payload"},
		{name: "storage failure", grpc: codes.Unavailable, code: "temporarily_unavailable", retryable: true},
		{name: "commit outcome unknown", grpc: codes.DeadlineExceeded, code: "temporarily_unavailable", retryable: true},
		{name: "canceled at History", grpc: codes.Canceled, code: "temporarily_unavailable", retryable: true},
		{name: "old History", grpc: codes.Unimplemented, code: "temporarily_unavailable", retryable: true},
		{name: "unexpected History failure", grpc: codes.Unknown, code: "internal_error", retryable: true},
		{name: "History read below request", result: &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 2, LastReadSeq: 1}, code: "internal_error", retryable: true},
		{name: "History read above delivered", result: &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 2, LastReadSeq: 3}, code: "internal_error", retryable: true},
		{name: "History cursor beyond JSON range", result: &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: wsMaxMessageSeq + 1, LastReadSeq: 2}, code: "internal_error", retryable: true},
		{name: "History advanced delivered beyond command", result: &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 3, LastReadSeq: 2, DeliveredAdvanced: true}, code: "internal_error", retryable: true},
		{name: "membership lost after commit", lookupError: codes.PermissionDenied, code: "forbidden"},
		{name: "membership lookup unavailable", lookupError: codes.Unavailable, code: "temporarily_unavailable", retryable: true},
		{name: "missing actor in recipient list", members: []string{fanoutAlice, fanoutCarol}, code: "internal_error", retryable: true},
		{name: "peer left", members: []string{fanoutBob}, code: "internal_error", retryable: true},
		{name: "extra recipient", members: []string{fanoutAlice, fanoutBob, fanoutCarol}, code: "internal_error", retryable: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var advances, lookups atomic.Int32
			actor := fanoutBob
			if tt.grpc == codes.PermissionDenied {
				actor = fanoutCarol
			}
			history := startTestHistoryRPC(t, receiptTestServer{
				membershipTestServer: membershipTestServer{members: func(_ context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
					lookups.Add(1)
					if req.GetChatId() != fanoutChat || req.GetRequesterId() != actor {
						t.Errorf("wrong recipient lookup: %v", req)
					}
					if tt.lookupError != codes.OK {
						return nil, status.Error(tt.lookupError, "private test detail")
					}
					return &historyv1.GetChatMembersResponse{UserIds: tt.members}, nil
				}},
				advance: func(_ context.Context, req *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
					advances.Add(1)
					if req.GetChatId() != fanoutChat || req.GetActorId() != actor || req.GetKind() != testReceiptRead || req.GetSeq() != 2 {
						t.Errorf("wrong AdvanceReceipt request: %v", req)
					}
					if tt.grpc != codes.OK {
						return nil, status.Error(tt.grpc, "private test detail")
					}
					if tt.result != nil {
						return tt.result, nil
					}
					return &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 2, LastReadSeq: 2, DeliveredAdvanced: true}, nil
				},
			})
			ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
			alice, _ := dialTestUser(t, url, fanoutAlice)
			bob, _ := dialTestUser(t, url, fanoutBob)
			carol, _ := dialTestUser(t, url, fanoutCarol)
			waitForConnections(t, ws, 3)

			conn := bob
			if actor == fanoutCarol {
				conn = carol
			}
			seq := tt.payloadSeq
			if seq == nil {
				seq = int64(2)
			}
			id := sendTestReceipt(t, conn, wsReadType, map[string]any{"chat_id": fanoutChat, "seq": seq})
			readTestReceiptError(t, conn, id, tt.code, tt.retryable)

			var wantAdvance, wantLookup int32
			if tt.payloadSeq == nil {
				wantAdvance = 1
			}
			if tt.lookupError != codes.OK || tt.members != nil {
				wantLookup = 1
			}
			if advances.Load() != wantAdvance || lookups.Load() != wantLookup {
				t.Fatalf("History calls advance=%d, lookup=%d; want %d, %d", advances.Load(), lookups.Load(), wantAdvance, wantLookup)
			}
			assertNoBroadcast(t, ws, fanoutAlice, alice)
			assertNoBroadcast(t, ws, fanoutBob, bob)
			assertNoBroadcast(t, ws, fanoutCarol, carol)
		})
	}
}

func TestWSReceiptsOfflineAndSendLimiter(t *testing.T) {
	var saves, advances atomic.Int64
	history := startTestHistoryRPC(t, receiptTestServer{
		membershipTestServer: membershipTestServer{members: func(context.Context, *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		save: func(context.Context, *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			return &historyv1.SaveMessageResponse{
				MessageId: newWSEventID(), Seq: saves.Add(1), CreatedAt: timestamppb.Now(),
			}, nil
		},
		advance: func(_ context.Context, req *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
			if req.GetActorId() != fanoutBob || req.GetSeq() != 1 || req.GetChatId() != fanoutChat {
				t.Errorf("wrong receipt: %v", req)
			}
			call := advances.Add(1)
			if req.GetKind() == testReceiptDelivered {
				return &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 1, DeliveredAdvanced: call == 1}, nil
			}
			return &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 1, LastReadSeq: 1}, nil
		},
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	ws.sendLimiter = newSendLimiter(time.Minute, 1, time.Now)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	waitForConnections(t, ws, 1)

	sendID := newWSEventID()
	sendTestMessage(t, alice, sendID, sendTestClientID, "Bob is offline")
	var first wsAckPayload
	if got := readTestEvent(t, alice, "message.ack", &first); got != sendID || first.Seq != 1 {
		t.Fatalf("wrong ack for the stored message: %s %+v", got, first)
	}
	var msg wsNewPayload
	readTestEvent(t, alice, "message.new", &msg)
	rejectedID := newWSEventID()
	sendTestMessage(t, alice, rejectedID, sendTestClientID, "send limit is still active")
	readTestSendError(t, alice, rejectedID, wsRateLimited, true)
	assertNoBroadcast(t, ws, fanoutAlice, alice)
	if advances.Load() != 0 {
		t.Fatal("saving or queuing a message advanced an offline recipient's cursor")
	}

	bob, _ := dialTestUser(t, url, fanoutBob)
	waitForConnections(t, ws, 2)
	assertNoBroadcast(t, ws, fanoutBob, bob)
	payload := map[string]any{"chat_id": fanoutChat, "seq": 1}
	deliveryID := sendTestReceipt(t, bob, wsDeliveredType, payload)
	readTestReceipt(t, alice, receiptTestUpdate{wsDeliveredType, 1}, fanoutBob, deliveryID)
	readTestReceipt(t, bob, receiptTestUpdate{wsDeliveredType, 1}, fanoutBob, deliveryID)

	if err := alice.Close(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, ws, 1)
	readID := sendTestReceipt(t, bob, wsReadType, payload)
	readTestReceipt(t, bob, receiptTestUpdate{wsReadType, 1}, fanoutBob, readID)
	sendID = newWSEventID()
	sendTestMessage(t, bob, sendID, sendTestClientID, "receipts did not use Bob's send budget")
	var second wsAckPayload
	if got := readTestEvent(t, bob, "message.ack", &second); got != sendID || second.Seq != 2 {
		t.Fatalf("wrong ack after receipt commands: %s %+v", got, second)
	}
	readTestEvent(t, bob, "message.new", &msg)

	alice, _ = dialTestUser(t, url, fanoutAlice)
	waitForConnections(t, ws, 2)
	assertNoBroadcast(t, ws, fanoutAlice, alice)
	readID = sendTestReceipt(t, bob, wsReadType, payload)
	readTestReceipt(t, alice, receiptTestUpdate{wsReadType, 1}, fanoutBob, readID)
	readTestReceipt(t, bob, receiptTestUpdate{wsReadType, 1}, fanoutBob, readID)
}

// The receipt is already committed when routing starts. A closed initiator
// must not prevent publication to the other active tabs.
func TestWSReceiptFanoutSurvivesInitiatorDisconnect(t *testing.T) {
	lookupStarted, release := make(chan struct{}), make(chan struct{})
	started := sync.OnceFunc(func() { close(lookupStarted) })
	unblock := sync.OnceFunc(func() { close(release) })
	history := startTestHistoryRPC(t, receiptTestServer{
		membershipTestServer: membershipTestServer{members: func(ctx context.Context, _ *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			started()
			select {
			case <-release:
			case <-ctx.Done():
				return nil, status.FromContextError(ctx.Err()).Err()
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		advance: func(context.Context, *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
			return &historyv1.AdvanceReceiptResponse{LastDeliveredSeq: 3, LastReadSeq: 3, DeliveredAdvanced: true}, nil
		},
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	bobTab, _ := dialTestUser(t, url, fanoutBob)
	t.Cleanup(unblock)
	waitForConnections(t, ws, 3)
	id := sendTestReceipt(t, bob, wsReadType, map[string]any{"chat_id": fanoutChat, "seq": 3})
	select {
	case <-lookupStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("post-commit recipient lookup did not start")
	}
	if err := bob.Close(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, ws, 2)
	unblock()
	for _, conn := range []*websocket.Conn{alice, bobTab} {
		readTestReceipt(t, conn, receiptTestUpdate{wsDeliveredType, 3}, fanoutBob, id)
		readTestReceipt(t, conn, receiptTestUpdate{wsReadType, 3}, fanoutBob, id)
	}
}
