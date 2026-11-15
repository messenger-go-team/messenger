package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

func TestWSSlowSocketDoesNotDelayAnotherTab(t *testing.T) {
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), nil)
	healthy, _ := dialTestUser(t, url, fanoutAlice)

	// Leave one connection's writer paused so overflow is independent of TCP buffers.
	startWriter := make(chan struct{})
	releaseWriter := sync.OnceFunc(func() { close(startWriter) })
	slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := ws.upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = conn.Close() }()
		socket := newSocketSession(conn, jwtauth.Identity{UserID: fanoutAlice, ExpiresAt: time.Now().Add(time.Minute)})
		if !ws.hub.register(socket) {
			t.Error("slow socket was refused by the hub")
			return
		}
		defer ws.hub.unregister(socket)
		<-startWriter
		ws.serveSocket(socket)
	}))
	defer slowServer.Close()
	defer releaseWriter()
	slow, _ := dialTestUser(t, slowServer.URL, fanoutAlice)
	waitForConnections(t, ws, 2)

	for index := range wsQueueSize + 2 {
		want := fmt.Sprintf(`{"index":%d}`, index)
		payload := []byte(want)
		if err := ws.broker.Publish(t.Context(), []string{fanoutAlice}, payload); err != nil {
			t.Fatal(err)
		}
		// A publication owns its data even when the original buffer is reused.
		clear(payload)
		assertTextFrame(t, healthy, want)
	}
	releaseWriter()
	assertSocketClose(t, slow, websocket.CloseTryAgainLater)
	waitForConnections(t, ws, 1)
	assertNoBroadcast(t, ws, fanoutAlice, healthy)
}

func TestWSDisconnectUnblocksPendingWrite(t *testing.T) {
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming(), nil)
	server := httptest.NewUnstartedServer(newServiceHandler(&ready, newLogger(io.Discard, "chat", cfg.LogLevel), ws))
	blockWrites, writeStarted := make(chan struct{}), make(chan struct{})
	server.Listener = blockedWriteListener{
		Listener:     server.Listener,
		blockWrites:  blockWrites,
		writeStarted: writeStarted,
	}
	server.Start()
	t.Cleanup(func() {
		ws.stopAccepting()
		ws.hub.forceClose()
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := ws.wait(ctx); err != nil {
			t.Error(err)
		}
	})

	conn, _ := dialTestUser(t, server.URL, fanoutAlice)
	waitForConnections(t, ws, 1)
	close(blockWrites)
	if err := ws.broker.Publish(t.Context(), []string{fanoutAlice}, []byte(`{"type":"message.new"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("WebSocket writer did not reach the transport")
	}

	// Give the server's reader EOF while the server's write is still blocked.
	if err := conn.UnderlyingConn().(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, ws, 0) // Removal only happens after the writer has exited.
}

type blockedWriteListener struct {
	net.Listener
	blockWrites  <-chan struct{}
	writeStarted chan struct{}
}

func (l blockedWriteListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &blockedWriteConn{
		Conn:         conn,
		blockWrites:  l.blockWrites,
		writeStarted: l.writeStarted,
		closed:       make(chan struct{}),
	}, nil
}

// The handshake uses the real TCP connection. A subsequent write can be held
// until Close so the test doesn't depend on filling the OS socket buffer.
type blockedWriteConn struct {
	net.Conn
	blockWrites  <-chan struct{}
	writeStarted chan struct{}
	closed       chan struct{}
	startOnce    sync.Once
	closeOnce    sync.Once
}

func (c *blockedWriteConn) Write(data []byte) (int, error) {
	select {
	case <-c.blockWrites:
		c.startOnce.Do(func() { close(c.writeStarted) })
		<-c.closed
		return 0, net.ErrClosed
	default:
		return c.Conn.Write(data)
	}
}

func (c *blockedWriteConn) Close() error {
	err := c.Conn.Close()
	c.closeOnce.Do(func() { close(c.closed) })
	return err
}
