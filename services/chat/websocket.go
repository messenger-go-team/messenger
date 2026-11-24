package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/prometheus/client_golang/prometheus"
)

const wsProtocol = "messenger.v1"

// wsEndpoint tracks upgraded sockets so they can be drained alongside HTTP.
type wsEndpoint struct {
	ready    *atomic.Bool
	verifier *jwtauth.Verifier
	upgrader websocket.Upgrader
	timing   wsTiming
	stopping chan struct{}

	fanoutCtx    context.Context
	cancelFanout context.CancelFunc

	hub            *connectionHub
	broker         Broker
	history        historyv1.HistoryServiceClient
	historyTimeout time.Duration
	sendLimiter    *sendLimiter
	sendRejections prometheus.Counter
	logger         *slog.Logger

	mu     sync.Mutex
	active sync.WaitGroup
}

func newWSEndpoint(cfg config, ready *atomic.Bool, timing wsTiming,
	history historyv1.HistoryServiceClient, logger *slog.Logger,
) *wsEndpoint {
	hub := newConnectionHub()
	fanoutCtx, cancelFanout := context.WithCancel(context.Background())
	return &wsEndpoint{
		logger:         logger,
		ready:          ready,
		verifier:       cfg.JWTVerifier,
		timing:         timing,
		stopping:       make(chan struct{}),
		fanoutCtx:      fanoutCtx,
		cancelFanout:   cancelFanout,
		hub:            hub,
		broker:         memoryBroker{hub: hub},
		history:        history,
		historyTimeout: cfg.HistoryRPCTimeout,
		sendLimiter:    newSendLimiter(cfg.SendInterval, cfg.SendBurst, time.Now),
		sendRejections: prometheus.NewCounter(prometheus.CounterOpts{
			Name:        "chat_ws_message_send_rejected_total",
			Help:        "Number of valid message.send commands rejected by Chat before calling History.",
			ConstLabels: prometheus.Labels{"reason": wsRateLimited},
		}),
		upgrader: websocket.Upgrader{
			HandshakeTimeout: timing.writeTimeout,
			CheckOrigin: func(r *http.Request) bool {
				origins := r.Header.Values("Origin")
				if len(origins) != 1 {
					return false
				}
				_, allowed := cfg.AllowedOrigins[origins[0]]
				return allowed
			},
			Error: func(w http.ResponseWriter, _ *http.Request, status int, _ error) {
				writeHandshakeError(w, status)
			},
		},
	}
}

func (ws *wsEndpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !ws.ready.Load() {
		writeHandshakeError(w, http.StatusServiceUnavailable)
		return
	}
	token, validProtocol := handshakeCredentials(r.Header.Values("Sec-WebSocket-Protocol"))
	if r.Method != http.MethodGet || !websocket.IsWebSocketUpgrade(r) || !validProtocol {
		writeHandshakeError(w, http.StatusBadRequest)
		return
	}
	if !ws.upgrader.CheckOrigin(r) {
		writeHandshakeError(w, http.StatusForbidden)
		return
	}
	identity, err := ws.verifier.Verify(token)
	if err != nil {
		writeHandshakeError(w, http.StatusUnauthorized)
		return
	}
	if !ws.admit() {
		writeHandshakeError(w, http.StatusServiceUnavailable)
		return
	}
	defer ws.active.Done()

	// Pass only the selected subprotocol and our response request ID to 101.
	headers := http.Header{}
	headers.Set("Sec-WebSocket-Protocol", wsProtocol)
	headers.Set("X-Request-ID", w.Header().Get("X-Request-ID"))
	conn, err := ws.upgrader.Upgrade(w, r, headers)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	socket := newSocketSession(conn, identity)
	if !ws.hub.register(socket) {
		return
	}
	defer ws.hub.unregister(socket)
	ws.serveSocket(socket)
}

// handshakeCredentials reads all offered protocol lines, including repeated headers.
func handshakeCredentials(values []string) (token string, validProtocol bool) {
	var protocols, credentials int
	for _, value := range values {
		for item := range strings.SplitSeq(value, ",") {
			protocol := strings.Trim(item, " \t")
			if protocol == wsProtocol {
				protocols++
			}
			if raw, found := strings.CutPrefix(protocol, "bearer."); found {
				credentials++
				token = raw
			}
		}
	}
	if credentials != 1 {
		token = ""
	}
	return token, protocols == 1
}

func writeHandshakeError(w http.ResponseWriter, status int) {
	var code, message string
	switch status {
	case http.StatusUnauthorized:
		code, message = "unauthorized", "Требуется действующий access-токен."
		w.Header().Set("WWW-Authenticate", "Bearer")
	case http.StatusForbidden:
		code, message = "origin_not_allowed", "Источник запроса не разрешён."
	case http.StatusServiceUnavailable:
		code, message = "service_unavailable", "Сервис временно недоступен."
	case http.StatusInternalServerError:
		code, message = "internal_error", "Внутренняя ошибка сервера."
	default:
		status = http.StatusBadRequest
		code, message = "invalid_handshake", "Некорректный запрос на WebSocket-подключение."
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}

// admit counts an in-progress upgrade before net/http gives up the socket.
func (ws *wsEndpoint) admit() bool {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if !ws.ready.Load() {
		return false
	}
	ws.active.Add(1)
	return true
}

func (ws *wsEndpoint) stopAccepting() {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	ws.ready.Store(false)
	close(ws.stopping)
	ws.cancelFanout()
}

func (ws *wsEndpoint) wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		ws.active.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("shutdown WebSocket: %w", ctx.Err())
	}
}
