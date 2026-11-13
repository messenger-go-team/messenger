package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

func TestServiceAuthentication(t *testing.T) {
	const secret = "test-template-secret-at-least-32-bytes"
	const userID = "abcdef01-2345-4567-89ab-cdef01234567"
	cfg, err := loadConfig(func(key string) (string, bool) {
		return secret, key == "JWT_SECRET"
	})
	if err != nil {
		t.Fatal(err)
	}
	application := http.NewServeMux()
	application.HandleFunc("GET /private", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := jwtauth.FromContext(r.Context())
		if !ok || identity.UserID != userID {
			t.Fatal("protected handler did not receive verified identity")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	var ready atomic.Bool
	ready.Store(true)
	handler := newServiceHandler(&ready, newLogger(io.Discard, "test", slog.LevelInfo), cfg.JWTVerifier.Middleware(application))
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject: userID, IssuedAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, token string
		status      int
	}{
		{"/healthz", "", http.StatusOK},
		{"/readyz", "", http.StatusOK},
		{"/metrics", "", http.StatusOK},
		{"/private", "", http.StatusUnauthorized},
		{"/private", "invalid-token", http.StatusUnauthorized},
		{"/private", raw, http.StatusNoContent},
	} {
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		if tc.token != "" {
			r.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("X-Request-ID") == "" {
			t.Fatalf("%s: status=%d, want %d, headers=%v", tc.path, w.Code, tc.status, w.Header())
		}
	}
}
