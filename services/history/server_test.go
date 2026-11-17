package main

import (
	"context"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHistoryShutdown(t *testing.T) {
	for _, block := range []bool{false, true} {
		t.Run(map[bool]string{false: "graceful", true: "deadline"}[block], func(t *testing.T) {
			hl, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			gl, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				_ = hl.Close()
				t.Fatal(err)
			}
			entered := make(chan struct{})
			release := make(chan struct{})
			web := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				if block {
					<-release
				}
				w.WriteHeader(204)
			}), ReadHeaderTimeout: time.Second}
			rpc := grpc.NewServer()
			var ready atomic.Bool
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- serveHistory(ctx, web, rpc, hl, gl, &ready, 50*time.Millisecond, newLogger(io.Discard, "history", 0))
			}()
			requestDone := make(chan struct{})
			go func() {
				defer close(requestDone)
				res, err := http.Get("http://" + hl.Addr().String())
				if err == nil {
					_ = res.Body.Close()
				}
			}()
			await(t, entered)
			cancel()
			select {
			case err := <-done:
				if block == (err == nil) {
					t.Errorf("shutdown err=%v", err)
				}
			case <-time.After(2 * time.Second):
				t.Error("shutdown hung")
			}
			close(release)
			<-requestDone
			if ready.Load() {
				t.Error("readiness remained set")
			}
		})
	}
}

func await(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for server event")
	}
}

type blockedMembership struct {
	entered  chan struct{}
	canceled chan struct{}
	release  chan struct{}
}

func (b *blockedMembership) Personal(context.Context, string, string) (chats.Chat, bool, error) {
	return chats.Chat{}, false, chats.ErrUnavailable
}
func (b *blockedMembership) Membership(context.Context, string, string) (bool, error) {
	return false, chats.ErrUnavailable
}
func (b *blockedMembership) Members(ctx context.Context, _ string, _ string) ([]string, error) {
	close(b.entered)
	<-ctx.Done()
	close(b.canceled)
	<-b.release
	return []string{userA}, nil
}
func TestHistoryForceStopsActiveRPC(t *testing.T) {
	for _, disconnected := range []bool{false, true} {
		name := "connected"
		if disconnected {
			name = "disconnected"
		}
		t.Run(name, func(t *testing.T) { testHistoryForceStop(t, disconnected) })
	}
}
func testHistoryForceStop(t *testing.T, disconnected bool) {
	hl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = hl.Close()
		t.Fatal(err)
	}
	blocked := &blockedMembership{entered: make(chan struct{}), canceled: make(chan struct{}), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(blocked.release) })
	defer release()
	rpc := grpc.NewServer()
	historyv1.RegisterHistoryServiceServer(rpc, &historyGRPC{repo: blocked})
	web := &http.Server{Handler: http.NotFoundHandler(), ReadHeaderTimeout: time.Second}
	var ready atomic.Bool
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serveHistory(ctx, web, rpc, hl, gl, &ready, 50*time.Millisecond, newLogger(io.Discard, "history", 0))
	}()
	conn, err := grpc.NewClient(gl.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	requestDone := make(chan error, 1)
	go func() {
		_, err := historyv1.NewHistoryServiceClient(conn).GetChatMembers(t.Context(), &historyv1.GetChatMembersRequest{ChatId: userB, RequesterId: userA})
		requestDone <- err
	}()
	await(t, blocked.entered)
	if disconnected {
		_ = conn.Close()
		await(t, blocked.canceled)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("forced RPC stop must report deadline")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RPC shutdown hung")
	}
	select {
	case err := <-requestDone:
		if err == nil {
			t.Error("blocked RPC unexpectedly succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("RPC transport remained open")
	}
	await(t, blocked.canceled)
	if ready.Load() {
		t.Error("readiness remained set")
	}
	// Permit the intentionally uncooperative handler to finish, then join gRPC.
	release()
	rpc.Stop()
}
