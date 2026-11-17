package main

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/lib/pq"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

func TestLaterLeastPrivileges(t *testing.T) {
	db := laterDatabase(t)
	var allowed bool
	if err := db.QueryRow(`SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname=current_user`).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Skip("temporary login role requires CREATEROLE")
	}
	role := "later_role_" + strings.ReplaceAll(messageKey(t), "-", "")[:12]
	password := messageKey(t)
	quoted := pq.QuoteIdentifier(role)
	if _, err := db.Exec(`CREATE ROLE ` + quoted + ` LOGIN PASSWORD ` + pq.QuoteLiteral(password)); err != nil {
		t.Fatal(err)
	}
	var limited *sql.DB
	t.Cleanup(func() {
		if limited != nil {
			_ = limited.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := db.ExecContext(ctx, `DROP OWNED BY `+quoted); err != nil {
			t.Error(err)
		}
		if _, err := db.ExecContext(ctx, `DROP ROLE `+quoted); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.Exec(`GRANT USAGE ON SCHEMA history TO ` + quoted + `; GRANT SELECT ON ALL TABLES IN SCHEMA history TO ` + quoted + `;
 GRANT INSERT ON history.later_entries TO ` + quoted + `; GRANT UPDATE(due_at,state,updated_at) ON history.later_entries TO ` + quoted + `;
 GRANT UPDATE(last_seq) ON history.chats TO ` + quoted + `; GRANT UPDATE(role) ON history.chat_members TO ` + quoted); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgx.ParseConfig(os.Getenv("HISTORY_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("invalid test URL")
	}
	if err = db.QueryRow(`SELECT current_database()`).Scan(&cfg.Database); err != nil {
		t.Fatal(err)
	}
	cfg.User, cfg.Password = role, password
	limited = stdlib.OpenDB(*cfg)
	repo := &postgres.LaterRepository{DB: limited}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	if err = repo.Ready(t.Context()); err == nil {
		t.Fatal("readiness missed message row-lock privilege")
	}
	if e, _, err := repo.Save(t.Context(), input); err == nil || e.ID != "" {
		t.Fatal("save bypassed source lock privilege", e, err)
	}
	if _, err = db.Exec(`GRANT UPDATE(id) ON history.messages TO ` + quoted); err != nil {
		t.Fatal(err)
	}
	if err = repo.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	entry, created, err := repo.Save(t.Context(), input)
	if err != nil || !created {
		t.Fatal(entry, created, err)
	}
	for _, column := range []string{"due_at", "state", "updated_at"} {
		if _, err = db.Exec(`REVOKE UPDATE(` + column + `) ON history.later_entries FROM ` + quoted); err != nil {
			t.Fatal(err)
		}
		if err = repo.Ready(t.Context()); err == nil {
			t.Fatal("readiness missed entry grant", column)
		}
		if column == "state" {
			err = repo.Complete(t.Context(), userB, entry.ID)
		} else {
			_, _, err = repo.Save(t.Context(), input)
		}
		if err == nil {
			t.Fatal("operation ignored missing grant", column)
		}
		if active, done := laterCount(t, db, userB, message); active != 1 || done != 0 {
			t.Fatal("failed operation changed entry")
		}
		if _, err = db.Exec(`GRANT UPDATE(` + column + `) ON history.later_entries TO ` + quoted); err != nil {
			t.Fatal(err)
		}
	}
	if err = repo.Ready(t.Context()); err != nil {
		t.Fatal("readiness did not recover", err)
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); err != nil {
		t.Fatal(err)
	}
}
