package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type recoveryLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *recoveryLogs) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *recoveryLogs) records(t *testing.T) []map[string]any {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var records []map[string]any
	scanner := bufio.NewScanner(strings.NewReader(b.buffer.String()))
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}

func TestRecoverPanicReturnsAPIErrorAndKeepsServing(t *testing.T) {
	for _, mode := range []string{"unwritten", "generated id", "early hints", "invalid status"} {
		t.Run(mode, func(t *testing.T) {
			var logs recoveryLogs
			logger := newLogger(&logs, "auth", slog.LevelInfo)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/healthy" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				switch mode {
				case "early hints":
					w.WriteHeader(http.StatusEarlyHints)
				case "invalid status":
					w.WriteHeader(0) // net/http panics before committing a response.
				default:
					w.Header().Set("Content-Length", "1")
					w.Header().Set("Content-Encoding", "gzip")
					w.Header().Set("X-Request-ID", "handler-overwrote-the-header")
				}
				panic("private panic details")
			})
			server := httptest.NewServer(requestLogging(logger, recoverPanic(handler)))
			defer server.Close()
			client := server.Client()
			client.Timeout = 5 * time.Second
			request, err := http.NewRequest(http.MethodGet, server.URL+"/panic", nil)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "generated id" {
				request.Header.Set("X-Request-ID", "panic-test")
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if err != nil {
				t.Fatal(err)
			}
			requestID := response.Header.Get("X-Request-ID")
			if !validRequestID.MatchString(requestID) {
				t.Fatalf("invalid request_id %q", requestID)
			}
			if mode != "generated id" && requestID != "panic-test" {
				t.Fatalf("request_id changed: %q", requestID)
			}
			if response.StatusCode != http.StatusInternalServerError ||
				response.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected error response: %d %v %s", response.StatusCode, response.Header, body)
			}
			var apiError map[string]string
			if err := json.Unmarshal(body, &apiError); err != nil {
				t.Fatal(err)
			}
			if len(apiError) != 3 || apiError["code"] != "internal_error" ||
				apiError["request_id"] != requestID || apiError["message"] == "" ||
				strings.Contains(string(body), "private panic details") {
				t.Fatalf("unexpected API error: %s", body)
			}
			healthy, err := client.Get(server.URL + "/healthy")
			if err != nil {
				t.Fatal(err)
			}
			if err := healthy.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if healthy.StatusCode != http.StatusNoContent {
				t.Fatalf("next request failed: %d", healthy.StatusCode)
			}
			panics := 0
			for _, record := range logs.records(t) {
				if record["msg"] == "panic recovered" {
					panics++
					stack, hasStack := record["stack"].(string)
					if record["request_id"] != requestID || record["service"] != "auth" ||
						record["level"] != "ERROR" || !hasStack || stack == "" {
						t.Fatalf("missing diagnostic context: %v", record)
					}
				}
			}
			if panics != 1 {
				t.Fatalf("got %d panic records, want 1", panics)
			}
		})
	}
}

func TestRecoverPanicAbortsStartedResponse(t *testing.T) {
	for _, mode := range []string{"header", "body", "flush", "controller flush", "switching protocols"} {
		t.Run(mode, func(t *testing.T) {
			var logs recoveryLogs
			handler := requestLogging(newLogger(&logs, "test", slog.LevelInfo),
				recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch mode {
					case "header":
						w.WriteHeader(http.StatusAccepted)
					case "body":
						if _, err := io.WriteString(w, "partial"); err != nil {
							t.Error(err)
						}
					case "flush":
						w.(http.Flusher).Flush()
					case "controller flush":
						if err := http.NewResponseController(w).Flush(); err != nil {
							t.Error(err)
						}
					case "switching protocols":
						w.WriteHeader(http.StatusSwitchingProtocols)
					}
					panic("after response started")
				})))
			response := httptest.NewRecorder()
			value := capturePanic(func() {
				handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
			})
			if value != http.ErrAbortHandler {
				t.Fatalf("got panic %v, want ErrAbortHandler", value)
			}
			if strings.Contains(response.Body.String(), "internal_error") {
				t.Fatalf("recovery appended JSON to a started response: %s", response.Body)
			}
		})
	}
}

func TestRecoverPanicPreservesErrAbortHandler(t *testing.T) {
	var logs recoveryLogs
	handler := requestLogging(newLogger(&logs, "test", slog.LevelInfo),
		recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic(http.ErrAbortHandler)
		})))
	response := httptest.NewRecorder()
	value := capturePanic(func() {
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	})
	if value != http.ErrAbortHandler || response.Body.Len() != 0 {
		t.Fatalf("abort was changed: %v, body=%q", value, response.Body)
	}
	for _, record := range logs.records(t) {
		if record["msg"] == "panic recovered" {
			t.Fatal("ErrAbortHandler must not be logged as an unexpected panic")
		}
	}
}

func TestRecoverPanicAfterFlushInterruptsNetworkResponse(t *testing.T) {
	handler := requestLogging(newLogger(io.Discard, "test", slog.LevelInfo),
		recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, err := io.WriteString(w, "partial\n"); err != nil {
				t.Error(err)
			}
			w.(http.Flusher).Flush()
			panic("after flush")
		})))
	server := httptest.NewServer(handler)
	defer server.Close()
	response, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if closeErr := response.Body.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got body=%q error=%v, want an interrupted response", body, err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "partial\n" {
		t.Fatalf("started response was rewritten: %d %q", response.StatusCode, body)
	}
}

type transparentResponse struct{ http.ResponseWriter }

func (w transparentResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func TestRecoverPanicClosesHijackedConnection(t *testing.T) {
	for _, mode := range []string{"direct", "controller", "transparent wrapper"} {
		t.Run(mode, func(t *testing.T) {
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var buffer *bufio.ReadWriter
				var err error
				if mode == "direct" {
					_, buffer, err = w.(http.Hijacker).Hijack()
				} else {
					_, buffer, err = http.NewResponseController(w).Hijack()
				}
				if err != nil {
					t.Error(err)
					return
				}
				if _, err := buffer.WriteString("upgraded\n"); err != nil {
					t.Error(err)
				}
				if err := buffer.Flush(); err != nil {
					t.Error(err)
				}
				panic("after hijack")
			})
			recovery := recoverPanic(inner)
			if mode == "transparent wrapper" {
				recovery = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					recoverPanic(inner).ServeHTTP(transparentResponse{w}, r)
				})
			}
			server := httptest.NewServer(requestLogging(newLogger(io.Discard, "test", slog.LevelInfo), recovery))
			defer server.Close()
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := conn.Close(); err != nil {
					t.Error(err)
				}
			}()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: test\r\n\r\n"); err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(conn)
			first, err := reader.ReadString('\n')
			if err != nil || first != "upgraded\n" {
				t.Fatalf("hijack failed: %q %v", first, err)
			}
			rest, err := io.ReadAll(reader)
			if err != nil || len(rest) != 0 {
				t.Fatalf("connection was not cleanly closed after panic: %q %v", rest, err)
			}
		})
	}
}

func TestRecoverPanicDoesNotInventWriterCapabilities(t *testing.T) {
	handler := requestLogging(newLogger(io.Discard, "test", slog.LevelInfo),
		recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := w.(http.Flusher); ok {
				t.Error("unsupported Flusher was advertised")
			}
			if _, ok := w.(http.Hijacker); ok {
				t.Error("unsupported Hijacker was advertised")
			}
			controller := http.NewResponseController(w)
			if err := controller.Flush(); !errors.Is(err, http.ErrNotSupported) {
				t.Errorf("unsupported Flush: %v", err)
			}
			if _, _, err := controller.Hijack(); !errors.Is(err, http.ErrNotSupported) {
				t.Errorf("unsupported Hijack: %v", err)
			}
			panic("still unwritten")
		})))
	response := httptest.NewRecorder()
	// Deliberately hide Recorder's Flush without offering Unwrap.
	basic := struct{ http.ResponseWriter }{response}
	handler.ServeHTTP(basic, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusInternalServerError || !json.Valid(response.Body.Bytes()) {
		t.Fatalf("unsupported Flush incorrectly committed the response: %d %s", response.Code, response.Body)
	}
}

func capturePanic(fn func()) (value any) {
	defer func() { value = recover() }()
	fn()
	return nil
}

func TestRecoveryKeepsSuccessfulUpgradeOpen(t *testing.T) {
	taken := make(chan net.Conn, 1)
	finished := make(chan struct{})
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		taken <- conn
		if _, err := buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test-protocol\r\n\r\n"); err != nil {
			t.Error(err)
		}
		if err := buffer.Flush(); err != nil {
			t.Error(err)
		}
	})
	stack := requestLogging(newLogger(io.Discard, "test", slog.LevelInfo), recoverPanic(inner))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stack.ServeHTTP(w, r)
		close(finished)
	}))
	defer server.Close()
	client, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := client.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(client, "GET / HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: test-protocol\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade returned %d", response.StatusCode)
	}
	await(t, finished)
	var connection net.Conn
	select {
	case connection = <-taken:
	default:
		t.Fatal("connection was not hijacked")
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := connection.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(connection, "still open\n"); err != nil {
		t.Fatal(err)
	}
	line, err := reader.ReadString('\n')
	if err != nil || line != "still open\n" {
		t.Fatalf("successful upgrade was interrupted: %q %v", line, err)
	}
}
