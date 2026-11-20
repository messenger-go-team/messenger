package main

import (
	"context"
	"crypto/rand"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

const (
	wsMaxMessageBytes  = 64 * 1024
	wsTokenExpired     = 4401
	wsQueueSize        = 32
	wsCommandQueueSize = 8
)

type socketSession struct {
	conn       *websocket.Conn
	userID     string
	expiresAt  time.Time
	outgoing   chan []byte
	overloaded chan struct{}
}

func newSocketSession(conn *websocket.Conn, identity jwtauth.Identity) *socketSession {
	return &socketSession{
		conn:       conn,
		userID:     identity.UserID,
		expiresAt:  identity.ExpiresAt,
		outgoing:   make(chan []byte, wsQueueSize),
		overloaded: make(chan struct{}),
	}
}

// enqueue is called under the hub lock. The writer owns the network writes.
func (s *socketSession) enqueue(event []byte) {
	select {
	case <-s.overloaded:
		return
	default:
	}
	select {
	case s.outgoing <- event:
	default:
		close(s.overloaded)
	}
}

type wsTiming struct {
	pingInterval time.Duration
	pongTimeout  time.Duration
	writeTimeout time.Duration
}

func defaultWSTiming() wsTiming {
	return wsTiming{
		pingInterval: 25 * time.Second,
		pongTimeout:  10 * time.Second,
		writeTimeout: 10 * time.Second,
	}
}

type pingProbe struct {
	payload string
}

func (ws *wsEndpoint) serveSocket(socket *socketSession) {
	conn := socket.conn
	conn.SetReadLimit(wsMaxMessageBytes)
	var pending atomic.Pointer[pingProbe]
	conn.SetPongHandler(func(payload string) error {
		if ping := pending.Load(); ping != nil && ping.payload == payload {
			pending.CompareAndSwap(ping, nil)
		}
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	commands := make(chan []byte, wsCommandQueueSize)
	workerDone, writeDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(workerDone)
		ws.runWSCommands(ctx, socket, commands)
	}()
	go func() {
		defer close(writeDone)
		defer func() { _ = conn.Close() }()
		defer cancel()
		ws.writeSocket(socket, &pending, ctx.Done())
	}()
	defer func() {
		cancel()
		_ = conn.Close()
		<-writeDone
		<-workerDone
	}()

	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			// Gorilla sends the close frame for protocol errors and read limits.
			return
		}
		switch {
		case kind == websocket.BinaryMessage:
			ws.sendClose(conn, websocket.CloseUnsupportedData, "text messages only")
			return
		case !utf8.Valid(data):
			ws.sendClose(conn, websocket.CloseInvalidFramePayloadData, "invalid UTF-8")
			return
		}

		select {
		case <-ctx.Done():
			return
		case commands <- data:
		default:
			ws.sendClose(conn, websocket.CloseTryAgainLater, "inbound queue full")
			return
		}
	}
}

func (ws *wsEndpoint) runWSCommands(ctx context.Context, socket *socketSession, commands <-chan []byte) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ws.stopping:
			return
		case data := <-commands:
			if ctx.Err() != nil || !time.Now().Before(socket.expiresAt) {
				return
			}
			select {
			case <-ws.stopping:
				return
			default:
			}
			ws.handleWSCommand(ctx, socket, data)
		}
	}
}

// writeSocket serializes data frames and sends heartbeat pings.
func (ws *wsEndpoint) writeSocket(socket *socketSession, pending *atomic.Pointer[pingProbe], readDone <-chan struct{}) {
	conn := socket.conn
	pings := time.NewTicker(ws.timing.pingInterval)
	defer pings.Stop()
	expiry := time.NewTimer(time.Until(socket.expiresAt))
	defer expiry.Stop()
	var pongTimer *time.Timer
	defer func() {
		pending.Store(nil)
		if pongTimer != nil {
			pongTimer.Stop()
		}
	}()

	for {
		// Check close signals before draining pending events, even with a full queue.
		select {
		case <-readDone:
			return
		case <-ws.stopping:
			ws.sendClose(conn, websocket.CloseGoingAway, "server shutting down")
			return
		case <-socket.overloaded:
			ws.sendClose(conn, websocket.CloseTryAgainLater, "outbound queue full")
			return
		default:
		}
		if !time.Now().Before(socket.expiresAt) {
			ws.sendClose(conn, wsTokenExpired, "access token expired")
			return
		}

		select {
		case <-readDone:
		case <-ws.stopping:
		case <-socket.overloaded:
		case <-expiry.C:
		case event := <-socket.outgoing:
			now := time.Now()
			if !now.Before(socket.expiresAt) {
				continue
			}
			deadline := now.Add(ws.timing.writeTimeout)
			if socket.expiresAt.Before(deadline) {
				deadline = socket.expiresAt
			}
			if err := conn.SetWriteDeadline(deadline); err != nil {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, event); err != nil {
				return
			}
		case <-pings.C:
			ping := &pingProbe{payload: rand.Text()}
			if !pending.CompareAndSwap(nil, ping) {
				continue
			}
			if pongTimer != nil {
				pongTimer.Stop()
			}
			if err := conn.WriteControl(websocket.PingMessage, []byte(ping.payload), time.Now().Add(ws.timing.writeTimeout)); err != nil {
				return
			}
			pongTimer = time.AfterFunc(ws.timing.pongTimeout, func() {
				// A matching Pong clears this probe. Otherwise Close unblocks any
				// in-flight write, even while the writer cannot service its select.
				if pending.CompareAndSwap(ping, nil) {
					_ = conn.Close()
				}
			})
		}
	}
}

func (ws *wsEndpoint) sendClose(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(ws.timing.writeTimeout))
}
