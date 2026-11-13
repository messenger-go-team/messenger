package main

import (
	"crypto/rand"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	wsMaxMessageBytes = 64 * 1024
	wsTokenExpired    = 4401
)

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

// pingProbe lets the reader notify the heartbeat loop about its current Ping.
type pingProbe struct {
	payload string
	pong    chan struct{}
}

func (ws *wsEndpoint) serveSocket(conn *websocket.Conn, expiresAt time.Time) {
	conn.SetReadLimit(wsMaxMessageBytes)
	var pending atomic.Pointer[pingProbe]
	conn.SetPongHandler(func(payload string) error {
		if ping := pending.Load(); ping != nil && ping.payload == payload {
			select {
			case ping.pong <- struct{}{}:
			default:
			}
		}
		return nil
	})

	readDone, heartbeatDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		defer func() { _ = conn.Close() }()
		ws.heartbeat(conn, expiresAt, &pending, readDone)
	}()
	defer func() {
		close(readDone)
		<-heartbeatDone
	}()

	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			// Gorilla sends the close frame itself for protocol errors and read limits.
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
		// Application commands are handled by T35. Reading here keeps processing control frames.
	}
}

func (ws *wsEndpoint) heartbeat(conn *websocket.Conn, expiresAt time.Time, pending *atomic.Pointer[pingProbe], readDone <-chan struct{}) {
	pings := time.NewTicker(ws.timing.pingInterval)
	defer pings.Stop()
	expiry := time.NewTimer(time.Until(expiresAt))
	defer expiry.Stop()
	pongTimer := time.NewTimer(ws.timing.pongTimeout)
	pongTimer.Stop()
	defer pongTimer.Stop()
	var pong <-chan struct{}
	var pongDeadline <-chan time.Time

	for {
		select {
		case <-readDone:
			return
		case <-ws.stopping:
			ws.sendClose(conn, websocket.CloseGoingAway, "server shutting down")
			return
		case <-expiry.C:
			ws.sendClose(conn, wsTokenExpired, "access token expired")
			return
		case <-pings.C:
			ping := &pingProbe{payload: rand.Text(), pong: make(chan struct{}, 1)}
			pending.Store(ping)
			if err := conn.WriteControl(websocket.PingMessage, []byte(ping.payload), time.Now().Add(ws.timing.writeTimeout)); err != nil {
				return
			}
			pong = ping.pong
			pongTimer.Reset(ws.timing.pongTimeout)
			pongDeadline = pongTimer.C
		case <-pong:
			pending.Store(nil)
			pongTimer.Stop()
			pong, pongDeadline = nil, nil
		case <-pongDeadline:
			// Returning closes the transport even if the peer is no longer responsive.
			return
		}
	}
}

func (ws *wsEndpoint) sendClose(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(ws.timing.writeTimeout))
}
