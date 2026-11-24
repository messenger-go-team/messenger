package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestWSTypingPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    bool
		valid   bool
	}{
		{"true", map[string]any{"chat_id": strings.ToUpper(fanoutChat), "is_typing": true}, true, true},
		{"false", map[string]any{"chat_id": fanoutChat, "is_typing": false}, false, true},
		{"missing", map[string]any{"chat_id": fanoutChat}, false, false},
		{"null", map[string]any{"chat_id": fanoutChat, "is_typing": nil}, false, false},
		{"string", map[string]any{"chat_id": fanoutChat, "is_typing": "true"}, false, false},
		{"bad chat", map[string]any{"chat_id": "not-a-uuid", "is_typing": true}, false, false},
		{"forged author", map[string]any{"chat_id": fanoutChat, "is_typing": true, "user_id": fanoutBob}, false, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := json.Marshal(newWSEnvelope(wsTypingType, newWSEventID(), tt.payload))
			if err != nil {
				t.Fatal(err)
			}
			cmd, problem := parseWSCommand(raw)
			if !tt.valid {
				if problem != "invalid_payload" {
					t.Fatalf("got %q, want invalid_payload", problem)
				}
				return
			}
			if problem != "" || cmd.kind != wsTypingType || cmd.chatID != fanoutChat || cmd.isTyping != tt.want {
				t.Fatalf("got %+v, problem %q", cmd, problem)
			}
		})
	}
}

type testTypingEvent struct {
	Type    string
	TS      time.Time
	Payload wsTypingPayload
}

type testTypingBroker struct {
	events chan testTypingEvent
}

func (b testTypingBroker) Publish(_ context.Context, peers []string, raw []byte) error {
	var event testTypingEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		return err
	}
	if len(peers) != 1 || peers[0] != fanoutBob {
		return status.Error(codes.Internal, "unexpected typing recipients")
	}
	b.events <- event
	return nil
}

type testTypingHistory struct {
	historyv1.HistoryServiceClient
	getMembers func(*historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error)
}

func (s testTypingHistory) GetChatMembers(_ context.Context, req *historyv1.GetChatMembersRequest, _ ...grpc.CallOption) (*historyv1.GetChatMembersResponse, error) {
	return s.getMembers(req)
}

func newTypingTestEndpoint(t *testing.T) (*wsEndpoint, <-chan testTypingEvent) {
	t.Helper()
	events := make(chan testTypingEvent, 16)
	return &wsEndpoint{
		hub:            newConnectionHub(),
		typing:         typingTracker{byUser: make(map[string]map[string]*typingGroup)},
		fanoutCtx:      t.Context(),
		broker:         testTypingBroker{events: events},
		logger:         slog.Default(),
		historyTimeout: time.Minute,
	}, events
}

func expectTypingEvent(t *testing.T, events <-chan testTypingEvent, active bool, expiresAt time.Time) {
	t.Helper()
	select {
	case event := <-events:
		p := event.Payload
		if event.Type != wsTypingType || p.ChatID != fanoutChat || p.UserID != fanoutAlice ||
			p.IsTyping != active || !p.ExpiresAt.Equal(expiresAt) {
			t.Fatalf("unexpected typing event: %+v", event)
		}
		if !active && !p.ExpiresAt.Equal(event.TS) {
			t.Fatalf("false expires_at %s differs from ts %s", p.ExpiresAt, event.TS)
		}
	default:
		t.Fatal("missing typing event")
	}
}

func expectNoTypingEvent(t *testing.T, events <-chan testTypingEvent) {
	t.Helper()
	select {
	case event := <-events:
		t.Fatalf("unexpected typing event: %+v", event)
	default:
	}
}

func applyTestTyping(ws *wsEndpoint, socket *socketSession, expiresAt time.Time) {
	ws.typing.mu.Lock()
	defer ws.typing.mu.Unlock()
	ws.applyTypingLocked(socket, fanoutChat, fanoutBob, expiresAt, time.Now())
}

func TestWSTypingTabsAndTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ws, events := newTypingTestEndpoint(t)
		now := time.Now()
		newTab := func() *socketSession {
			return &socketSession{userID: fanoutAlice, expiresAt: now.Add(time.Minute)}
		}
		a1, a2 := newTab(), newTab()
		off := wsCommand{chatID: fanoutChat}
		wake := make(chan struct{}, 1)
		firstDeadline := now.Add(typingTTL)
		applyTestTyping(ws, a1, firstDeadline)
		expectTypingEvent(t, events, true, firstDeadline)

		time.Sleep(time.Second)
		secondDeadline := time.Now().Add(typingTTL)
		applyTestTyping(ws, a2, secondDeadline)
		expectTypingEvent(t, events, true, secondDeadline)
		ws.queueTyping(a2, off, time.Now(), wake)
		expectTypingEvent(t, events, true, firstDeadline)
		ws.queueTyping(a2, off, time.Now(), wake)
		expectNoTypingEvent(t, events)

		time.Sleep(time.Until(firstDeadline) - time.Nanosecond)
		synctest.Wait()
		expectNoTypingEvent(t, events)
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		expectTypingEvent(t, events, false, firstDeadline)
		if len(ws.typing.byUser) != 0 {
			t.Fatal("expired typing state was retained")
		}
	})
}

func processTestTyping(ws *wsEndpoint, t *testing.T, socket *socketSession, cmd wsCommand, receivedAt time.Time) {
	t.Helper()
	wake := make(chan struct{}, 1)
	ws.queueTyping(socket, cmd, receivedAt, wake)
	select {
	case <-wake:
		ws.handleTyping(t.Context(), socket, socket.pendingTyping)
	default:
	}
}

func TestWSTypingLookupBudget(t *testing.T) {
	for _, outcome := range []codes.Code{codes.OK, codes.Unavailable, codes.PermissionDenied} {
		t.Run(outcome.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ws, events := newTypingTestEndpoint(t)
				first := time.Now()
				socket := &socketSession{
					userID: fanoutAlice, expiresAt: first.Add(time.Minute),
					outgoing: make(chan []byte, wsQueueSize),
				}
				var lookups int
				ws.history = testTypingHistory{getMembers: func(req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
					if req.GetChatId() != fanoutChat || req.GetRequesterId() != fanoutAlice {
						t.Errorf("unexpected membership query: %v", req)
					}
					lookups++
					if lookups == 1 {
						time.Sleep(3 * time.Second)
					}
					if outcome != codes.OK {
						return nil, status.Error(outcome, "lookup failed")
					}
					return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
				}}
				on := wsCommand{kind: wsTypingType, chatID: fanoutChat, isTyping: true}
				off := wsCommand{kind: wsTypingType, chatID: fanoutChat}
				for range 4 {
					processTestTyping(ws, t, socket, off, first)
				}
				if lookups != 0 {
					t.Fatalf("idle false made %d lookups", lookups)
				}

				processTestTyping(ws, t, socket, on, first)
				if outcome == codes.OK {
					expectTypingEvent(t, events, true, first.Add(typingTTL))
				}
				processTestTyping(ws, t, socket, off, first.Add(time.Second))
				if outcome == codes.OK {
					expectTypingEvent(t, events, false, time.Now())
				}

				for _, chatID := range []string{fanoutChat, newWSEventID(), newWSEventID()} {
					early := on
					early.chatID = chatID
					processTestTyping(ws, t, socket, early, first.Add(time.Second))
				}
				if lookups != 1 {
					t.Fatalf("early frames made %d lookups, want 1", lookups)
				}
				// The second accepted request arrived two seconds after the first
				// even though the worker finished its first lookup at three seconds.
				atLimit := first.Add(typingMinGap)
				processTestTyping(ws, t, socket, on, atLimit)
				if lookups != 2 {
					t.Fatalf("frame at the limit made %d total lookups, want 2", lookups)
				}
				if outcome == codes.OK {
					expectTypingEvent(t, events, true, atLimit.Add(typingTTL))
				}
				ws.clearSocketTyping(socket)
			})
		})
	}
}

func TestWSTypingDiscardSupersededLookup(t *testing.T) {
	for _, action := range []string{"newer", "false", "disconnect"} {
		t.Run(action, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ws, events := newTypingTestEndpoint(t)
				now := time.Now()
				socket := &socketSession{userID: fanoutAlice, expiresAt: now.Add(time.Minute)}
				release := make(chan struct{})
				unblock := sync.OnceFunc(func() { close(release) })
				var lookups int
				ws.history = testTypingHistory{getMembers: func(*historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
					lookups++
					if lookups == 1 {
						// This stub returns a successful result even after cancellation.
						<-release
					}
					return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
				}}
				ctx, cancel := context.WithCancel(t.Context())
				wake, done := make(chan struct{}, 1), make(chan struct{})
				go func() {
					defer close(done)
					ws.runWSTyping(ctx, socket, wake)
				}()
				defer func() {
					cancel()
					unblock()
					<-done
					ws.clearSocketTyping(socket)
				}()
				on := wsCommand{kind: wsTypingType, chatID: fanoutChat, isTyping: true}
				ws.queueTyping(socket, on, now, wake)
				synctest.Wait()
				if lookups != 1 {
					t.Fatalf("worker made %d lookups, want 1", lookups)
				}

				var latestDeadline time.Time
				switch action {
				case "newer":
					for range 2 {
						time.Sleep(typingMinGap)
						receivedAt := time.Now()
						ws.queueTyping(socket, on, receivedAt, wake)
						latestDeadline = receivedAt.Add(typingTTL)
					}
				case "false":
					ws.queueTyping(socket, wsCommand{chatID: fanoutChat}, time.Now(), wake)
				case "disconnect":
					cancel()
				}
				synctest.Wait()
				if lookups != 1 {
					t.Fatalf("lookup concurrency grew to %d", lookups)
				}
				unblock()
				synctest.Wait()
				if action == "newer" {
					expectTypingEvent(t, events, true, latestDeadline)
					if lookups != 2 {
						t.Fatalf("queued signals made %d lookups, want 2 total", lookups)
					}
				} else if lookups != 1 || len(ws.typing.byUser) != 0 {
					t.Fatal("superseded lookup restored typing")
				}
				expectNoTypingEvent(t, events)
			})
		})
	}
}

func TestWSTypingLookupDoesNotBlockMessageAck(t *testing.T) {
	started, finished, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	var lookups atomic.Int32
	history := startTestHistoryRPC(t, messageTestServer{
		membershipTestServer: membershipTestServer{members: func(ctx context.Context, _ *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			if lookups.Add(1) == 1 {
				close(started)
				defer close(finished)
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		save: func(_ context.Context, req *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			if req.GetSenderId() != fanoutAlice || req.GetChatId() != fanoutChat {
				t.Errorf("unexpected SaveMessage request: %v", req)
			}
			return &historyv1.SaveMessageResponse{
				MessageId: sendTestMessageID, Seq: 1, CreatedAt: timestamppb.Now(),
			}, nil
		},
	})
	_, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	writeTestTyping(t, alice, true)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("typing lookup did not start")
	}
	for range 2 * wsCommandQueueSize {
		writeTestTyping(t, alice, false)
	}
	id := newWSEventID()
	sendTestMessage(t, alice, id, sendTestClientID, "send during typing lookup")
	var ack wsAckPayload
	if got := readTestEvent(t, alice, "message.ack", &ack); got != id || ack.MessageID != sendTestMessageID {
		t.Fatalf("unexpected ack: id %s payload %+v", got, ack)
	}
	select {
	case <-finished:
		t.Fatal("typing lookup finished before the acknowledgement")
	default:
	}
}

func writeTestTyping(t *testing.T, conn *websocket.Conn, active bool) string {
	t.Helper()
	event := newWSEnvelope(wsTypingType, newWSEventID(), map[string]any{
		"chat_id": fanoutChat, "is_typing": active,
	})
	if err := conn.WriteJSON(event); err != nil {
		t.Fatal(err)
	}
	return event.ID
}

func assertNextWSFrameIsInvalidJSON(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, []byte("null")); err != nil {
		t.Fatal(err)
	}
	var problem wsErrorPayload
	readTestEvent(t, conn, "error", &problem)
	if problem.Code != "invalid_json" {
		t.Fatalf("unexpected error: %+v", problem)
	}
}

func readWSTyping(t *testing.T, conn *websocket.Conn, active bool) time.Time {
	t.Helper()
	var payload wsTypingPayload
	readTestEvent(t, conn, wsTypingType, &payload)
	if payload.IsTyping != active || payload.UserID != fanoutAlice ||
		payload.ChatID != fanoutChat || payload.ExpiresAt.IsZero() {
		t.Fatalf("unexpected typing payload: %+v", payload)
	}
	return payload.ExpiresAt
}

func TestWSTypingMembershipAndDisconnect(t *testing.T) {
	history := startTestMembershipRPC(t, func(_ context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
		if req.GetChatId() != fanoutChat || req.GetRequesterId() != fanoutAlice {
			return nil, status.Error(codes.PermissionDenied, "private membership detail")
		}
		return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice1, _ := dialTestUser(t, url, fanoutAlice)
	alice2, _ := dialTestUser(t, url, fanoutAlice)
	bob1, _ := dialTestUser(t, url, fanoutBob)
	bob2, _ := dialTestUser(t, url, fanoutBob)
	outsider, _ := dialTestUser(t, url, fanoutCarol)
	waitForConnections(t, ws, 5)

	id := writeTestTyping(t, outsider, true)
	var problem wsErrorPayload
	if got := readTestEvent(t, outsider, "error", &problem); got != id || problem.Code != "forbidden" ||
		problem.RequestType == nil || *problem.RequestType != wsTypingType || problem.ClientMsgID != nil {
		t.Fatalf("unexpected typing error: id %s, payload %+v", got, problem)
	}

	writeTestTyping(t, alice1, true)
	firstDeadline := readWSTyping(t, bob1, true)
	if got := readWSTyping(t, bob2, true); !got.Equal(firstDeadline) {
		t.Fatalf("Bob's second tab got %s, want %s", got, firstDeadline)
	}
	writeTestTyping(t, alice2, true)
	secondDeadline := readWSTyping(t, bob1, true)
	if got := readWSTyping(t, bob2, true); !got.Equal(secondDeadline) || !got.After(firstDeadline) {
		t.Fatalf("second deadline %s (Bob's second tab: %s) must be after %s", secondDeadline, got, firstDeadline)
	}
	assertNextWSFrameIsInvalidJSON(t, alice1)
	assertNextWSFrameIsInvalidJSON(t, alice2)
	assertNextWSFrameIsInvalidJSON(t, outsider)

	if err := alice2.Close(); err != nil {
		t.Fatal(err)
	}
	for _, bob := range []*websocket.Conn{bob1, bob2} {
		if got := readWSTyping(t, bob, true); !got.Equal(firstDeadline) {
			t.Fatalf("after closing Alice's second tab deadline was %s, want %s", got, firstDeadline)
		}
	}

	if err := bob2.Close(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, ws, 3)
	reconnected, _ := dialTestUser(t, url, fanoutBob)
	assertNextWSFrameIsInvalidJSON(t, reconnected)

	if err := alice1.Close(); err != nil {
		t.Fatal(err)
	}
	readWSTyping(t, bob1, false)
	readWSTyping(t, reconnected, false)
}
