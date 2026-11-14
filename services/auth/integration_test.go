package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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

	"github.com/lib/pq"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
	"github.com/messenger-go-team/messenger/services/auth/internal/postgres"
)

// Only a newly created database is modified. The URL names an admin database;
// its application tables are never touched. The test role needs CREATEDB.
func authTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db := emptyAuthTestDatabase(t)
	applyAuthTestSchema(t, db)
	return db
}

func emptyAuthTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("AUTH_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set AUTH_TEST_DATABASE_URL to run Auth PostgreSQL integration tests")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.User == nil {
		t.Fatal("AUTH_TEST_DATABASE_URL must be a PostgreSQL URL with host and user")
	}
	admin, err := sql.Open("postgres", u.String())
	if err != nil {
		t.Fatal("open test admin connection failed")
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	name := fmt.Sprintf("messenger_auth_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+pq.QuoteIdentifier(name)); err != nil {
		t.Fatal("create isolated Auth test database:", err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanup, "DROP DATABASE "+pq.QuoteIdentifier(name)+" WITH (FORCE)"); err != nil {
			t.Error("drop isolated Auth database:", err)
		}
	})
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal("open isolated Auth database failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func applyAuthTestSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	migration, err := os.ReadFile("migrations/000001_initial_schema.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatal("apply Auth schema:", err)
	}
}

func TestAuthIntegration(t *testing.T) {
	db := authTestDatabase(t)
	repo := postgres.New(db)
	const secret = "auth-integration-secret-at-least-32-bytes"
	service, err := auth.NewService(repo, secret)
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Bool
	ready.Store(true)
	server := httptest.NewTLSServer(newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), service, repo.CheckReady))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 15 * time.Second
	request := func(path, body string, cookie *http.Cookie) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			req.AddCookie(cookie)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response, data
	}
	checkStatus := func(response *http.Response, data []byte, want int) {
		t.Helper()
		if response.StatusCode != want {
			t.Fatalf("status=%d want=%d body=%s", response.StatusCode, want, data)
		}
		if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Request-ID") == "" {
			t.Fatal("missing security/correlation headers")
		}
	}
	cookieOf := func(response *http.Response) *http.Cookie {
		t.Helper()
		cookies := response.Cookies()
		if len(cookies) != 1 {
			t.Fatal("expected one refresh cookie")
		}
		c := cookies[0]
		if c.Name != "refresh_token" || c.Path != "/auth" || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Domain != "" {
			t.Fatal("unsafe refresh cookie")
		}
		return c
	}
	const credentials = `{"username":"Alice_1","password":"😀длинный пароль со значимыми пробелами и более чем 72 байтами 😀 "}`
	response, data := request("/auth/register", credentials, nil)
	checkStatus(response, data, 201)
	var user auth.User
	if err := json.Unmarshal(data, &user); err != nil {
		t.Fatal(err)
	}
	var public map[string]any
	_ = json.Unmarshal(data, &public)
	if user.ID == "" || user.Username != "Alice_1" || user.CreatedAt.IsZero() || len(public) != 3 || response.Header.Get("Set-Cookie") != "" {
		t.Fatal("registration response violates contract")
	}
	var hash string
	if err := db.QueryRow(`SELECT password_hash FROM auth.users WHERE id=$1`, user.ID).Scan(&hash); err != nil || !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatal("password not hashed", err)
	}
	response, data = request("/auth/register", strings.Replace(credentials, "Alice_1", "ALICE_1", 1), nil)
	checkStatus(response, data, 409)
	for _, body := range []string{`{"username":"alice_1","password":"incorrect-password"}`, `{"username":"unknown","password":"incorrect-password"}`} {
		response, data = request("/auth/login", body, nil)
		checkStatus(response, data, 401)
	}
	response, data = request("/auth/login", strings.Replace(credentials, "Alice_1", "aLiCe_1", 1), nil)
	checkStatus(response, data, 200)
	first := cookieOf(response)
	if first.MaxAge != 2592000 || time.Until(first.Expires) < 29*24*time.Hour {
		t.Fatal("invalid refresh lifetime")
	}
	var access auth.AccessToken
	if err := json.Unmarshal(data, &access); err != nil {
		t.Fatal(err)
	}
	verifier, _ := jwtauth.New(secret)
	identity, err := verifier.Verify(access.AccessToken)
	if err != nil || identity.UserID != user.ID || access.ExpiresIn != 900 || access.TokenType != "Bearer" {
		t.Fatal("incompatible access JWT", err)
	}
	var accessFields map[string]any
	_ = json.Unmarshal(data, &accessFields)
	if len(accessFields) != 3 || strings.Contains(string(data), first.Value) {
		t.Fatal("refresh exposed in JSON")
	}
	digest, _ := auth.HashRefresh(first.Value)
	var stored string
	if err := db.QueryRow(`SELECT token_hash FROM auth.refresh_tokens WHERE user_id=$1`, user.ID).Scan(&stored); err != nil || stored != digest || stored == first.Value {
		t.Fatal("raw refresh stored", err)
	}
	response, data = request("/auth/refresh", "", first)
	checkStatus(response, data, 200)
	second := cookieOf(response)
	if second.Value == first.Value {
		t.Fatal("refresh not rotated")
	}
	response, data = request("/auth/refresh", "", first)
	checkStatus(response, data, 401)
	response, data = request("/auth/logout", "", first)
	checkStatus(response, data, 401)
	response, data = request("/auth/login", credentials, nil)
	checkStatus(response, data, 200)
	otherSession := cookieOf(response)
	response, data = request("/auth/logout", "", second)
	checkStatus(response, data, 204)
	cleared := cookieOf(response)
	if cleared.MaxAge != -1 || cleared.Value != "" || len(data) != 0 {
		t.Fatal("logout did not clear cookie with empty 204")
	}
	response, data = request("/auth/refresh", "", second)
	checkStatus(response, data, 401)
	response, data = request("/auth/refresh", "", otherSession)
	checkStatus(response, data, 200)
	live := cookieOf(response)

	t.Run("Unicode passwords retain their identity", func(t *testing.T) {
		for _, tc := range []struct{ username, encoded, password string }{
			{"UnicodeEmoji", `abcdefg\ud83d\ude00`, "abcdefg😀"},
			{"UnicodeReplacement", `abcdefg\ufffd`, "abcdefg�"},
			{"UnicodeBackslash", `abcdefg\\ud800`, `abcdefg\ud800`},
		} {
			body := `{"username":"` + tc.username + `","password":"` + tc.encoded + `"}`
			response, data := request("/auth/register", body, nil)
			checkStatus(response, data, http.StatusCreated)
			literal, err := json.Marshal(map[string]string{"username": tc.username, "password": tc.password})
			if err != nil {
				t.Fatal(err)
			}
			response, data = request("/auth/login", string(literal), nil)
			checkStatus(response, data, http.StatusOK)
			for _, invalid := range []string{`abcdefg\ud800`, `abcdefg\udc00`} {
				body := `{"username":"` + tc.username + `","password":"` + invalid + `"}`
				response, data = request("/auth/login", body, nil)
				checkStatus(response, data, http.StatusUnprocessableEntity)
			}
		}
		response, data := request("/auth/register", `{"username":"InvalidSurrogate","password":"abcdefg\ud800"}`, nil)
		checkStatus(response, data, http.StatusUnprocessableEntity)
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM auth.users WHERE username_normalized='invalidsurrogate'`).Scan(&count); err != nil || count != 0 {
			t.Fatal("unpaired surrogate created an account", err)
		}
	})
	t.Run("expired refresh", func(t *testing.T) {
		hash, _ := auth.HashRefresh(live.Value)
		if _, err := db.Exec(`UPDATE auth.refresh_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, hash); err != nil {
			t.Fatal(err)
		}
		response, data := request("/auth/refresh", "", live)
		checkStatus(response, data, 401)
		response, data = request("/auth/logout", "", live)
		checkStatus(response, data, 401)
	})
	t.Run("concurrent registrations", func(t *testing.T) {
		start := make(chan struct{})
		results := make(chan int, 2)
		for _, username := range []string{"Race_1", "rACE_1"} {
			go func() {
				<-start
				req, _ := http.NewRequest("POST", server.URL+"/auth/register", strings.NewReader(`{"username":"`+username+`","password":"password"}`))
				req.Header.Set("Content-Type", "application/json")
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
		a, b := <-results, <-results
		if (a != 201 || b != 409) && (a != 409 || b != 201) {
			t.Fatalf("registration race: %d %d", a, b)
		}
	})
	t.Run("concurrent refresh HTTP", func(t *testing.T) {
		response, data := request("/auth/login", credentials, nil)
		checkStatus(response, data, 200)
		cookie := cookieOf(response)
		start := make(chan struct{})
		results := make(chan int, 2)
		for range 2 {
			go func() {
				<-start
				req, _ := http.NewRequest("POST", server.URL+"/auth/refresh", nil)
				req.AddCookie(cookie)
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
		a, b := <-results, <-results
		if (a != 200 || b != 401) && (a != 401 || b != 200) {
			t.Fatalf("refresh race: %d %d", a, b)
		}
	})

	ctx := context.Background()
	newToken := func() string {
		t.Helper()
		_, hash, err := auth.GenerateRefresh()
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.CreateRefresh(ctx, user.ID, hash, auth.RefreshLifetime); err != nil {
			t.Fatal(err)
		}
		return hash
	}
	t.Run("rotation rollback keeps old token", func(t *testing.T) {
		old, existing := newToken(), newToken()
		if _, err := repo.RotateRefresh(ctx, old, existing, auth.RefreshLifetime); err == nil {
			t.Fatal("successor uniqueness violation should fail")
		}
		_, next, _ := auth.GenerateRefresh()
		if _, err := repo.RotateRefresh(ctx, old, next, auth.RefreshLifetime); err != nil {
			t.Fatal("old token was not restored by rollback", err)
		}
	})
	t.Run("refresh and logout serialize", func(t *testing.T) {
		for range 10 {
			old := newToken()
			_, next, _ := auth.GenerateRefresh()
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() { <-start; _, err := repo.RotateRefresh(ctx, old, next, auth.RefreshLifetime); results <- err }()
			go func() { <-start; results <- repo.RevokeRefresh(ctx, old) }()
			close(start)
			a, b := <-results, <-results
			if (a != nil || !errors.Is(b, auth.ErrInvalidRefreshToken)) && (b != nil || !errors.Is(a, auth.ErrInvalidRefreshToken)) {
				t.Fatalf("rotation/logout race: %v %v", a, b)
			}
		}
	})
	t.Run("cancelled lock wait preserves refresh", func(t *testing.T) {
		old := newToken()
		blocker, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = blocker.Rollback() }()
		if _, err := blocker.Exec(`SELECT id FROM auth.refresh_tokens WHERE token_hash=$1 FOR UPDATE`, old); err != nil {
			t.Fatal(err)
		}
		cancelled, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		_, next, _ := auth.GenerateRefresh()
		result := make(chan error, 1)
		go func() { _, err := repo.RotateRefresh(cancelled, old, next, auth.RefreshLifetime); result <- err }()
		select {
		case err := <-result:
			if err == nil || cancelled.Err() == nil {
				t.Fatal("blocked rotation ignored context")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("cancelled rotation did not finish")
		}
		if err := blocker.Rollback(); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RotateRefresh(ctx, old, next, auth.RefreshLifetime); err != nil {
			t.Fatal("cancelled rotation consumed old token", err)
		}
	})
	t.Run("expiry after waiting for row lock", func(t *testing.T) {
		for _, operation := range []string{"refresh", "logout"} {
			old := newToken()
			blocker, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := blocker.Exec(`SELECT id FROM auth.refresh_tokens WHERE token_hash=$1 FOR UPDATE`, old); err != nil {
				_ = blocker.Rollback()
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if operation == "logout" {
					result <- repo.RevokeRefresh(ctx, old)
					return
				}
				_, next, _ := auth.GenerateRefresh()
				_, err := repo.RotateRefresh(ctx, old, next, auth.RefreshLifetime)
				result <- err
			}()
			// Observe the actual lock wait instead of guessing with sleep.
			deadline := time.Now().Add(5 * time.Second)
			for {
				var waiting bool
				err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')`).Scan(&waiting)
				if err != nil {
					_ = blocker.Rollback()
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					_ = blocker.Rollback()
					t.Fatal("operation did not wait for lock")
				}
				time.Sleep(5 * time.Millisecond)
			}
			if _, err := blocker.Exec(`UPDATE auth.refresh_tokens SET expires_at=clock_timestamp() WHERE token_hash=$1`, old); err != nil {
				_ = blocker.Rollback()
				t.Fatal(err)
			}
			if err := blocker.Commit(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if !errors.Is(err, auth.ErrInvalidRefreshToken) {
					t.Fatal("expired token accepted after lock wait", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("blocked operation did not finish")
			}
		}
	})
}
