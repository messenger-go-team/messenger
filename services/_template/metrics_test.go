package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

func TestMetricsRoute(t *testing.T) {
	var ready atomic.Bool
	ready.Store(true)
	handler := newHandler(&ready, newLogger(io.Discard, "test", slog.LevelInfo))
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.Header.Set("Accept", "text/plain; version=0.0.4")
	request.Header.Set("X-Request-ID", "scrape-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("X-Request-ID") != "scrape-test" {
		t.Fatalf("unexpected metrics response: %d %v", response.Code, response.Header())
	}
	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if families["go_goroutines"] == nil || families["process_cpu_seconds_total"] == nil {
		t.Fatal("base metrics did not reach the service route")
	}
	for _, tt := range []struct {
		method string
		path   string
		status int
		body   string
	}{
		{http.MethodPost, "/metrics", http.StatusMethodNotAllowed, ""},
		{http.MethodGet, "/healthz", http.StatusOK, "{\"status\":\"ok\"}\n"},
		{http.MethodGet, "/readyz", http.StatusOK, "{\"status\":\"ready\"}\n"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tt.method, tt.path, nil))
		if response.Code != tt.status || tt.body != "" && response.Body.String() != tt.body {
			t.Fatalf("%s %s: %d %s", tt.method, tt.path, response.Code, response.Body)
		}
	}
}
