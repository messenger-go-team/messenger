package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/messenger-go-team/messenger/services/auth/internal/postgres"
)

func TestAuthReadinessIntegration(t *testing.T) {
	db := emptyAuthTestDatabase(t)
	var ready atomic.Bool
	ready.Store(true)
	handler := newAuthHandler(&ready, newLogger(io.Discard, "auth", slog.LevelInfo), nil, postgres.New(db).CheckReady)
	assertStatus := func(t *testing.T, path string, want int) {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, w.Code, want, w.Body.String())
		}
	}
	assertStatus(t, "/readyz", http.StatusServiceUnavailable)
	assertStatus(t, "/healthz", http.StatusOK)
	applyAuthTestSchema(t, db)
	assertStatus(t, "/readyz", http.StatusOK)
	for _, table := range []string{"users", "refresh_tokens"} {
		t.Run("missing "+table, func(t *testing.T) {
			name := pq.QuoteIdentifier(table)
			if _, err := db.Exec(`ALTER TABLE auth.` + name + ` RENAME TO readiness_missing`); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := db.Exec(`ALTER TABLE auth.readiness_missing RENAME TO ` + name); err != nil {
					t.Error(err)
				}
			}()
			assertStatus(t, "/readyz", http.StatusServiceUnavailable)
			assertStatus(t, "/healthz", http.StatusOK)
		})
		assertStatus(t, "/readyz", http.StatusOK)
	}
	t.Run("service role permissions", func(t *testing.T) {
		var canCreateRole bool
		if err := db.QueryRow(`SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname=current_user`).Scan(&canCreateRole); err != nil {
			t.Fatal(err)
		}
		if !canCreateRole {
			t.Skip("CREATEROLE is needed only for permission regression checks")
		}
		// One connection keeps SET ROLE scoped to this isolated test pool.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		role := pq.QuoteIdentifier(fmt.Sprintf("messenger_auth_readiness_%d", time.Now().UnixNano()))
		if _, err := db.Exec(`CREATE ROLE ` + role + ` NOLOGIN`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for _, query := range []string{`RESET ROLE`, `DROP OWNED BY ` + role, `DROP ROLE ` + role} {
				if _, err := db.ExecContext(cleanup, query); err != nil {
					t.Error("clean up test role:", err)
				}
			}
		})
		if _, err := db.Exec(`GRANT ` + role + ` TO CURRENT_USER`); err != nil {
			t.Fatal(err)
		}
		asRole := func(want int) {
			t.Helper()
			if _, err := db.Exec(`SET ROLE ` + role); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := db.Exec(`RESET ROLE`); err != nil {
					t.Error(err)
				}
			}()
			assertStatus(t, "/readyz", want)
		}
		asRole(http.StatusServiceUnavailable)
		for _, step := range []struct {
			query string
			want  int
		}{
			{`GRANT USAGE ON SCHEMA auth TO ` + role, http.StatusServiceUnavailable},
			{`GRANT SELECT ON auth.users TO ` + role, http.StatusServiceUnavailable},
			{`GRANT SELECT ON auth.refresh_tokens TO ` + role, http.StatusServiceUnavailable},
			{`GRANT INSERT ON auth.users, auth.refresh_tokens TO ` + role, http.StatusServiceUnavailable},
			{`GRANT UPDATE ON auth.refresh_tokens TO ` + role, http.StatusOK},
			{`REVOKE SELECT ON auth.users FROM ` + role, http.StatusServiceUnavailable},
			{`GRANT SELECT ON auth.users TO ` + role, http.StatusOK},
		} {
			if _, err := db.Exec(step.query); err != nil {
				t.Fatal(err)
			}
			asRole(step.want)
		}
	})
}
