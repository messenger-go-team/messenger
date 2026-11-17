package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHealthAndReadiness(t *testing.T) {
	var ready atomic.Bool
	handler := newHandler(&ready, newLogger(io.Discard, "test", slog.LevelInfo))
	for _, tt := range []struct {
		method string
		path   string
		ready  bool
		status int
	}{
		{http.MethodGet, "/healthz", false, http.StatusOK},
		{http.MethodGet, "/readyz", false, http.StatusServiceUnavailable},
		{http.MethodGet, "/healthz", true, http.StatusOK},
		{http.MethodGet, "/readyz", true, http.StatusOK},
		{http.MethodGet, "/missing", true, http.StatusNotFound},
		{http.MethodPost, "/healthz", true, http.StatusMethodNotAllowed},
		{http.MethodGet, "/readyz", false, http.StatusServiceUnavailable},
	} {
		ready.Store(tt.ready)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tt.method, tt.path, nil))
		if response.Code != tt.status {
			t.Errorf("%s %s ready=%t: got %d, want %d",
				tt.method, tt.path, tt.ready, response.Code, tt.status)
		}
		if tt.path == "/healthz" && tt.method == http.MethodGet || tt.path == "/readyz" {
			if !json.Valid(response.Body.Bytes()) {
				t.Errorf("invalid JSON health response: %s", response.Body)
			}
		}
	}
}

func TestRequestLogging(t *testing.T) {
	for _, input := range []string{"trace-42", "", strings.Repeat("x", 65), "bad id"} {
		t.Run(input, func(t *testing.T) {
			var output bytes.Buffer
			logger := newLogger(&output, "auth", slog.LevelInfo)
			handler := requestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				loggerFromContext(r.Context()).InfoContext(r.Context(), "inside handler")
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/healthz?access_token=never-log-this", nil)
			request.Header.Set("X-Request-ID", input)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			id := response.Header().Get("X-Request-ID")
			if !validRequestID.MatchString(id) {
				t.Fatalf("invalid response request ID %q", id)
			}
			if input == "trace-42" && id != input {
				t.Fatalf("valid request ID was replaced: %q", id)
			}
			if strings.Contains(output.String(), "never-log-this") {
				t.Fatal("query leaked into access log")
			}
			lines := strings.Split(strings.TrimSpace(output.String()), "\n")
			if len(lines) != 2 {
				t.Fatalf("got %d log lines, want handler and access records", len(lines))
			}
			for _, line := range lines {
				var record map[string]any
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal(err)
				}
				if record["service"] != "auth" || record["request_id"] != id {
					t.Fatalf("missing log context: %v", record)
				}
			}
		})
	}
}
