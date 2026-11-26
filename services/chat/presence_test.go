package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type presenceTestHistory struct {
	historyv1.UnimplementedHistoryServiceServer
	list func(context.Context, string) ([]string, error)
}

func (s presenceTestHistory) ListPresencePeers(ctx context.Context, req *historyv1.ListPresencePeersRequest) (*historyv1.ListPresencePeersResponse, error) {
	ids, err := s.list(ctx, req.GetRequesterId())
	if err != nil {
		return nil, err
	}
	return &historyv1.ListPresencePeersResponse{UserIds: ids}, nil
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
	for i := range 3 * wsQueueSize {
		ids = append(ids, fmt.Sprintf("30000000-0000-4000-8000-%012x", i))
	}
	client := startTestHistoryRPC(t, presenceTestHistory{list: func(_ context.Context, _ string) ([]string, error) {
		return ids, nil
	}})
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
	if id, view := ws.hub.popPresence(alice); id != fanoutBob || !view.online {
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
