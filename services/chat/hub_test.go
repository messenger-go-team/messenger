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
		if _, ok := ws.hub.register(ws.fanoutCtx, socket); !ok {
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
	ws, conn, transport := startTestBlockedWriteSocket(t, defaultWSTiming())
	beginTestBlockedWrite(t, ws, transport)

	// Give the server's reader EOF while the server's write is still blocked.
	if err := conn.UnderlyingConn().(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, ws, 0)
}

func TestWSHeartbeatWithPendingWrite(t *testing.T) {
	timing := wsTiming{pingInterval: 500 * time.Millisecond, pongTimeout: 200 * time.Millisecond, writeTimeout: 2 * time.Second}
	t.Run("missing Pong", func(t *testing.T) {
		ws, conn, transport := startTestBlockedWriteSocket(t, timing)
		pings, readDone := readTestPings(t, conn)
		if _, ok := <-pings; !ok {
			t.Fatal("the socket closed before sending Ping")
		}
		deadline := time.NewTimer(timing.pongTimeout + 120*time.Millisecond)
		defer deadline.Stop()
		beginTestBlockedWrite(t, ws, transport)

		// The transport still holds the blocked data write when the socket must close.
		select {
		case <-readDone:
		case <-deadline.C:
			t.Fatal("a blocked data write delayed the Pong timeout")
		}
		waitForConnections(t, ws, 0)
	})
	t.Run("matching Pong", func(t *testing.T) {
		ws, conn, transport := startTestBlockedWriteSocket(t, timing)
		pings, _ := readTestPings(t, conn)
		payload, ok := <-pings
		if !ok {
			t.Fatal("the socket closed before sending Ping")
		}
		beginTestBlockedWrite(t, ws, transport)
		if err := conn.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}

		// Keep the writer blocked past the original Pong deadline, then let it send again.
		time.Sleep(timing.pongTimeout + 50*time.Millisecond)
		close(transport.releaseWrites)
		if _, ok := <-pings; !ok {
			t.Fatal("the socket closed despite receiving the matching Pong")
		}
		waitForConnections(t, ws, 1)
	})
}

func readTestPings(t *testing.T, conn *websocket.Conn) (<-chan string, <-chan struct{}) {
	t.Helper()
	pings := make(chan string, 2)
	readDone := make(chan struct{})
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	conn.SetPingHandler(func(payload string) error {
		select {
		case pings <- payload:
		default:
		}
		return nil // Each test decides whether to send Pong.
	})
	go func() {
		defer close(readDone)
		defer close(pings)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = conn.Close()
		<-readDone
	})
	return pings, readDone
}

func startTestBlockedWriteSocket(t *testing.T, timing wsTiming) (*wsEndpoint, *websocket.Conn, blockedWriteListener) {
	t.Helper()
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	logger := newLogger(io.Discard, "chat", cfg.LogLevel)
	ws := newWSEndpoint(cfg, &ready, timing, nil, logger)
	server := httptest.NewUnstartedServer(newServiceHandler(&ready, logger, ws, nil))
	transport := blockedWriteListener{
		Listener:      server.Listener,
		blockWrites:   make(chan struct{}),
		writeStarted:  make(chan struct{}),
		releaseWrites: make(chan struct{}),
	}
	server.Listener = transport
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
	return ws, conn, transport
}

func beginTestBlockedWrite(t *testing.T, ws *wsEndpoint, transport blockedWriteListener) {
	t.Helper()
	close(transport.blockWrites)
	if err := ws.broker.Publish(t.Context(), []string{fanoutAlice}, []byte(`{"type":"message.new"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-transport.writeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("WebSocket writer did not reach the transport")
	}
}

type blockedWriteListener struct {
	net.Listener
	blockWrites   chan struct{}
	writeStarted  chan struct{}
	releaseWrites chan struct{}
}

func (l blockedWriteListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &blockedWriteConn{
		Conn:          conn,
		blockWrites:   l.blockWrites,
		writeStarted:  l.writeStarted,
		releaseWrites: l.releaseWrites,
		closed:        make(chan struct{}),
	}, nil
}

// The handshake uses the real TCP connection. A subsequent write can be held
// until released or closed, independent of the OS socket buffer.
type blockedWriteConn struct {
	net.Conn
	blockWrites   <-chan struct{}
	writeStarted  chan struct{}
	releaseWrites <-chan struct{}
	closed        chan struct{}
	startOnce     sync.Once
	closeOnce     sync.Once
}

func (c *blockedWriteConn) Write(data []byte) (int, error) {
	select {
	case <-c.blockWrites:
		c.startOnce.Do(func() { close(c.writeStarted) })
		select {
		case <-c.releaseWrites:
			return c.Conn.Write(data)
		case <-c.closed:
			return 0, net.ErrClosed
		}
	default:
		return c.Conn.Write(data)
	}
}

func (c *blockedWriteConn) Close() error {
	err := c.Conn.Close()
	c.closeOnce.Do(func() { close(c.closed) })
	return err
}
