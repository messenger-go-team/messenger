package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
	"github.com/messenger-go-team/messenger/services/auth/internal/postgres"
)

func directoryTestJWT(t *testing.T, secret, id string, expires time.Time) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{Subject: id, IssuedAt: jwt.NewNumericDate(time.Now().Add(-time.Second)), ExpiresAt: jwt.NewNumericDate(expires)}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestDirectoryIntegration(t *testing.T) {
	db := authTestDatabase(t)
	repo := postgres.New(db)
	seed := func(name string) auth.User {
		t.Helper()
		user, err := repo.CreateUser(context.Background(), name, "fixture-password-hash-not-for-login")
		if err != nil {
			t.Fatal(err)
		}
		return user
	}
	alice, bob, zed := seed("Alice_1"), seed("bob_2"), seed("Zed_1")
	literal := seed("A_b")
	seed("Acb")
	for i := range 25 {
		seed(fmt.Sprintf("Limit%02d", i))
	}
	const secret = "directory-integration-shared-secret-32-bytes"
	verifier, err := jwtauth.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := auth.NewService(repo, secret)
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Bool
	ready.Store(true)
	handler := newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), sessions, repo.CheckReady, newDirectoryHandler(auth.NewDirectory(repo), verifier))
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 15 * time.Second
	aliceJWT := directoryTestJWT(t, secret, alice.ID, time.Now().Add(time.Minute))
	bobJWT := directoryTestJWT(t, secret, bob.ID, time.Now().Add(time.Minute))
	request := func(method, path, token, body string) (int, http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, response.Header, data
	}
	status := func(method, path, token, body string, want int) []byte {
		t.Helper()
		code, headers, data := request(method, path, token, body)
		if code != want {
			t.Fatalf("%s %s status=%d want=%d body=%s", method, path, code, want, data)
		}
		if headers.Get("Cache-Control") != "no-store" || headers.Get("X-Request-ID") == "" {
			t.Fatal("missing response headers")
		}
		if want == 204 && len(data) != 0 {
			t.Fatal("204 response must be empty")
		}
		if strings.Contains(string(data), "fixture-password-hash-not-for-login") || strings.Contains(string(data), "password_hash") {
			t.Fatal("private profile field leaked")
		}
		return data
	}
	summaries := func(data []byte, key string) []auth.UserSummary {
		t.Helper()
		var decoded map[string]json.RawMessage
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatal(err)
		}
		if len(decoded) != 1 || string(decoded[key]) == "null" {
			t.Fatal("response list must be an array", string(data))
		}
		var items []auth.UserSummary
		if err := json.Unmarshal(decoded[key], &items); err != nil {
			t.Fatal(err)
		}
		var fields []map[string]any
		_ = json.Unmarshal(decoded[key], &fields)
		for _, entry := range fields {
			if len(entry) != 2 {
				t.Fatal("unexpected summary fields")
			}
		}
		return items
	}
	t.Run("JWT required on every protected route", func(t *testing.T) {
		routes := []struct{ method, path string }{{"GET", "/me"}, {"GET", "/users/search?prefix=a"}, {"GET", "/contacts"}, {"PUT", "/contacts/" + bob.ID}, {"DELETE", "/contacts/" + bob.ID}}
		invalid := []string{"", "invalid", directoryTestJWT(t, "different-secret-at-least-32-bytes", alice.ID, time.Now().Add(time.Minute)), directoryTestJWT(t, secret, alice.ID, time.Now().Add(-time.Second))}
		for _, route := range routes {
			for _, token := range invalid {
				status(route.method, route.path, token, "", 401)
			}
		}
		req, _ := http.NewRequest("GET", server.URL+"/me?access_token="+url.QueryEscape(aliceJWT), nil)
		req.AddCookie(&http.Cookie{Name: "access_token", Value: aliceJWT})
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != 401 {
			t.Fatal("access credentials accepted outside Authorization")
		}
	})
	t.Run("public profile and public auth stay separate", func(t *testing.T) {
		data := status("GET", "/me", aliceJWT, "", 200)
		var user auth.User
		var fields map[string]any
		_ = json.Unmarshal(data, &user)
		_ = json.Unmarshal(data, &fields)
		if user.ID != alice.ID || user.Username != alice.Username || user.CreatedAt.IsZero() || len(fields) != 3 {
			t.Fatal("incorrect profile", string(data))
		}
		status("POST", "/auth/register", "", `{"username":"Public_1","password":"public-password"}`, 201)
	})
	t.Run("prefix search literal underscore and limit", func(t *testing.T) {
		got := summaries(status("GET", "/users/search?prefix=BOB", aliceJWT, "", 200), "users")
		if len(got) != 1 || got[0].ID != bob.ID || got[0].Username != bob.Username {
			t.Fatal("case-insensitive search failed")
		}
		got = summaries(status("GET", "/users/search?prefix=a_", aliceJWT, "", 200), "users")
		if len(got) != 1 || got[0].ID != literal.ID {
			t.Fatal("underscore treated as SQL wildcard")
		}
		got = summaries(status("GET", "/users/search?prefix=LIMIT", aliceJWT, "", 200), "users")
		if len(got) != 20 || got[0].Username != "Limit00" || got[19].Username != "Limit19" {
			t.Fatal("incorrect search limit/order")
		}
		got = summaries(status("GET", "/users/search?prefix=no_match", aliceJWT, "", 200), "users")
		if len(got) != 0 {
			t.Fatal("empty search must return []")
		}
		for _, query := range []string{"", "prefix=", "prefix=a&prefix=b", "prefix=" + strings.Repeat("a", 33), "prefix=" + url.QueryEscape("али"), "prefix=ali%25", "prefix=a-b", "prefix=%ZZ", "prefix=a;prefix=b"} {
			status("GET", "/users/search?"+query, aliceJWT, "", 422)
		}
	})
	t.Run("directed owned sorted contacts and idempotent writes", func(t *testing.T) {
		if got := summaries(status("GET", "/contacts", aliceJWT, "", 200), "contacts"); len(got) != 0 {
			t.Fatal("new list is not empty")
		}
		status("PUT", "/contacts/"+zed.ID, aliceJWT, "", 204)
		status("PUT", "/contacts/"+strings.ToUpper(bob.ID), aliceJWT, `{"user_id":"`+bob.ID+`"}`, 204)
		status("PUT", "/contacts/"+bob.ID, aliceJWT, "", 204)
		got := summaries(status("GET", "/contacts?user_id="+bob.ID, aliceJWT, "", 200), "contacts")
		if len(got) != 2 || got[0].Username != "bob_2" || got[1].Username != "Zed_1" {
			t.Fatal("wrong sorting/spelling/owner")
		}
		if got := summaries(status("GET", "/contacts", bobJWT, "", 200), "contacts"); len(got) != 0 {
			t.Fatal("reverse contact was created")
		}
		status("PUT", "/contacts/"+strings.ToUpper(alice.ID), aliceJWT, "", 422)
		status("DELETE", "/contacts/"+alice.ID, aliceJWT, "", 204)
		status("PUT", "/contacts/00000000-0000-0000-0000-000000000000", aliceJWT, "", 404)
		status("DELETE", "/contacts/00000000-0000-0000-0000-000000000000", aliceJWT, "", 204)
		for _, raw := range []string{"not-a-uuid", strings.ReplaceAll(bob.ID, "-", ""), bob.ID + "x"} {
			status("PUT", "/contacts/"+raw, aliceJWT, "", 422)
			status("DELETE", "/contacts/"+raw, aliceJWT, "", 422)
		}
		status("DELETE", "/contacts/"+bob.ID, bobJWT, "", 204)
		if got := summaries(status("GET", "/contacts", aliceJWT, "", 200), "contacts"); len(got) != 2 {
			t.Fatal("other owner removed contact")
		}
		status("DELETE", "/contacts/"+zed.ID, aliceJWT, "", 204)
		status("DELETE", "/contacts/"+zed.ID, aliceJWT, "", 204)
	})
	t.Run("concurrent puts create one directed row", func(t *testing.T) {
		start := make(chan struct{})
		results := make(chan int, 12)
		for range 12 {
			go func() {
				<-start
				req, _ := http.NewRequest("PUT", server.URL+"/contacts/"+zed.ID, nil)
				req.Header.Set("Authorization", "Bearer "+aliceJWT)
				response, err := client.Do(req)
				if err != nil {
					results <- 0
					return
				}
				_ = response.Body.Close()
				results <- response.StatusCode
			}()
		}
		close(start)
		for range 12 {
			if code := <-results; code != 204 {
				t.Fatalf("concurrent PUT status %d", code)
			}
		}
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM auth.contacts WHERE user_id=$1 AND contact_id=$2`, alice.ID, zed.ID).Scan(&count); err != nil || count != 1 {
			t.Fatal("duplicate contact rows", err)
		}
	})
	t.Run("delete contact preserves history and membership", func(t *testing.T) {
		migration, err := os.ReadFile("../history/migrations/000001_initial_schema.up.sql")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(migration)); err != nil {
			t.Fatal(err)
		}
		var chat string
		if err := db.QueryRow(`INSERT INTO history.chats(type,last_seq) VALUES('personal',1) RETURNING id`).Scan(&chat); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO history.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')`, chat, alice.ID, bob.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO history.messages(chat_id,seq,sender_id,client_msg_id,body) VALUES($1,1,$2,gen_random_uuid(),'keep history')`, chat, alice.ID); err != nil {
			t.Fatal(err)
		}
		status("DELETE", "/contacts/"+bob.ID, aliceJWT, "", 204)
		var members, messages, last, read int
		if err := db.QueryRow(`SELECT (SELECT count(*) FROM history.chat_members WHERE chat_id=$1),(SELECT count(*) FROM history.messages WHERE chat_id=$1),last_seq,(SELECT sum(last_read_seq) FROM history.chat_members WHERE chat_id=$1) FROM history.chats WHERE id=$1`, chat).Scan(&members, &messages, &last, &read); err != nil || members != 2 || messages != 1 || last != 1 || read != 0 {
			t.Fatal("contact delete changed History", err)
		}
	})
	t.Run("deleted identity cannot use the directory", func(t *testing.T) {
		deleted := seed("Deleted_1")
		token := directoryTestJWT(t, secret, deleted.ID, time.Now().Add(time.Minute))
		if _, err := db.Exec(`DELETE FROM auth.users WHERE id=$1`, deleted.ID); err != nil {
			t.Fatal(err)
		}
		status("GET", "/me", token, "", 401)
		status("GET", "/contacts", token, "", 401)
		status("GET", "/users/search?prefix=a", token, "", 401)
		status("PUT", "/contacts/"+bob.ID, token, "", 401)
		status("DELETE", "/contacts/"+bob.ID, token, "", 401)
	})
}
