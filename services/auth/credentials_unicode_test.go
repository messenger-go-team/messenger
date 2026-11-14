package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAuthRejectsUnpairedSurrogates(t *testing.T) {
	handler := newAuthHandler(&atomic.Bool{}, newLogger(io.Discard, "test", slog.LevelInfo), stubAuthentication{}, nil)
	for name, password := range map[string]string{
		"high":                                  `abcdefg\ud800`,
		"low":                                   `abcdefg\udc00`,
		"high at end of range":                  `abcdefg\uDBFF`,
		"low at end of range":                   `abcdefg\uDFFF`,
		"high then ordinary escape":             `abcdefg\ud800\u0041`,
		"high then high":                        `abcdefg\ud800\ud801`,
		"reversed pair":                         `abcdefg\udc00\ud800`,
		"high separated from low":               `abcdefg\ud800x\udc00`,
		"pair then unmatched high":              `abcdefg\ud83d\ude00\ud800`,
		"escaped backslash then unmatched high": `abcdefg\\\ud800`,
	} {
		t.Run(name, func(t *testing.T) {
			for _, path := range []string{"/auth/register", "/auth/login"} {
				r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"username":"alice","password":"`+password+`"}`))
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), `"validation_error"`) {
					t.Fatalf("%s status=%d want=422 body=%s", path, w.Code, w.Body.String())
				}
				if w.Header().Get("Set-Cookie") != "" {
					t.Fatal("invalid credentials set a session cookie")
				}
			}
		})
	}
}

func TestReadCredentialsPreservesValidUnicode(t *testing.T) {
	for _, tc := range []struct{ name, encoded, want string }{
		{"surrogate pair", `abcdefg\ud83d\ude00`, "abcdefg😀"},
		{"uppercase escapes", `abcdefg\uD83D\uDE00`, "abcdefg😀"},
		{"first surrogate pair", `abcdefg\ud800\udc00`, "abcdefg\U00010000"},
		{"last surrogate pair", `abcdefg\udbff\udfff`, "abcdefg\U0010ffff"},
		{"escaped replacement", `abcdefg\ufffd`, "abcdefg�"},
		{"literal replacement", "abcdefg�", "abcdefg�"},
		{"literal emoji", "abcdefg😀", "abcdefg😀"},
		{"literal escape text", `abcdefg\\ud800`, `abcdefg\ud800`},
		{"escaped quote before pair", `abcdefg\"\ud83d\ude00`, "abcdefg\"😀"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/auth/register", strings.NewReader(`{"username":"alice","password":"`+tc.encoded+`"}`))
			r.Header.Set("Content-Type", "application/json")
			username, password, err := readCredentials(r)
			if err != nil || username != "alice" || password != tc.want {
				t.Fatalf("valid credentials changed: username=%q password=%q err=%v", username, password, err)
			}
		})
	}
}
