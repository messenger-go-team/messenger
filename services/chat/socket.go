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

type wsInboundCommand struct {
	command wsCommand
	problem string
}

type socketSession struct {
	conn       *websocket.Conn
	userID     string
	expiresAt  time.Time
	outgoing   chan []byte
	overloaded chan struct{}

	// Protected by the hub mutex, except for the readiness channel.
	presenceSince   uint64
	presenceReady   chan struct{}
	presenceSent    map[string]presenceView
	presencePending map[string]presenceSnapshot

	// Protected by the endpoint's typing mutex.
	nextTypingAt  time.Time
	pendingTyping *typingRequest
}

func newSocketSession(conn *websocket.Conn, identity jwtauth.Identity) *socketSession {
	return &socketSession{
		conn:          conn,
		userID:        identity.UserID,
		expiresAt:     identity.ExpiresAt,
		outgoing:      make(chan []byte, wsQueueSize),
		overloaded:    make(chan struct{}),
		presenceReady: make(chan struct{}, 1),
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
	pingInterval    time.Duration
	pongTimeout     time.Duration
	writeTimeout    time.Duration
	presenceRefresh time.Duration
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
		if ping := pending.Load(); ping != nil && ping.payload == payload && pending.CompareAndSwap(ping, nil) {
			ws.hub.confirmActivity(socket, time.Now())
		}
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	commands := make(chan wsInboundCommand, wsCommandQueueSize)
	receipts := make(chan wsInboundCommand, wsReceiptQueueSize)
	receiptDone := make(chan struct{})
	typingWake := make(chan struct{}, 1)
	workerDone, writeDone, typingDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(typingDone)
		ws.runWSTyping(ctx, socket, typingWake)
	}()
	go func() {
		defer close(workerDone)
		ws.runWSCommands(ctx, socket, commands)
	}()
	go func() {
		defer close(receiptDone)
		ws.runWSCommands(ctx, socket, receipts)
	}()
	go func() {
		defer close(writeDone)
		defer func() {
			ws.hub.unregister(socket)
			_ = conn.Close()
		}()
		defer cancel()
		ws.writeSocket(socket, &pending, ctx.Done())
	}()
	defer func() {
		cancel()
		ws.hub.unregister(socket)
		_ = conn.Close()
		// Committed messages and receipts may still be fanning out.
		ws.clearSocketTyping(socket)
		<-writeDone
		<-workerDone
		<-receiptDone
		<-typingDone
	}()

	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			// Gorilla sends the close frame for protocol errors and read limits.
			return
		}
		receivedAt := time.Now()
		switch {
		case kind == websocket.BinaryMessage:
			ws.sendClose(conn, websocket.CloseUnsupportedData, "text messages only")
			return
		case !utf8.Valid(data):
			ws.sendClose(conn, websocket.CloseInvalidFramePayloadData, "invalid UTF-8")
			return
		}

		command, problem := parseWSCommand(data)
		if problem == "" {
			ws.hub.confirmActivity(socket, receivedAt)
		}
		if problem == "" && command.kind == wsTypingType {
			if ctx.Err() == nil && receivedAt.Before(socket.expiresAt) {
				ws.queueTyping(socket, command, receivedAt, typingWake)
			}
			continue
		}
		inbound := wsInboundCommand{command: command, problem: problem}
		if isWSReceiptType(command.kind) {
			if problem != "" {
				ws.replyWSError(socket, command, problem)
				continue
			}
			// Receipt backpressure is local to this lane. The reader and text
			// worker can continue while either receipt RPC is blocked.
			select {
			case <-ctx.Done():
				return
			case receipts <- inbound:
			default:
				ws.replyWSError(socket, command, "temporarily_unavailable")
			}
			continue
		}
		select {
		case <-ctx.Done():
			return
		case commands <- inbound:
		default:
			ws.sendClose(conn, websocket.CloseTryAgainLater, "inbound queue full")
			return
		}
	}
}

func (ws *wsEndpoint) runWSCommands(ctx context.Context, socket *socketSession, commands <-chan wsInboundCommand) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ws.stopping:
			return
		case inbound := <-commands:
			if ctx.Err() != nil || !time.Now().Before(socket.expiresAt) {
				return
			}
			select {
			case <-ws.stopping:
				return
			default:
			}
			ws.handleWSCommand(ctx, socket, inbound)
		}
	}
}

// writeSocket serializes data frames and sends heartbeat pings.
func (ws *wsEndpoint) writeSocket(socket *socketSession, pending *atomic.Pointer[pingProbe], readDone <-chan struct{}) {
	conn := socket.conn
	pings := time.NewTicker(ws.timing.pingInterval)
	defer pings.Stop()
	expiryCheck := make(chan struct{}, 1)
	expiry := time.AfterFunc(time.Until(socket.expiresAt), func() {
		if !time.Now().Before(socket.expiresAt) {
			ws.hub.unregister(socket)
		}
		expiryCheck <- struct{}{}
	})
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
		case <-expiryCheck:
			// The timer measures elapsed time. Re-arm if the wall clock moved back.
			if remaining := time.Until(socket.expiresAt); remaining > 0 {
				expiry.Reset(remaining)
			}
		case event := <-socket.outgoing:
			if err := ws.writeSocketEvent(socket, event); err != nil {
				return
			}
		case <-socket.presenceReady:
			if err := ws.writePresenceEvent(socket); err != nil {
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
			if err := conn.WriteControl(websocket.PingMessage, []byte(ping.payload), ws.socketWriteDeadline(socket, time.Now())); err != nil {
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

func (ws *wsEndpoint) writeSocketEvent(socket *socketSession, event []byte) error {
	now := time.Now()
	if !now.Before(socket.expiresAt) {
		return nil
	}
	return writeSocketText(socket, event, ws.socketWriteDeadline(socket, now))
}

func writeSocketText(socket *socketSession, event []byte, deadline time.Time) error {
	if err := socket.conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return socket.conn.WriteMessage(websocket.TextMessage, event)
}

func (ws *wsEndpoint) socketWriteDeadline(socket *socketSession, now time.Time) time.Time {
	return now.Add(min(ws.timing.writeTimeout, socket.expiresAt.Sub(now)))
}

func (ws *wsEndpoint) sendClose(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(ws.timing.writeTimeout))
}
