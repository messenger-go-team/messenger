package main

import (
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sync/atomic"
	"time"
)

type requestLoggerKey struct{}

var validRequestID = regexp.MustCompile("^[A-Za-z0-9._-]{1,64}$")

func newLogger(output io.Writer, service string, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{Level: level})).
		With("service", service)
}

// Handlers use this logger so that their records include request_id.
func loggerFromContext(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(requestLoggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}

func requestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID.MatchString(id) {
			id = rand.Text()
		}
		w.Header().Set("X-Request-ID", id)
		requestLogger := logger.With("request_id", id)
		r = r.WithContext(context.WithValue(r.Context(), requestLoggerKey{}, requestLogger))
		start := time.Now()
		defer func() {
			// No query, credentials, headers or body are written to access logs.
			requestLogger.InfoContext(r.Context(), "http request",
				"method", r.Method, "path", r.URL.Path,
				"duration_ms", time.Since(start).Milliseconds())
		}()
		// Keep the original ResponseWriter, including support for future upgrades.
		next.ServeHTTP(w, r)
	})
}

func newHandler(ready *atomic.Bool, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeHealth(w, r, http.StatusOK, "{\"status\":\"ok\"}\n")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if !ready.Load() {
			writeHealth(w, r, http.StatusServiceUnavailable, "{\"status\":\"not_ready\"}\n")
			return
		}
		writeHealth(w, r, http.StatusOK, "{\"status\":\"ready\"}\n")
	})
	return requestLogging(logger, mux)
}

func writeHealth(w http.ResponseWriter, r *http.Request, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := io.WriteString(w, body); err != nil {
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "write health response", "error", err)
	}
}
