package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

type stubAuthentication struct {
	registerFunc func(context.Context, string, string) (auth.User, error)
	loginFunc    func(context.Context, string, string) (auth.Session, error)
	refreshFunc  func(context.Context, string) (auth.Session, error)
	logoutFunc   func(context.Context, string) error
}

func (s stubAuthentication) Register(c context.Context, u, p string) (auth.User, error) {
	return s.registerFunc(c, u, p)
}
func (s stubAuthentication) Login(c context.Context, u, p string) (auth.Session, error) {
	return s.loginFunc(c, u, p)
}
func (s stubAuthentication) Refresh(c context.Context, r string) (auth.Session, error) {
	return s.refreshFunc(c, r)
}
func (s stubAuthentication) Logout(c context.Context, r string) error { return s.logoutFunc(c, r) }

func TestAuthRejectsMalformedCredentials(t *testing.T) {
	// Nil stub methods panic if malformed inputs reach the service.
	handler := newAuthHandler(&atomic.Bool{}, newLogger(io.Discard, "test", slog.LevelInfo), stubAuthentication{}, nil)
	for name, body := range map[string]string{
		"empty": "", "array": "[]", "null": "null", "missing": `{"username":"alice"}`,
		"wrong case":        `{"Username":"alice","password":"password"}`,
		"extra":             `{"username":"alice","password":"password","extra":1}`,
		"duplicate":         `{"username":"alice","username":"bob","password":"password"}`,
		"escaped duplicate": `{"username":"alice","user\u006eame":"bob","password":"password"}`,
		"null field":        `{"username":null,"password":"password"}`,
		"number":            `{"username":"alice","password":12345678}`,
		"trailing":          `{"username":"alice","password":"password"} {}`,
		"broken":            `{"username":"alice","password":"password"`,
		"invalid UTF8":      "{\"username\":\"alice\",\"password\":\"password" + string([]byte{255}) + "\"}",
		"oversize":          `{"username":"alice","password":"` + strings.Repeat("a", maxCredentialsBody) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			for _, path := range []string{"/auth/register", "/auth/login"} {
				r := httptest.NewRequest("POST", path, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				if w.Code != 422 || !strings.Contains(w.Body.String(), `"validation_error"`) {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
			}
		})
	}
	r := httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"username":"alice","password":"password"}`))
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 422 {
		t.Fatal("non-JSON accepted")
	}
}

func TestAuthErrorAndCookieHandling(t *testing.T) {
	const marker = "private-secret-error-marker"
	var logs bytes.Buffer
	service := stubAuthentication{
		loginFunc:    func(context.Context, string, string) (auth.Session, error) { return auth.Session{}, errors.New(marker) },
		registerFunc: func(context.Context, string, string) (auth.User, error) { return auth.User{}, auth.ErrUsernameTaken },
		refreshFunc: func(context.Context, string) (auth.Session, error) {
			return auth.Session{}, auth.ErrInvalidRefreshToken
		},
		logoutFunc: func(context.Context, string) error { return auth.ErrInvalidRefreshToken },
	}
	handler := newAuthHandler(&atomic.Bool{}, newLogger(&logs, "auth", slog.LevelInfo), service, nil)
	for _, tc := range []struct {
		path, cookie string
		status       int
	}{
		{"/auth/register", "", 409}, {"/auth/login", "", 500},
		{"/auth/refresh", "", 401}, {"/auth/refresh", "refresh_token=one; refresh_token=two", 401},
		{"/auth/logout", "", 401}, {"/auth/logout", "refresh_token=invalid", 401},
	} {
		r := httptest.NewRequest("POST", tc.path, strings.NewReader(`{"username":"alice","password":"password"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", tc.cookie)
		r.Header.Set("X-Request-ID", "auth-error-test")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Request-ID") != "auth-error-test" {
			t.Fatalf("unexpected error response %d: %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), marker) || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("failed operation leaked secret or set cookie")
		}
	}
	if strings.Contains(logs.String(), marker) || strings.Contains(logs.String(), "password") {
		t.Fatal("credentials leaked to logs")
	}
}

func TestDatabaseReadiness(t *testing.T) {
	var ready atomic.Bool
	ready.Store(true)
	var down atomic.Bool
	ping := func(context.Context) error {
		if down.Load() {
			return errors.New("down")
		}
		return nil
	}
	handler := newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), nil, ping)
	for _, tc := range []struct {
		path   string
		down   bool
		status int
	}{{"/readyz", false, 200}, {"/readyz", true, 503}, {"/healthz", true, 200}, {"/metrics", true, 200}, {"/readyz", false, 200}} {
		down.Store(tc.down)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s status=%d", tc.path, w.Code)
		}
	}
	ready.Store(false)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != 503 {
		t.Fatal("stopped server ready")
	}
}
