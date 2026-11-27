package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type presenceTestHistory struct {
	historyv1.UnimplementedHistoryServiceServer
	list      func(context.Context, string) ([]string, error)
	authorize func(context.Context, string, []string) ([]string, error)
	batch     func(int)
	released  func([]string)
}

func (s presenceTestHistory) ListPresencePeers(ctx context.Context, req *historyv1.ListPresencePeersRequest) (*historyv1.ListPresencePeersResponse, error) {
	ids, err := s.list(ctx, req.GetRequesterId())
	if err != nil {
		return nil, err
	}
	return &historyv1.ListPresencePeersResponse{UserIds: ids}, nil
}

func (s presenceTestHistory) AuthorizePresenceDelivery(ctx context.Context, req *historyv1.AuthorizePresenceDeliveryRequest) (*historyv1.AuthorizePresenceDeliveryResponse, error) {
	ids := req.GetUserIds()
	if s.authorize != nil {
		var err error
		ids, err = s.authorize(ctx, req.GetRequesterId(), ids)
		if err != nil {
			return nil, err
		}
	}
	out := &historyv1.AuthorizePresenceDeliveryResponse{UserIds: ids}
	if len(ids) != 0 {
		out.GrantId = newWSEventID()
	}
	return out, nil
}

func (s presenceTestHistory) BatchPresence(ctx context.Context, req *historyv1.BatchPresenceRequest) (*historyv1.BatchPresenceResponse, error) {
	if s.batch != nil {
		s.batch(len(req.GetOperations()))
	}
	if s.released != nil && len(req.GetReleasedGrantIds()) != 0 {
		s.released(req.GetReleasedGrantIds())
	}
	response := &historyv1.BatchPresenceResponse{}
	for _, op := range req.GetOperations() {
		var result historyv1.PresenceResult
		switch r := op.GetRequest().(type) {
		case *historyv1.PresenceOperation_List:
			list, err := s.ListPresencePeers(ctx, r.List)
			if err == nil {
				result.Response = &historyv1.PresenceResult_List{List: list}
			}
		case *historyv1.PresenceOperation_Authorize:
			auth, err := s.AuthorizePresenceDelivery(ctx, r.Authorize)
			if err == nil {
				result.Response = &historyv1.PresenceResult_Authorize{Authorize: auth}
			}
		}
		response.Results = append(response.Results, &result)
	}
	return response, nil
}

func testPresencePair(user string) []string {
	switch user {
	case fanoutAlice:
		return []string{fanoutBob}
	case fanoutBob:
		return []string{fanoutAlice}
	default:
		return nil
	}
}

type presenceTestFrame struct {
	Type    string    `json:"type"`
	ID      string    `json:"id"`
	TS      time.Time `json:"ts"`
	Payload struct {
		UserID   string          `json:"user_id"`
		Status   string          `json:"status"`
		LastSeen json.RawMessage `json:"last_seen_at"`
	} `json:"payload"`
}

func readPresenceFrames(t *testing.T, conn *websocket.Conn) <-chan presenceTestFrame {
	t.Helper()
	events := make(chan presenceTestFrame, 8)
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		defer close(events)
		for {
			var event presenceTestFrame
			if err := conn.ReadJSON(&event); err != nil {
				return
			}
			select {
			case events <- event:
			case <-stop:
				return
			}
		}
	}()
	t.Cleanup(func() {
		close(stop)
		_ = conn.Close()
		<-stopped
	})
	return events
}

func expectPresence(t *testing.T, events <-chan presenceTestFrame, peer, state string) (time.Time, time.Time) {
	t.Helper()
	select {
	case event, ok := <-events:
		if !ok || event.Type != "presence" || !validWSClientID(event.ID) || event.TS.IsZero() ||
			event.Payload.UserID != peer || event.Payload.Status != state || event.Payload.LastSeen == nil {
			t.Fatalf("presence for %s/%s: got %+v", peer, state, event)
		}
		var lastSeen time.Time
		if err := json.Unmarshal(event.Payload.LastSeen, &lastSeen); err != nil {
			t.Fatal(err)
		}
		if (state == "online" && string(event.Payload.LastSeen) != "null") || lastSeen.After(event.TS) {
			t.Fatalf("inconsistent presence timestamps: %+v", event)
		}
		return lastSeen, event.TS
	case <-time.After(3 * time.Second):
		t.Fatalf("no presence for %s/%s", peer, state)
		return time.Time{}, time.Time{}
	}
}

func expectPresenceSilence(t *testing.T, events <-chan presenceTestFrame) {
	t.Helper()
	select {
	case event, ok := <-events:
		t.Fatalf("expected an open socket with no presence; got %+v (open = %t)", event, ok)
	case <-time.After(60 * time.Millisecond):
	}
}

func TestWSPresenceAcrossTabsAndReconnect(t *testing.T) {
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		return testPresencePair(user), nil
	}})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), client)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	a := readPresenceFrames(t, alice)
	if seen, _ := expectPresence(t, a, fanoutBob, "offline"); !seen.IsZero() {
		t.Fatalf("before Bob's first connection, last_seen_at = %s", seen)
	}

	bob, _ := dialTestUser(t, url, fanoutBob)
	b := readPresenceFrames(t, bob)
	expectPresence(t, a, fanoutBob, "online")
	expectPresence(t, b, fanoutAlice, "online")

	bobTab, _ := dialTestUser(t, url, fanoutBob)
	b2 := readPresenceFrames(t, bobTab)
	expectPresence(t, b2, fanoutAlice, "online")
	aliceTab, _ := dialTestUser(t, url, fanoutAlice)
	a2 := readPresenceFrames(t, aliceTab)
	expectPresence(t, a2, fanoutBob, "online")
	waitForConnections(t, ws, 4)
	lastConfirmed := presenceLastSeen(ws, fanoutBob)

	_ = bobTab.Close()
	waitForConnections(t, ws, 3)
	expectPresenceSilence(t, a)

	_ = bob.Close()
	waitForConnections(t, ws, 2)
	for _, events := range []<-chan presenceTestFrame{a, a2} {
		seen, _ := expectPresence(t, events, fanoutBob, "offline")
		if !seen.Equal(lastConfirmed) {
			t.Fatalf("offline last_seen_at = %s, want last handshake of either tab = %s", seen, lastConfirmed)
		}
	}

	_ = aliceTab.Close()
	waitForConnections(t, ws, 1)
	reconnected, _ := dialTestUser(t, url, fanoutAlice)
	seen, _ := expectPresence(t, readPresenceFrames(t, reconnected), fanoutBob, "offline")
	if !seen.Equal(lastConfirmed) {
		t.Fatalf("fresh snapshot lost last_seen_at: %s", seen)
	}
}

func TestWSPresenceDiscoversAndRevokesAccess(t *testing.T) {
	var enabled, failed atomic.Bool
	failed.Store(true)
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		if failed.Load() {
			return nil, status.Error(codes.Unavailable, "history down")
		}
		if enabled.Load() {
			return testPresencePair(user), nil
		}
		return nil, nil
	}})
	timing := defaultWSTiming()
	timing.presenceRefresh = 25 * time.Millisecond
	ws, url := startTestWSEndpoint(t, timing, client)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	carol, _ := dialTestUser(t, url, fanoutCarol)
	a, b, c := readPresenceFrames(t, alice), readPresenceFrames(t, bob), readPresenceFrames(t, carol)
	waitForConnections(t, ws, 3)
	expectPresenceSilence(t, a) // Unknown after handshake while History is unavailable.

	failed.Store(false)
	expectPresenceSilence(t, a) // Recovery with an empty allowed set discloses nothing.
	enabled.Store(true)         // Both sockets are already open when the chat is created.
	expectPresence(t, a, fanoutBob, "online")
	expectPresence(t, b, fanoutAlice, "online")
	expectPresenceSilence(t, c)

	enabled.Store(false)
	_ = bob.Close()
	waitForConnections(t, ws, 2)
	expectPresenceSilence(t, a)
	expectPresenceSilence(t, c)

	bob, _ = dialTestUser(t, url, fanoutBob)
	b = readPresenceFrames(t, bob)
	expectPresenceSilence(t, b)
	enabled.Store(true) // Restoring access must produce snapshots even if the status is unchanged.
	expectPresence(t, a, fanoutBob, "online")
	expectPresence(t, b, fanoutAlice, "online")
}

func TestWSPresenceHeartbeatTimeoutUsesLastMatchingPong(t *testing.T) {
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		return testPresencePair(user), nil
	}})
	timing := wsTiming{pingInterval: 250 * time.Millisecond, pongTimeout: 150 * time.Millisecond, writeTimeout: time.Second}
	ws, url := startTestWSEndpoint(t, timing, client)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	a := readPresenceFrames(t, alice)
	expectPresence(t, a, fanoutBob, "offline")
	bob, _ := dialTestUser(t, url, fanoutBob)
	pings, _ := readTestPings(t, bob)
	expectPresence(t, a, fanoutBob, "online")
	handshake := presenceLastSeen(ws, fanoutBob)

	ping, ok := <-pings
	if !ok {
		t.Fatal("no first Ping")
	}
	if err := bob.WriteControl(websocket.PongMessage, []byte(ping), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, ok := <-pings; !ok {
		t.Fatal("no second Ping after the matching Pong")
	}
	lastConfirmed := presenceLastSeen(ws, fanoutBob)
	if !lastConfirmed.After(handshake) {
		t.Fatal("matching Pong did not confirm activity")
	}
	if err := bob.WriteControl(websocket.PongMessage, []byte("unmatched"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	seen, eventTime := expectPresence(t, a, fanoutBob, "offline")
	if !seen.Equal(lastConfirmed) || eventTime.Sub(seen) < timing.pongTimeout {
		t.Fatalf("timeout reported last_seen_at=%s, event=%s; want matched Pong at %s", seen, eventTime, lastConfirmed)
	}
}

func presenceLastSeen(ws *wsEndpoint, id string) time.Time {
	ws.hub.mu.Lock()
	defer ws.hub.mu.Unlock()
	if user := ws.hub.users[id]; user != nil {
		return user.activity.lastSeen
	}
	return ws.hub.offline[id].lastSeen
}

func TestWSPresenceLargeSnapshotDoesNotOverflowMessageQueue(t *testing.T) {
	var ids []string
	for i := range 2*presenceBatchSize + 1 {
		ids = append(ids, fmt.Sprintf("30000000-0000-4000-8000-%012x", i))
	}
	var batches atomic.Int32
	client := startTestHistoryRPC(t, presenceTestHistory{
		list: func(_ context.Context, _ string) ([]string, error) { return ids, nil },
		authorize: func(_ context.Context, _ string, requested []string) ([]string, error) {
			if len(requested) > presenceBatchSize {
				t.Errorf("authorization was not batched: %d peers", len(requested))
			}
			batches.Add(1)
			return requested, nil
		},
	})
	_, url := startTestWSEndpoint(t, defaultWSTiming(), client)
	conn, _ := dialTestUser(t, url, fanoutAlice)
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	for range ids {
		var event presenceTestFrame
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "presence" || !want[event.Payload.UserID] ||
			event.Payload.Status != "offline" || string(event.Payload.LastSeen) != "null" {
			t.Fatalf("unexpected or duplicate event: %+v", event)
		}
		delete(want, event.Payload.UserID)
	}
	if got := batches.Load(); got != 3 {
		t.Fatalf("authorization needed %d batches, want 3", got)
	}
}

func TestPresenceRejectsStateAndSocketsNewerThanAuthorizationLookup(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(ctx context.Context, user string) ([]string, error) {
		if user != fanoutAlice {
			t.Errorf("lookup requester = %s, want Alice", user)
		}
		if calls.Add(1) != 1 {
			return nil, nil // Access was revoked while the first SQL snapshot was in flight.
		}
		close(started)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return []string{fanoutBob, fanoutCarol}, nil
		}
	}})
	cfg := testConfig(t)
	ws := newWSEndpoint(cfg, &atomic.Bool{}, defaultWSTiming(), client, newLogger(io.Discard, "chat", cfg.LogLevel))
	t.Cleanup(ws.cancelFanout)
	alice, user := registerPresenceTestSocket(t, ws, fanoutAlice)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ws.refreshPresence(user)
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("authorization lookup did not start")
	}
	registerPresenceTestSocket(t, ws, fanoutBob)
	aliceTab, _ := registerPresenceTestSocket(t, ws, fanoutAlice)
	close(release)
	<-done

	if id, _ := ws.hub.popPresence(aliceTab); id != "" {
		t.Fatalf("new tab received a snapshot based on an earlier lookup: %s", id)
	}
	if id, _ := ws.hub.popPresence(alice); id != fanoutCarol {
		t.Fatalf("only Carol's unchanged state was authorized, got %s", id)
	}
	if id, _ := ws.hub.popPresence(alice); id != "" {
		t.Fatalf("new state escaped through an older authorization snapshot: %s", id)
	}
	ws.refreshPresence(user)
	if id, _ := ws.hub.popPresence(alice); id != "" {
		t.Fatalf("revoked peer continued to appear: %s", id)
	}
}

func TestPresenceDropsQueuedStateOnTransitionAndHistoryFailure(t *testing.T) {
	var failed atomic.Bool
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		if failed.Load() {
			return nil, status.Error(codes.Unavailable, "history down")
		}
		return testPresencePair(user), nil
	}})
	cfg := testConfig(t)
	ws := newWSEndpoint(cfg, &atomic.Bool{}, defaultWSTiming(), client, newLogger(io.Discard, "chat", cfg.LogLevel))
	t.Cleanup(ws.cancelFanout)
	alice, user := registerPresenceTestSocket(t, ws, fanoutAlice)

	ws.refreshPresence(user) // Leave the authorized offline snapshot queued.
	if len(alice.presencePending) != 1 {
		t.Fatal("expected an offline snapshot to be queued")
	}
	registerPresenceTestSocket(t, ws, fanoutBob)
	if id, _ := ws.hub.popPresence(alice); id != "" {
		t.Fatalf("stale offline state for %s reached the writer", id)
	}

	ws.refreshPresence(user) // Leave the fresh online snapshot queued.
	if len(alice.presencePending) != 1 {
		t.Fatal("expected an online snapshot to be queued")
	}
	failed.Store(true)
	ws.refreshPresence(user)
	if id, _ := ws.hub.popPresence(alice); id != "" {
		t.Fatalf("queued state for %s survived a failed authorization refresh", id)
	}
	failed.Store(false)
	ws.refreshPresence(user)
	if id, view := ws.hub.popPresence(alice); id != fanoutBob || !view.view.online {
		t.Fatalf("expected a fresh online snapshot after recovery, got %s %+v", id, view)
	}
}

func TestWSPresenceStopsAtAccessTokenExpiry(t *testing.T) {
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		return testPresencePair(user), nil
	}})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), client)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	a := readPresenceFrames(t, alice)
	expectPresence(t, a, fanoutBob, "offline")

	expiresAt := time.Now().Truncate(time.Second).Add(2 * time.Second)
	bob, _ := dialTestSocket(t, url, testWSHeaders(signTestUserToken(t, fanoutBob, expiresAt)))
	defer func() { _ = bob.Close() }()
	expectPresence(t, a, fanoutBob, "online")
	if err := bob.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var snapshot presenceTestFrame
	if err := bob.ReadJSON(&snapshot); err != nil || snapshot.Type != "presence" {
		t.Fatalf("initial Bob snapshot: %+v, %v", snapshot, err)
	}
	assertSocketClose(t, bob, wsTokenExpired)
	seen, reportedAt := expectPresence(t, a, fanoutBob, "offline")
	if !seen.Equal(presenceLastSeen(ws, fanoutBob)) || !seen.Before(expiresAt) || reportedAt.Before(expiresAt) {
		t.Fatalf("last_seen_at=%s, event time=%s, token expiry=%s", seen, reportedAt, expiresAt)
	}
}

func registerPresenceTestSocket(t *testing.T, ws *wsEndpoint, id string) (*socketSession, *hubUser) {
	t.Helper()
	socket := newSocketSession(nil, jwtauth.Identity{UserID: id, ExpiresAt: time.Now().Add(time.Minute)})
	user, ok := ws.hub.register(ws.fanoutCtx, socket)
	if !ok {
		t.Fatal("hub rejected the socket")
	}
	t.Cleanup(func() { ws.hub.unregister(socket) })
	return socket, user
}

func TestWSPresenceRejectsMembershipRevokedBeforeDiscoveryReply(t *testing.T) {
	discovered, releaseList, checked := make(chan struct{}), make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(releaseList) })
	t.Cleanup(unblock)
	var member atomic.Bool
	member.Store(true)
	var started sync.Once
	authoritative := presenceTestHistory{
		list: func(ctx context.Context, user string) ([]string, error) {
			if user != fanoutAlice || !member.Load() {
				return nil, nil
			}
			started.Do(func() { close(discovered) })
			select {
			case <-releaseList:
				return []string{fanoutBob}, nil // The previous membership snapshot.
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		authorize: func(_ context.Context, requester string, ids []string) ([]string, error) {
			if requester != fanoutAlice || len(ids) != 1 || ids[0] != fanoutBob {
				t.Errorf("unexpected final authorization: %s %v", requester, ids)
			}
			close(checked)
			if member.Load() {
				return ids, nil
			}
			return nil, nil
		},
	}
	client := startTestHistoryRPC(t, authoritative)
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), client)
	dialTestUser(t, url, fanoutBob)
	waitForConnections(t, ws, 1) // Bob never changes state during this race.
	alice, _ := dialTestUser(t, url, fanoutAlice)
	events := readPresenceFrames(t, alice)
	waitPresenceSignal(t, discovered)
	member.Store(false)
	unblock()
	waitPresenceSignal(t, checked)
	expectPresenceSilence(t, events)
}

func TestWSPresenceDoesNotRestartWindowOnLateAuthorization(t *testing.T) {
	finished := make(chan struct{})
	client := startTestHistoryRPC(t, presenceTestHistory{
		list: func(_ context.Context, user string) ([]string, error) {
			if user == fanoutAlice {
				return []string{fanoutBob}, nil
			}
			return nil, nil
		},
		authorize: func(ctx context.Context, _ string, ids []string) ([]string, error) {
			timer := time.NewTimer(presenceStartWindow + 30*time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
			case <-timer.C:
			}
			close(finished)
			return ids, nil
		},
	})
	_, url := startTestWSEndpoint(t, defaultWSTiming(), client)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	events := readPresenceFrames(t, alice)
	waitPresenceSignal(t, finished)
	expectPresenceSilence(t, events)
}

func TestPresenceWriterDropsExpiredQueuedGrant(t *testing.T) {
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, user string) ([]string, error) {
		return testPresencePair(user), nil
	}})
	cfg := testConfig(t)
	ws := newWSEndpoint(cfg, &atomic.Bool{}, defaultWSTiming(), client, newLogger(io.Discard, "chat", cfg.LogLevel))
	t.Cleanup(ws.cancelFanout)
	alice, viewer := registerPresenceTestSocket(t, ws, fanoutAlice)
	if !ws.refreshPresence(viewer) {
		t.Fatal("could not create a pending grant")
	}
	snapshot, found := alice.presencePending[fanoutBob]
	if !found {
		t.Fatal("grant is missing")
	}
	snapshot.grant.startBy = time.Now().Add(-time.Millisecond)
	if id, _ := ws.hub.popPresence(alice); id != "" {
		t.Fatalf("expired grant still permits sending presence for %s", id)
	}
	if _, sent := alice.presenceSent[fanoutBob]; sent {
		t.Fatal("dropped frame was recorded as sent")
	}
	if !ws.refreshPresence(viewer) {
		t.Fatal("could not obtain a fresh grant")
	}
	if id, _ := ws.hub.popPresence(alice); id != fanoutBob {
		t.Fatalf("discarded state was not eligible for retry: %s", id)
	}
}

type reconnectPresenceHistory struct {
	presenceTestHistory
	pool chan struct{}
}

func (h reconnectPresenceHistory) SaveMessage(ctx context.Context, _ *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
	select {
	case h.pool <- struct{}{}:
		defer func() { <-h.pool }()
		return &historyv1.SaveMessageResponse{MessageId: sendTestMessageID, Seq: 1, CreatedAt: timestamppb.Now()}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestWSPresenceMassReconnectLeavesRoomForMessageAck(t *testing.T) {
	pool := make(chan struct{}, 16)
	started, release := make(chan struct{}, 200), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	t.Cleanup(unblock)
	client := startTestHistoryRPC(t, reconnectPresenceHistory{
		pool: pool,
		presenceTestHistory: presenceTestHistory{list: func(ctx context.Context, _ string) ([]string, error) {
			select {
			case pool <- struct{}{}:
				defer func() { <-pool }()
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			started <- struct{}{}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return nil, nil
			}
		}},
	})
	cfg := testConfig(t)
	cfg.HistoryRPCTimeout = 10 * time.Second
	ws, url := startTestWSEndpointWithConfig(t, cfg, defaultWSTiming(), client)
	sender, _ := dialTestUser(t, url, fanoutAlice)
	for index := range 200 {
		dialTestUser(t, url, fmt.Sprintf("70000000-0000-4000-8000-%012x", index))
	}
	waitForConnections(t, ws, 201)
	for range presenceRPCConcurrency {
		waitPresenceSignal(t, started)
	}
	if inFlight := len(pool); inFlight != presenceRPCConcurrency {
		t.Fatalf("background RPCs use %d of 16 History slots, want %d", inFlight, presenceRPCConcurrency)
	}

	requestID := newWSEventID()
	sendTestMessage(t, sender, requestID, sendTestClientID, "message during reconnect")
	var ack wsAckPayload
	if id := readTestEvent(t, sender, "message.ack", &ack); id != requestID || ack.MessageID != sendTestMessageID {
		t.Fatalf("unexpected ACK while discovery is blocked: %s %+v", id, ack)
	}
	if inFlight := len(pool); inFlight != presenceRPCConcurrency {
		t.Fatalf("ACK arrived after presence left the shared pool: %d blocked", inFlight)
	}
	unblock()
}

func waitPresenceSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("presence operation did not reach the expected point")
	}
}

type unavailablePresenceClient struct {
	historyv1.HistoryServiceClient
	calls chan time.Time
}

func (c unavailablePresenceClient) BatchPresence(context.Context, *historyv1.BatchPresenceRequest, ...grpc.CallOption) (*historyv1.BatchPresenceResponse, error) {
	c.calls <- time.Now()
	return nil, status.Error(codes.Unavailable, "history down")
}

func TestPresenceBackoffCoalescesWakeups(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig(t)
		timing := defaultWSTiming()
		timing.presenceRefresh = time.Second
		calls := make(chan time.Time, 16)
		ws := newWSEndpoint(cfg, &atomic.Bool{}, timing, unavailablePresenceClient{calls: calls}, newLogger(io.Discard, "chat", cfg.LogLevel))
		t.Cleanup(ws.cancelFanout)
		_, user := registerPresenceTestSocket(t, ws, fanoutAlice)
		done := make(chan struct{})
		go func() {
			defer close(done)
			ws.runPresence(user)
		}()
		first := <-calls
		synctest.Wait()
		user.wakePresence()
		second := <-calls
		if elapsed := second.Sub(first); elapsed < 800*time.Millisecond || elapsed > 1200*time.Millisecond+presenceBatchDelay {
			t.Fatalf("first retry after %s, want 0.8–1.2 s", elapsed)
		}
		synctest.Wait()
		user.wakePresence()
		third := <-calls
		if elapsed := third.Sub(second); elapsed < 1600*time.Millisecond || elapsed > 2400*time.Millisecond+presenceBatchDelay {
			t.Fatalf("second retry after %s, want 1.6–2.4 s", elapsed)
		}
		ws.cancelFanout()
		<-done
	})
}

func TestWSPresenceSurvivesSlowWriteAndKeepsMessageAck(t *testing.T) {
	var includePeer atomic.Bool
	client := startTestHistoryRPC(t, reconnectPresenceHistory{
		pool: make(chan struct{}, 16),
		presenceTestHistory: presenceTestHistory{list: func(_ context.Context, _ string) ([]string, error) {
			if includePeer.Load() {
				return []string{fanoutBob}, nil
			}
			return nil, nil
		}},
	})
	timing := defaultWSTiming()
	timing.writeTimeout = time.Second
	ws, socket, transport := startTestBlockedWriteSocketWithHistory(t, timing, client)

	sendAck := func() {
		t.Helper()
		requestID := newWSEventID()
		sendTestMessage(t, socket, requestID, newWSEventID(), "message around slow presence write")
		var ack wsAckPayload
		if id := readTestEvent(t, socket, "message.ack", &ack); id != requestID || ack.MessageID != sendTestMessageID {
			t.Fatalf("unexpected ACK: %s %+v", id, ack)
		}
	}
	sendAck()

	close(transport.blockWrites)
	includePeer.Store(true)
	ws.hub.mu.Lock()
	ws.hub.users[fanoutAlice].wakePresence()
	ws.hub.mu.Unlock()
	waitPresenceSignal(t, transport.writeStarted)
	time.Sleep(300 * time.Millisecond)
	close(transport.releaseWrites)

	var presence wsPresencePayload
	readTestEvent(t, socket, "presence", &presence)
	if presence.UserID != fanoutBob || presence.Status != "offline" {
		t.Fatalf("unexpected presence after transport resumed: %+v", presence)
	}
	sendAck()
	waitForConnections(t, ws, 1)
}

func TestWSPresenceReconnectSnapshotsAcrossBatchedUsers(t *testing.T) {
	const viewers = 300
	var largest atomic.Int32
	var batches atomic.Int32
	client := startTestHistoryRPC(t, presenceTestHistory{
		list: func(context.Context, string) ([]string, error) { return []string{fanoutOffline}, nil },
		batch: func(n int) {
			if n > 0 {
				batches.Add(1)
			}
			for old := largest.Load(); int(old) < n; old = largest.Load() {
				if largest.CompareAndSwap(old, int32(n)) {
					break
				}
			}
		},
	})
	timing := defaultWSTiming()
	timing.presenceRefresh = 30 * time.Second
	ws, url := startTestWSEndpoint(t, timing, client)
	wsURL := "ws" + strings.TrimPrefix(url, "http") + "/ws"

	tokens := make([]string, viewers)
	for i := range tokens {
		tokens[i] = signTestUserToken(t, fmt.Sprintf("71000000-0000-4000-8000-%012x", i), time.Now().Add(time.Minute))
	}

	connectWave := func() (time.Duration, int32) {
		t.Helper()
		batches.Store(0)
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		deadline, _ := ctx.Deadline()
		sockets := make([]*websocket.Conn, viewers)
		outcomes := make(chan error, viewers)
		start := time.Now()
		var workers sync.WaitGroup
		for i, token := range tokens {
			workers.Go(func() {
				var dialer websocket.Dialer
				conn, resp, err := dialer.DialContext(ctx, wsURL, testWSHeaders(token))
				if err != nil {
					if resp != nil {
						_ = resp.Body.Close()
					}
					outcomes <- err
					return
				}
				sockets[i] = conn
				if err := conn.SetReadDeadline(deadline); err != nil {
					outcomes <- err
					return
				}
				var event presenceTestFrame
				if err := conn.ReadJSON(&event); err != nil {
					outcomes <- err
					return
				}
				if event.Type != "presence" || event.Payload.UserID != fanoutOffline ||
					event.Payload.Status != "offline" || string(event.Payload.LastSeen) != "null" {
					outcomes <- fmt.Errorf("wrong initial snapshot: %+v", event)
					return
				}
				outcomes <- nil
			})
		}
		workers.Wait()
		elapsed := time.Since(start)
		for _, conn := range sockets {
			if conn != nil {
				_ = conn.Close()
			}
		}
		successes := 0
		var firstErr error
		for range viewers {
			if err := <-outcomes; err != nil {
				if firstErr == nil {
					firstErr = err
				}
			} else {
				successes++
			}
		}
		if successes != viewers {
			t.Fatalf("%d/%d viewers received a snapshot in %s: %v", successes, viewers, elapsed, firstErr)
		}
		waitForConnections(t, ws, 0)
		return elapsed, batches.Load()
	}

	connectWave()
	elapsed, calls := connectWave()
	if calls >= viewers || largest.Load() < 2 || largest.Load() > presenceOperationsPerRPC {
		t.Fatalf("rediscovery was not batched: %d calls, largest group %d", calls, largest.Load())
	}
	t.Logf("%d reconnects received snapshots in %s using %d discovery/authorization RPCs", viewers, elapsed, calls)
}

func TestPresenceGrantWaitsForLastTabFrame(t *testing.T) {
	released := make(chan string, 2)
	client := startTestHistoryRPC(t, presenceTestHistory{
		list: func(_ context.Context, user string) ([]string, error) { return testPresencePair(user), nil },
		released: func(ids []string) {
			for _, id := range ids {
				released <- id
			}
		},
	})
	cfg := testConfig(t)
	ws := newWSEndpoint(cfg, &atomic.Bool{}, defaultWSTiming(), client, newLogger(io.Discard, "chat", cfg.LogLevel))
	t.Cleanup(ws.cancelFanout)
	first, viewer := registerPresenceTestSocket(t, ws, fanoutAlice)
	second, _ := registerPresenceTestSocket(t, ws, fanoutAlice)
	if !ws.refreshPresence(viewer) {
		t.Fatal("initial authorization did not complete")
	}
	id, frame := ws.hub.popPresence(first)
	if id != fanoutBob || second.presencePending[id].grant != frame.grant {
		t.Fatal("both tab frames should share a reservation")
	}
	frame.grant.finish()
	if refs := frame.grant.pending.Load(); refs != 1 {
		t.Fatalf("first write left %d references, want one queued tab", refs)
	}

	ws.hub.unregister(second)
	select {
	case got := <-released:
		if got != frame.grant.id {
			t.Fatalf("released %s instead of %s", got, frame.grant.id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dropping the final tab frame did not release the reservation")
	}
}
