package jwtauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestMiddleware(t *testing.T) {
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	claims := validTestClaims()
	claims["sub"] = strings.ToUpper(testUserID)
	raw := signTestToken(t, jwt.SigningMethodHS256, claims, []byte(testSecret))
	for _, header := range []string{"Bearer " + raw, "bEaReR " + raw, "Bearer   " + raw} {
		called := false
		handler := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			identity, ok := FromContext(r.Context())
			if !ok || identity.UserID != testUserID || identity.ExpiresAt.Unix() != claims["exp"] {
				t.Fatalf("unexpected request identity: %+v, %t", identity, ok)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
		r := httptest.NewRequest(http.MethodGet, "/private", nil)
		r.Header.Set("Authorization", header)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !called || w.Code != http.StatusNoContent {
			t.Fatal("valid bearer must reach protected handler")
		}
		if _, ok := FromContext(r.Context()); ok {
			t.Fatal("middleware must not mutate the caller's request context")
		}
	}
	if _, ok := FromContext(context.Background()); ok {
		t.Fatal("empty context must not authenticate")
	}
}

func TestMiddlewareRejectsAmbiguousOrMissingCredentials(t *testing.T) {
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	raw := signTestToken(t, jwt.SigningMethodHS256, validTestClaims(), []byte(testSecret))
	for name, headers := range map[string][]string{
		"missing": nil, "empty": {""}, "basic": {"Basic " + raw},
		"no token": {"Bearer "}, "tab separator": {"Bearer\t" + raw},
		"duplicate": {"Bearer " + raw, "Bearer " + raw},
		"combined":  {"Bearer " + raw + ", Bearer " + raw},
		"trailing":  {"Bearer " + raw + " other"},
		"malformed": {"Bearer broken.jwt.token"},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/private?access_token="+raw, nil)
			r.AddCookie(&http.Cookie{Name: "access_token", Value: raw})
			for _, header := range headers {
				r.Header.Add("Authorization", header)
			}
			w := httptest.NewRecorder()
			v.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("invalid credentials must not reach handler")
			})).ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") != "Bearer" ||
				w.Header().Get("Cache-Control") != "no-store" ||
				w.Header().Get("Content-Type") != "application/json" ||
				!strings.Contains(w.Body.String(), `"code":"unauthorized"`) || strings.Contains(w.Body.String(), raw) {
				t.Fatalf("unexpected unauthorized response: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
