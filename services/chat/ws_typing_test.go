package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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

func TestWSTypingTabsAndTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ws, events := newTypingTestEndpoint(t)
		now := time.Now()
		newTab := func() *socketSession {
			return &socketSession{userID: fanoutAlice, expiresAt: now.Add(time.Minute)}
		}
		a1, a2 := newTab(), newTab()
		on := wsCommand{chatID: fanoutChat, isTyping: true}
		off := wsCommand{chatID: fanoutChat}

		receivedAt := now.Add(-time.Second)
		ws.applyTyping(a1, on, fanoutBob, receivedAt)
		firstDeadline := receivedAt.Add(typingTTL)
		expectTypingEvent(t, events, true, firstDeadline)

		time.Sleep(time.Second)
		secondReceivedAt := time.Now()
		secondDeadline := secondReceivedAt.Add(typingTTL)
		ws.applyTyping(a2, on, fanoutBob, secondReceivedAt)
		expectTypingEvent(t, events, true, secondDeadline)
		ws.applyTyping(a2, off, fanoutBob, secondReceivedAt)
		expectTypingEvent(t, events, true, firstDeadline)
		if !ws.typingLimited(a2, fanoutChat, secondReceivedAt) {
			t.Fatal("false cleared the rate limit")
		}
		ws.clearSocketTyping(a2)
		expectNoTypingEvent(t, events)

		reconnected := newTab()
		if ws.typingLimited(reconnected, fanoutChat, secondReceivedAt) {
			t.Fatal("new socket inherited the old socket's rate limit")
		}
		ws.applyTyping(reconnected, on, fanoutBob, secondReceivedAt)
		expectTypingEvent(t, events, true, secondDeadline)
		ws.clearSocketTyping(a1)
		expectNoTypingEvent(t, events)

		time.Sleep(time.Until(secondDeadline) - time.Nanosecond)
		synctest.Wait()
		expectNoTypingEvent(t, events)
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		expectTypingEvent(t, events, false, secondDeadline)
		if !ws.typingLimited(reconnected, fanoutChat, secondReceivedAt.Add(time.Second)) {
			t.Fatal("expiry lost the cooldown while a queued command could still be fresh")
		}

		time.Sleep(typingMinGap)
		synctest.Wait()
		expectNoTypingEvent(t, events)
		if len(ws.typing.byUser) != 0 {
			t.Fatal("expired typing state was retained")
		}
	})
}

func TestWSTypingRateUsesReceiveTime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ws, events := newTypingTestEndpoint(t)
		first := time.Now()
		socket := &socketSession{userID: fanoutAlice, expiresAt: first.Add(time.Minute)}
		var lookups int
		ws.history = testTypingHistory{getMembers: func(req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			if req.GetChatId() != fanoutChat || req.GetRequesterId() != fanoutAlice {
				t.Fatalf("unexpected membership query: %v", req)
			}
			lookups++
			if lookups == 1 {
				time.Sleep(3 * time.Second)
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}}
		on := wsCommand{kind: wsTypingType, chatID: fanoutChat, isTyping: true}
		off := wsCommand{kind: wsTypingType, chatID: fanoutChat}

		ws.handleTyping(t.Context(), socket, on, first)
		expectTypingEvent(t, events, true, first.Add(typingTTL))
		ws.handleTyping(t.Context(), socket, on, first.Add(time.Second))
		expectNoTypingEvent(t, events)
		if lookups != 1 {
			t.Fatalf("rate-limited frame reached History: %d lookups", lookups)
		}

		atLimit := first.Add(typingMinGap)
		ws.handleTyping(t.Context(), socket, on, atLimit)
		expectTypingEvent(t, events, true, atLimit.Add(typingTTL))
		ws.handleTyping(t.Context(), socket, off, time.Now())
		expectTypingEvent(t, events, false, time.Now())

		// This frame is still within its TTL, even though both the last true
		// deadline and the rate window have now passed on the server clock.
		time.Sleep(typingTTL)
		synctest.Wait()
		ws.handleTyping(t.Context(), socket, on, atLimit.Add(1500*time.Millisecond))
		expectNoTypingEvent(t, events)
		if lookups != 3 {
			t.Fatalf("delayed rate-limited frame reached History: %d lookups", lookups)
		}

		time.Sleep(time.Until(atLimit.Add(typingMinGap + typingTTL)))
		synctest.Wait()
		if len(ws.typing.byUser) != 0 {
			t.Fatal("expired rate-limit state was retained")
		}
	})
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
