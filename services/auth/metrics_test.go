package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/internal/metrics"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
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

func TestAuthMetricsTrackRoutesThroughMiddleware(t *testing.T) {
	const marker = "private-auth-metric-marker"
	service := stubAuthentication{
		registerFunc: func(context.Context, string, string) (auth.User, error) { return auth.User{}, nil },
		loginFunc:    func(context.Context, string, string) (auth.Session, error) { return auth.Session{}, errors.New(marker) },
	}
	verifier, err := jwtauth.New("auth-metrics-test-secret-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	routes := http.NewServeMux()
	routes.Handle("/internal/", newInternalHandler(nil, "auth-metrics-internal-secret-at-least-32-bytes"))
	routes.Handle("/", newDirectoryHandler(nil, verifier))
	var ready atomic.Bool
	ready.Store(true)
	handler := newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), service, nil, routes)
	for _, tc := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/auth/register", http.StatusCreated},
		{http.MethodPost, "/auth/login", http.StatusInternalServerError},
		{http.MethodPost, "/auth/refresh", http.StatusUnauthorized},
		{http.MethodPost, "/auth/logout", http.StatusUnauthorized},
		{http.MethodPut, "/contacts/first-" + marker + "?tracking=" + marker, http.StatusUnauthorized},
		{http.MethodPut, "/contacts/second-" + marker, http.StatusUnauthorized},
		{http.MethodGet, "/internal/users/" + marker, http.StatusUnauthorized},
		{http.MethodGet, "/" + marker, http.StatusNotFound},
		{http.MethodGet, "/readyz", http.StatusOK},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{"username":"alice","password":"`+marker+`"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+marker)
		r.Header.Set("X-Request-ID", marker)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: got %d, want %d", tc.method, tc.path, w.Code, tc.status)
		}
	}
	body := scrapeAuthMetrics(t, handler)
	for _, labelsAndCount := range []string{
		`{operation="POST /auth/register",result="2xx"} 1`,
		`{operation="POST /auth/login",result="5xx"} 1`,
		`{operation="POST /auth/refresh",result="4xx"} 1`,
		`{operation="POST /auth/logout",result="4xx"} 1`,
		`{operation="PUT /contacts/{contact_id}",result="4xx"} 2`,
		`{operation="GET /internal/users/{user_id}",result="4xx"} 1`,
	} {
		for _, family := range []string{"auth_http_requests_total", "auth_http_request_duration_seconds_count"} {
			if !strings.Contains(body, family+labelsAndCount+"\n") {
				t.Errorf("missing %s%s", family, labelsAndCount)
			}
		}
	}
	for _, forbidden := range []string{marker, "GET /readyz", "GET /metrics"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("unexpected metric dimension or value %q", forbidden)
		}
	}
}

func TestAuthMetricsDistinguishRecoveredAndAbortedResponses(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /before", func(http.ResponseWriter, *http.Request) { panic("before response") })
	mux.HandleFunc("GET /after", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		panic("after response")
	})
	mux.HandleFunc("GET /hints", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusBadRequest)
	})
	handler := newServiceHandler(&atomic.Bool{}, newLogger(io.Discard, "auth", slog.LevelInfo), mux)
	for _, path := range []string{"/before", "/after", "/hints"} {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil && (path != "/after" || recovered != http.ErrAbortHandler) {
					t.Fatalf("%s: unexpected panic %v", path, recovered)
				} else if path == "/after" && recovered != http.ErrAbortHandler {
					t.Fatal("partial response was not aborted")
				}
			}()
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		}()
	}
	body := scrapeAuthMetrics(t, handler)
	for _, labelsAndCount := range []string{
		`{operation="GET /before",result="5xx"} 1`,
		`{operation="GET /after",result="aborted"} 1`,
		`{operation="GET /hints",result="4xx"} 1`,
	} {
		if !strings.Contains(body, "auth_http_requests_total"+labelsAndCount+"\n") {
			t.Errorf("missing observation %s", labelsAndCount)
		}
	}
}

func TestAuthMetricsScrapeWhileDBPoolIsSaturated(t *testing.T) {
	db := emptyAuthTestDatabase(t)
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	held, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()
	waitCtx, cancelWait := context.WithCancel(ctx)
	defer cancelWait()
	waitResult := make(chan error, 1)
	go func() { waitResult <- db.PingContext(waitCtx) }()
	// Cancel only after the pool has queued the waiter, even on a slow runner.
	for db.Stats().WaitCount == 0 {
		if ctx.Err() != nil {
			t.Fatal("database pool did not queue the waiter")
		}
		time.Sleep(time.Millisecond)
	}
	cancelWait()
	if err := <-waitResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected a canceled wait in the full pool, got %v", err)
	}

	handler := newServiceHandlerWithReadiness(&atomic.Bool{}, newLogger(io.Discard, "auth", slog.LevelInfo),
		http.NotFoundHandler(), nil, metrics.NewDBPoolCollector("auth", db))
	body := scrapeAuthMetrics(t, handler)
	for _, sample := range []string{
		`auth_db_pool_connections{state="open"} 1`,
		`auth_db_pool_connections{state="in_use"} 1`,
		`auth_db_pool_connections{state="idle"} 0`,
		`auth_db_pool_max_open_connections 1`,
		`auth_db_pool_waits_total 1`,
	} {
		if !strings.Contains(body, sample+"\n") {
			t.Errorf("missing metric %s", sample)
		}
	}
	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	waits := families["auth_db_pool_wait_duration_seconds_total"].GetMetric()
	if len(waits) != 1 || waits[0].GetCounter().GetValue() <= 0 {
		t.Fatal("expected positive accumulated pool wait in seconds")
	}
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	body = scrapeAuthMetrics(t, handler)
	for _, sample := range []string{`auth_db_pool_connections{state="in_use"} 0`, `auth_db_pool_connections{state="idle"} 1`} {
		if !strings.Contains(body, sample+"\n") {
			t.Errorf("missing metric after returning connection: %s", sample)
		}
	}
}

func scrapeAuthMetrics(t *testing.T, handler http.Handler) string {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	r.Header.Set("Accept", "text/plain; version=0.0.4")
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body)
	}
	return w.Body.String()
}
