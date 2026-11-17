package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

func TestLaterObjectDecoding(t *testing.T) {
	for _, tc := range []struct {
		body, media string
		valid       bool
	}{
		{`{"due_at":null}`, "application/json", true},
		{` {"due_at":"2024-02-29T00:00:00Z"} `, "application/json; charset=utf-8", true},
		{`{"due_at":null}`, "", false}, {`{"due_at":null}`, "text/plain", false},
		{`{}`, "application/json", false}, {`null`, "application/json", false},
		{`{"due_at":null,"due_at":null}`, "application/json", false},
		{`{"due_at":null,"user_id":"override"}`, "application/json", false},
		{`{"Due_at":null}`, "application/json", false},
		{`{"due_at":null} []`, "application/json", false},
		{`{"due_at":null}` + strings.Repeat(" ", 1<<20), "application/json", false},
		{"{\xff}", "application/json", false},
	} {
		r := httptest.NewRequest(http.MethodPatch, "/later/id", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.media)
		fields, err := readLaterFields(httptest.NewRecorder(), r, "due_at")
		if (err == nil) != tc.valid || (tc.valid && (len(fields) != 1 || fields["due_at"] == nil)) {
			t.Fatal(tc.media, fields, err)
		}
	}
}

func TestLaterEveryRouteUsesSharedJWTVerifier(t *testing.T) {
	verifier, err := jwtauth.New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	laterRoutes(mux, nil, verifier)
	expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{Subject: userB, IssuedAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)), ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Minute))}).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{Subject: userB, IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}).SignedString([]byte("wrong-signing-secret-at-least-32-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct{ method, path string }{{"GET", "/later"}, {"POST", "/later"}, {"PATCH", "/later/" + missing}, {"POST", "/later/" + missing + "/done"}} {
		for _, query := range []string{"", "?limit=1", "?due_at=%zz"} {
			for _, token := range []string{"", "invalid", expired, wrong} {
				r := httptest.NewRequest(route.method, route.path+query, strings.NewReader(`{}`))
				if token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, r)
				if w.Code != http.StatusUnauthorized {
					t.Fatal("invalid JWT reached the nil service", route, w.Code)
				}
			}
		}
	}
}

// A nil service proves that validation stops the request before any business or
// storage call, including requests with otherwise valid IDs and JSON bodies.
func TestLaterRejectsQueryBeforeService(t *testing.T) {
	verifier, err := jwtauth.New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	laterRoutes(mux, nil, verifier)
	token := historyJWT(t, userB)
	for _, route := range []struct{ method, path, body string }{
		{"GET", "/later", ""},
		{"POST", "/later", laterBody(missing, missing, "null")},
		{"PATCH", "/later/" + missing, `{"due_at":null}`},
		{"POST", "/later/" + missing + "/done", ""},
	} {
		for _, query := range []string{
			"limit=1", "limit=abc", "limit", "limit=", "limit=1&limit=2",
			"due_at=null", "due_at=%zz", "%zz=1", "%", "=ignored",
			"%6cimit=1", "limit=1;offset=2", "owner_id=" + userA,
		} {
			t.Run(route.method+route.path+"?"+query, func(t *testing.T) {
				r := httptest.NewRequest(route.method, route.path+"?"+query, strings.NewReader(route.body))
				r.Header.Set("Authorization", "Bearer "+token)
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				w.Header().Set("X-Request-ID", "later-query-test")
				mux.ServeHTTP(w, r)
				var out map[string]string
				if w.Code != http.StatusUnprocessableEntity || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out) != 3 || out["code"] != "validation_error" || out["message"] != "Некорректный запрос." || out["request_id"] != "later-query-test" {
					t.Fatal("query did not produce a safe validation error", w.Code, w.Body.String())
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("personal response can be cached", w.Header())
				}
			})
		}
	}
}
