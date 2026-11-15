package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
	"github.com/messenger-go-team/messenger/services/auth/internal/postgres"
)

func TestInternalLookupIntegration(t *testing.T) {
	db := authTestDatabase(t)
	repo := postgres.New(db)
	user, err := repo.CreateUser(context.Background(), "Internal_1", "private-password-hash-marker")
	if err != nil {
		t.Fatal(err)
	}
	const jwtSecret = "internal-integration-jwt-key-32-bytes"
	const internalSecret = "internal-integration-service-key-32-bytes"
	verifier, _ := jwtauth.New(jwtSecret)
	directory := auth.NewDirectory(repo)
	routes := http.NewServeMux()
	routes.Handle("/internal/", newInternalHandler(directory, internalSecret))
	routes.Handle("/", newDirectoryHandler(directory, verifier))
	var ready atomic.Bool
	ready.Store(true)
	server := httptest.NewTLSServer(newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), nil, repo.CheckReady, routes))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 5 * time.Second
	userJWT := directoryTestJWT(t, jwtSecret, user.ID, time.Now().Add(time.Minute))
	for _, tc := range []struct {
		path, credential string
		status           int
		summary          bool
	}{
		{"/internal/users/" + user.ID, "", 401, false},
		{"/internal/users/" + user.ID, userJWT, 401, false},
		{"/internal/users/" + strings.ToUpper(user.ID), internalSecret, 200, true},
		{"/internal/users/00000000-0000-0000-0000-000000000000", internalSecret, 404, false},
		{"/internal/users/not-a-uuid", internalSecret, 404, false},
		{"/me", internalSecret, 401, false},
		{"/me", userJWT, 200, false},
	} {
		req, _ := http.NewRequest("GET", server.URL+tc.path, nil)
		if tc.credential != "" {
			req.Header.Set("Authorization", "Bearer "+tc.credential)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != tc.status {
			t.Fatalf("%s status=%d body=%s", tc.path, response.StatusCode, body)
		}
		if strings.Contains(string(body), "password_hash") || strings.Contains(string(body), "private-password-hash-marker") || strings.Contains(string(body), internalSecret) {
			t.Fatal("internal response leaked private data")
		}
		if tc.summary {
			var fields map[string]any
			if err := json.Unmarshal(body, &fields); err != nil || len(fields) != 2 || fields["id"] != user.ID || fields["username"] != user.Username {
				t.Fatal("unexpected lookup fields", err)
			}
		}
	}
}
