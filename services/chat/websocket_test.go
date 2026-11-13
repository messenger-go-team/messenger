package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

const (
	testOrigin = "http://localhost:5173"
	testSecret = "0123456789abcdef0123456789abcdef"
)

func TestWSHandshake(t *testing.T) {
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming())
	server := httptest.NewServer(newServiceHandler(&ready, newLogger(io.Discard, "chat", cfg.LogLevel), ws))
	defer server.Close()

	token := signTestToken(t, time.Now().Add(time.Minute))
	header := testWSHeaders(token)
	header.Set("X-Request-ID", "test-handshake")
	conn, response := dialTestSocket(t, server.URL, header)
	defer func() { _ = conn.Close() }()
	if response.StatusCode != http.StatusSwitchingProtocols || conn.Subprotocol() != wsProtocol {
		t.Fatalf("handshake status=%d, protocol=%q", response.StatusCode, conn.Subprotocol())
	}
	if got := response.Header.Get("Sec-WebSocket-Protocol"); got != wsProtocol {
		t.Fatalf("unexpected selected protocol")
	}
	if got := response.Header.Get("X-Request-ID"); got != "test-handshake" {
		t.Fatalf("request ID = %q", got)
	}

	valid := wsProtocol + ", bearer." + token
	expired := signTestToken(t, time.Now().Add(-time.Minute))
	tests := []struct {
		name     string
		protocol []string
		origins  []string
		status   int
		code     string
	}{
		{"missing protocol", []string{"bearer." + token}, []string{testOrigin}, 400, "invalid_handshake"},
		{"missing JWT", []string{wsProtocol}, []string{testOrigin}, 401, "unauthorized"},
		{"invalid JWT", []string{wsProtocol + ", bearer.invalid"}, []string{testOrigin}, 401, "unauthorized"},
		{"expired JWT", []string{wsProtocol + ", bearer." + expired}, []string{testOrigin}, 401, "unauthorized"},
		{"duplicate credential", []string{valid, "bearer." + token}, []string{testOrigin}, 401, "unauthorized"},
		{"duplicate protocol", []string{valid, wsProtocol}, []string{testOrigin}, 400, "invalid_handshake"},
		{"missing origin", []string{valid}, nil, 403, "origin_not_allowed"},
		{"null origin", []string{valid}, []string{"null"}, 403, "origin_not_allowed"},
		{"foreign scheme", []string{valid}, []string{"https://localhost:5173"}, 403, "origin_not_allowed"},
		{"foreign port", []string{valid}, []string{"http://localhost:5174"}, 403, "origin_not_allowed"},
		{"duplicate origin", []string{valid}, []string{testOrigin, testOrigin}, 403, "origin_not_allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
			req.Header.Set("Sec-WebSocket-Version", "13")
			req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
			req.Header["Sec-Websocket-Protocol"] = tt.protocol
			req.Header["Origin"] = tt.origins
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			assertHandshakeError(t, resp, tt.status, tt.code, token)
		})
	}
}

func TestWSMessageLimits(t *testing.T) {
	tests := []struct {
		name string
		kind int
		body string
		code int
	}{
		{"too large", websocket.TextMessage, strings.Repeat("a", wsMaxMessageBytes+1), 1009},
		{"binary", websocket.BinaryMessage, "hello", 1003},
		{"bad UTF-8", websocket.TextMessage, "\xff", 1007},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			url := startTestChat(t, defaultWSTiming())
			conn, _ := dialTestSocket(t, url, testWSHeaders(signTestToken(t, time.Now().Add(time.Minute))))
			defer func() { _ = conn.Close() }()
			if err := conn.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("a", wsMaxMessageBytes))); err != nil {
				t.Fatal(err)
			}
			if err := conn.WriteMessage(tt.kind, []byte(tt.body)); err != nil {
				t.Fatal(err)
			}
			assertSocketClose(t, conn, tt.code)
		})
	}
}

func TestWSHeartbeat(t *testing.T) {
	timing := wsTiming{pingInterval: 200 * time.Millisecond, pongTimeout: 80 * time.Millisecond, writeTimeout: time.Second}
	for _, wrongPong := range []bool{false, true} {
		name := "silent client"
		if wrongPong {
			name = "unrelated pong"
		}
		t.Run(name, func(t *testing.T) {
			url := startTestChat(t, timing)
			conn, _ := dialTestSocket(t, url, testWSHeaders(signTestToken(t, time.Now().Add(time.Minute))))
			defer func() { _ = conn.Close() }()
			reply := conn.PingHandler()
			pings := 0
			conn.SetPingHandler(func(payload string) error {
				pings++
				if pings == 1 {
					return reply(payload)
				}
				if wrongPong {
					return reply("unrelated")
				}
				return nil
			})
			assertSocketClose(t, conn, websocket.CloseAbnormalClosure)
			if pings != 2 {
				t.Fatalf("received %d pings, want 2", pings)
			}
		})
	}
}

func TestWSExpiresWhileIdle(t *testing.T) {
	url := startTestChat(t, defaultWSTiming())
	token := signTestToken(t, time.Now().Add(1500*time.Millisecond))
	conn, _ := dialTestSocket(t, url, testWSHeaders(token))
	defer func() { _ = conn.Close() }()
	assertSocketClose(t, conn, wsTokenExpired)
}

func TestWSGracefulShutdown(t *testing.T) {
	cfg := testConfig(t)
	var ready atomic.Bool
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming())
	logger := newLogger(io.Discard, "chat", cfg.LogLevel)
	handler := newServiceHandler(&ready, logger, ws)
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, newHTTPServer(cfg, handler, logger), listener, ws, 2*time.Second, logger)
	}()
	url := "http://" + listener.Addr().String()
	header := testWSHeaders(signTestToken(t, time.Now().Add(time.Minute)))
	first, _ := dialTestSocket(t, url, header)
	defer func() { _ = first.Close() }()
	second, _ := dialTestSocket(t, url, header)
	defer func() { _ = second.Close() }()

	cancel()
	assertSocketClose(t, first, websocket.CloseGoingAway)
	assertSocketClose(t, second, websocket.CloseGoingAway)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("service did not stop")
	}
	if ready.Load() || ws.admit() {
		t.Fatal("service is still accepting connections")
	}
	request := httptest.NewRequest(http.MethodGet, "/ws", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	response := recorder.Result()
	defer func() { _ = response.Body.Close() }()
	assertHandshakeError(t, response, http.StatusServiceUnavailable, "service_unavailable", testSecret)
}

func TestWSAllowedOriginsConfig(t *testing.T) {
	origins, err := parseAllowedOrigins("http://localhost:5173, https://example.com")
	if err != nil || len(origins) != 2 {
		t.Fatalf("origins = %v, error = %v", origins, err)
	}
	for _, value := range []string{"", "*", "null", "https://example.com/", "http://user:password@example.com", "http://example.com:65536"} {
		if _, err := parseAllowedOrigins(value); err == nil {
			t.Errorf("accepted invalid WS_ALLOWED_ORIGINS value %q", value)
		}
	}
}

func testConfig(t *testing.T) config {
	t.Helper()
	cfg, err := loadConfig(func(name string) (string, bool) {
		value, ok := map[string]string{"JWT_SECRET": testSecret, "WS_ALLOWED_ORIGINS": testOrigin}[name]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func startTestChat(t *testing.T, timing wsTiming) string {
	t.Helper()
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	ws := newWSEndpoint(cfg, &ready, timing)
	logger := newLogger(io.Discard, "chat", cfg.LogLevel)
	server := httptest.NewServer(newServiceHandler(&ready, logger, ws))
	t.Cleanup(func() {
		ws.stopAccepting()
		ws.forceClose()
		server.Close()
	})
	return server.URL
}

func signTestToken(t *testing.T, expiry time.Time) string {
	t.Helper()
	issued := time.Now().Add(-time.Hour)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   "10000000-0000-4000-8000-000000000001",
		IssuedAt:  jwt.NewNumericDate(issued),
		ExpiresAt: jwt.NewNumericDate(expiry),
	})
	signed, err := token.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func testWSHeaders(token string) http.Header {
	header := http.Header{}
	header.Set("Origin", testOrigin)
	header.Add("Sec-WebSocket-Protocol", "bearer."+token)
	header.Add("Sec-WebSocket-Protocol", wsProtocol)
	return header
}

func dialTestSocket(t *testing.T, serverURL string, header http.Header) (*websocket.Conn, *http.Response) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	dialer := websocket.Dialer{EnableCompression: true}
	conn, resp, err := dialer.DialContext(ctx, "ws"+strings.TrimPrefix(serverURL, "http")+"/ws", header)
	if err != nil {
		if resp != nil {
			_ = resp.Body.Close()
			t.Fatalf("dial WebSocket: status=%d, error=%v", resp.StatusCode, err)
		}
		t.Fatal(err)
	}
	if resp.Header.Get("Sec-WebSocket-Extensions") != "" {
		_ = conn.Close()
		t.Fatal("server enabled a WebSocket extension")
	}
	return conn, resp
}

func assertHandshakeError(t *testing.T, resp *http.Response, status int, code, secret string) {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), secret) || resp.Header.Get("Sec-WebSocket-Protocol") != "" {
		t.Fatal("handshake error exposed credentials or selected a protocol")
	}
	var payload struct {
		Code    string
		Message string
	}
	if resp.StatusCode != status || json.Unmarshal(body, &payload) != nil || payload.Code != code || payload.Message == "" {
		t.Fatalf("expected status=%d and code=%s, got status=%d, body=%s", status, code, resp.StatusCode, body)
	}
	if status == http.StatusUnauthorized && resp.Header.Get("WWW-Authenticate") != "Bearer" {
		t.Fatal("missing Bearer challenge")
	}
}

func assertSocketClose(t *testing.T, conn *websocket.Conn, code int) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, _, err := conn.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != code {
		t.Fatalf("expected WebSocket close %d, got %v", code, err)
	}
}
