package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

type lookupFunc func(context.Context, string) (auth.UserSummary, error)

func (f lookupFunc) Lookup(c context.Context, id string) (auth.UserSummary, error) { return f(c, id) }

func TestInternalAuthorizationSeparation(t *testing.T) {
	const secret = "internal-test-secret-32-bytes-minimum"
	const id = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
	var calls int
	service := lookupFunc(func(_ context.Context, got string) (auth.UserSummary, error) {
		calls++
		if got != id {
			t.Fatal("lookup ID changed")
		}
		return auth.UserSummary{ID: id, Username: "Alice_1"}, nil
	})
	var logs bytes.Buffer
	handler := newAuthHandler(&atomic.Bool{}, newLogger(&logs, "auth", slog.LevelInfo), nil, nil, newInternalHandler(service, secret))
	userJWT := directoryTestJWT(t, "user-jwt-signing-secret-at-least-32-bytes", id, time.Now().Add(time.Minute))
	for _, tc := range []struct {
		name          string
		headers       []string
		cookie, query string
	}{
		{name: "missing"}, {name: "wrong", headers: []string{"Bearer wrong-secret"}},
		{name: "user access JWT", headers: []string{"Bearer " + userJWT}},
		{name: "raw secret", headers: []string{secret}},
		{name: "duplicate", headers: []string{"Bearer " + secret, "Bearer " + secret}},
		{name: "trailing space", headers: []string{"Bearer " + secret + " "}},
		{name: "cookie", cookie: "internal_token=" + secret},
		{name: "query", query: "?internal_token=" + secret},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/internal/users/"+id+tc.query, nil)
			for _, header := range tc.headers {
				r.Header.Add("Authorization", header)
			}
			r.Header.Set("Cookie", tc.cookie)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 401 || calls != 0 || w.Header().Get("WWW-Authenticate") != "Bearer" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("internal authorization bypass", w.Code)
			}
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("secret leaked to response")
			}
		})
	}
	// Do not put credentials in URLs in successful/logged examples. The query
	// rejection above is safe because request logging omits the query string.
	r := httptest.NewRequest("GET", "/internal/users/"+id, nil)
	r.Header.Set("Authorization", "bearer "+secret)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var fields map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil || w.Code != 200 || len(fields) != 2 || fields["id"] != id || calls != 1 {
		t.Fatal("lookup response violates UserSummary", err)
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), userJWT) {
		t.Fatal("service credential logged")
	}
	for _, unconfigured := range []string{"", "short"} {
		h := newInternalHandler(service, unconfigured)
		r := httptest.NewRequest(http.MethodGet, "/internal/users/"+id, nil)
		r.Header.Set("Authorization", "Bearer "+unconfigured)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 || calls != 1 {
			t.Fatal("unconfigured internal authorization must fail closed")
		}
	}
}
