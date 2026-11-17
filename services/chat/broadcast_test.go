package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	fanoutAlice   = "10000000-0000-4000-8000-00000000000a"
	fanoutBob     = "10000000-0000-4000-8000-00000000000b"
	fanoutCarol   = "10000000-0000-4000-8000-00000000000c"
	fanoutOffline = "10000000-0000-4000-8000-00000000000d"
	fanoutChat    = "20000000-0000-4000-8000-00000000001a"
)

func TestWSBroadcastUsesCurrentHistoryMembership(t *testing.T) {
	var members atomic.Value
	members.Store([]string{fanoutAlice, fanoutBob})
	history := startTestMembershipRPC(t, func(ctx context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
		if req.GetChatId() != fanoutChat || req.GetRequesterId() != fanoutAlice {
			t.Errorf("unexpected membership request: %v", req)
			return nil, status.Error(codes.PermissionDenied, "unexpected requester or chat")
		}
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 3*time.Second {
			t.Error("membership RPC lacks the configured deadline")
		}
		return &historyv1.GetChatMembersResponse{UserIds: members.Load().([]string)}, nil
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	alice, token := dialTestUser(t, url, strings.ToUpper(fanoutAlice))
	aliceTab, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	carol, _ := dialTestUser(t, url, fanoutCarol)
	waitForConnections(t, ws, 4)
	assertConnectionGauge(t, url, "4")
	identity, err := ws.verifier.Verify(token)
	if err != nil {
		t.Fatal(err)
	}

	first := `{"type":"message.new","payload":{"body":"first"}}`
	if err := ws.broadcastChat(t.Context(), identity, strings.ToUpper(fanoutChat), []byte(first)); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []*websocket.Conn{alice, aliceTab, bob} {
		assertTextFrame(t, conn, first)
	}
	assertNoBroadcast(t, ws, fanoutCarol, carol)

	// Closing a tab must leave the same user's other connection registered.
	if err := aliceTab.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	assertSocketClose(t, aliceTab, websocket.CloseNormalClosure)
	waitForConnections(t, ws, 3)
	assertConnectionGauge(t, url, "3")

	members.Store([]string{fanoutAlice, fanoutCarol, fanoutOffline})
	second := `{"type":"message.new","payload":{"body":"second"}}`
	if err := ws.broadcastChat(t.Context(), identity, fanoutChat, []byte(second)); err != nil {
		t.Fatal(err)
	}
	assertTextFrame(t, alice, second)
	assertTextFrame(t, carol, second)
	assertNoBroadcast(t, ws, fanoutBob, bob)
}

func TestWSBroadcastStopsOnHistoryError(t *testing.T) {
	var failure atomic.Int32
	history := startTestMembershipRPC(t, func(ctx context.Context, _ *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
		code := codes.Code(failure.Load())
		if code == codes.DeadlineExceeded {
			<-ctx.Done()
		}
		return nil, status.Error(code, "could not read membership")
	})
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), history)
	ws.historyTimeout = 250 * time.Millisecond
	bob, _ := dialTestUser(t, url, fanoutBob)
	waitForConnections(t, ws, 1)
	for _, code := range []codes.Code{codes.PermissionDenied, codes.NotFound, codes.Unavailable, codes.DeadlineExceeded} {
		t.Run(code.String(), func(t *testing.T) {
			failure.Store(int32(code))
			err := ws.broadcastChat(t.Context(), jwtauth.Identity{UserID: fanoutAlice}, fanoutChat, []byte(`{"type":"message.new"}`))
			if got := status.Code(err); got != code {
				t.Fatalf("RPC error = %v, want %v", err, code)
			}
			assertNoBroadcast(t, ws, fanoutBob, bob)
		})
	}
}

func TestWSConcurrentPublishAndDisconnect(t *testing.T) {
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), nil)
	sockets := make([]*websocket.Conn, 16)
	for i := range sockets {
		sockets[i], _ = dialTestUser(t, url, fanoutAlice)
	}
	waitForConnections(t, ws, len(sockets))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, conn := range sockets {
		wg.Go(func() {
			<-start
			_ = conn.Close()
		})
	}
	for range 4 {
		wg.Go(func() {
			<-start
			for range 50 {
				if err := ws.broker.Publish(t.Context(), []string{fanoutAlice}, []byte(`{"type":"message.new"}`)); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	close(start)
	wg.Wait()
	waitForConnections(t, ws, 0)
	assertConnectionGauge(t, url, "0")
}

type membershipTestServer struct {
	historyv1.UnimplementedHistoryServiceServer
	members func(context.Context, *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error)
}

func (s membershipTestServer) GetChatMembers(ctx context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
	return s.members(ctx, req)
}

func startTestMembershipRPC(t *testing.T, members func(context.Context, *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error)) historyv1.HistoryServiceClient {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	historyv1.RegisterHistoryServiceServer(server, membershipTestServer{members: members})
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		server.Stop()
		if err := <-done; err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			t.Error(err)
		}
	})
	conn, err := newHistoryConn(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return historyv1.NewHistoryServiceClient(conn)
}

func dialTestUser(t *testing.T, url, userID string) (*websocket.Conn, string) {
	t.Helper()
	token := signTestUserToken(t, userID, time.Now().Add(time.Minute))
	conn, _ := dialTestSocket(t, url, testWSHeaders(token))
	t.Cleanup(func() { _ = conn.Close() })
	return conn, token
}

func waitForConnections(t *testing.T, ws *wsEndpoint, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if got := ws.hub.size(); got == want {
			return
		} else if time.Now().After(deadline) {
			t.Fatalf("hub contains %d connections, want %d", got, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func assertTextFrame(t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	kind, data, err := conn.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(data) != want {
		t.Fatalf("frame type %d, data %q, error %v, want text frame %q", kind, data, err, want)
	}
}

func assertNoBroadcast(t *testing.T, ws *wsEndpoint, userID string, conn *websocket.Conn) {
	t.Helper()
	// A marker queued after the broadcast must be the very next frame.
	const marker = `{"marker":true}`
	if err := ws.broker.Publish(t.Context(), []string{userID}, []byte(marker)); err != nil {
		t.Fatal(err)
	}
	assertTextFrame(t, conn, marker)
}

func assertConnectionGauge(t *testing.T, url, want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/metrics", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		if line == "chat_active_websocket_connections "+want {
			return
		}
	}
	t.Fatalf("metrics do not report %s active WebSocket connections", want)
}
