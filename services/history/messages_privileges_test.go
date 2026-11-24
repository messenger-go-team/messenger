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
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

func TestMessageReadinessPrivileges(t *testing.T) {
	db := historyDatabase(t)
	var allowed bool
	if err := db.QueryRow(`SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname=current_user`).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Skip("temporary role check needs CREATEROLE")
	}
	role := "history_role_" + strings.ReplaceAll(messageKey(t), "-", "")[:12]
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
	if _, err := db.Exec(`GRANT USAGE ON SCHEMA history TO ` + quoted + `; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA history TO ` + quoted + `; GRANT UPDATE(last_seq) ON history.chats TO ` + quoted); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgx.ParseConfig(os.Getenv("HISTORY_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("invalid test URL")
	}
	if err = db.QueryRow(`SELECT current_database()`).Scan(&cfg.Database); err != nil {
		t.Fatal(err)
	}
	cfg.User = role
	cfg.Password = password
	limited = stdlib.OpenDB(*cfg)
	limited.SetMaxOpenConns(4)
	repo := &postgres.Repository{DB: limited}
	service := messages.New(repo)
	chat := messageChat(t, db, 0, userA, userB)
	req := messages.Input{ChatID: chat, SenderID: userA, ClientID: messageKey(t), Body: "least privilege save"}
	if err := repo.Ready(t.Context()); err == nil {
		t.Fatal("readiness ignored membership row-lock privilege")
	}
	if _, err := service.Save(t.Context(), req); err == nil {
		t.Fatal("save unexpectedly worked without membership lock privilege")
	}
	assertMessageCounts(t, db, chat, 0, 0)
	// Row locks need UPDATE on at least one membership column; full UPDATE
	// on every table is not necessary for the service's SaveMessage query.
	if _, err := db.Exec(`GRANT UPDATE(role,last_read_seq,last_delivered_seq) ON history.chat_members TO ` + quoted); err != nil {
		t.Fatal(err)
	}
	if err := repo.Ready(t.Context()); err != nil {
		t.Fatal("column-level row-lock grant not recognized", err)
	}
	out, err := service.Save(t.Context(), req)
	if err != nil || out.Seq != 1 || out.Duplicate {
		t.Fatal(out, err)
	}
	for _, priv := range []string{"SELECT", "INSERT"} {
		if _, err := db.Exec(`REVOKE ` + priv + ` ON history.messages FROM ` + quoted); err != nil {
			t.Fatal(err)
		}
		if err := repo.Ready(t.Context()); err == nil {
			t.Fatal("readiness ignored message privilege", priv)
		}
		failed := req
		failed.ClientID = messageKey(t)
		if _, err := service.Save(t.Context(), failed); err == nil {
			t.Fatal("save accepted missing message privilege", priv)
		}
		assertMessageCounts(t, db, chat, 1, 1)
		if _, err := db.Exec(`GRANT ` + priv + ` ON history.messages TO ` + quoted); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.Ready(t.Context()); err != nil {
		t.Fatal("readiness did not recover", err)
	}
	// #31 requires UPDATE on both private cursor columns, not full table UPDATE.
	for _, column := range []string{"last_read_seq", "last_delivered_seq"} {
		if _, err := db.Exec(`REVOKE UPDATE(` + column + `) ON history.chat_members FROM ` + quoted); err != nil {
			t.Fatal(err)
		}
		if err := repo.Ready(t.Context()); err == nil {
			t.Fatal("readiness ignored read-cursor privilege", column)
		}
		if err := repo.MarkRead(t.Context(), chat, userA, 1); err == nil {
			t.Fatal("read worked without cursor privilege", column)
		}
		if read, delivered := cursorState(t, db, chat, userA); read != 0 || delivered != 0 {
			t.Fatal("failed read changed cursor")
		}
		if _, err := db.Exec(`GRANT UPDATE(` + column + `) ON history.chat_members TO ` + quoted); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkRead(t.Context(), chat, userA, 1); err != nil {
		t.Fatal("column-level grants must allow read", err)
	}
	if read, delivered := cursorState(t, db, chat, userA); read != 1 || delivered != 1 {
		t.Fatal(read, delivered)
	}

	if err := repo.ReceiptsReady(t.Context()); err == nil {
		t.Fatal("receipt readiness ignored missing v3")
	}
	applyHistoryMigration(t, db, "000003_public_receipts")
	if _, err := db.Exec(`GRANT UPDATE(public_last_read_seq,public_last_delivered_seq) ON history.chat_members TO ` + quoted); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"public_last_read_seq", "public_last_delivered_seq"} {
		if _, err := db.Exec(`REVOKE UPDATE(` + column + `) ON history.chat_members FROM ` + quoted); err != nil {
			t.Fatal(err)
		}
		if err := repo.ReceiptsReady(t.Context()); err == nil {
			t.Fatal("readiness ignored public cursor privilege", column)
		}
		if _, _, err := repo.AdvanceReceipt(t.Context(), chat, userA, 1, true); err == nil {
			t.Fatal("public read worked without cursor privilege", column)
		}
		if _, err := db.Exec(`GRANT UPDATE(` + column + `) ON history.chat_members TO ` + quoted); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.ReceiptsReady(t.Context()); err != nil {
		t.Fatal("readiness with public cursor grants", err)
	}
	cursors, advanced, err := repo.AdvanceReceipt(t.Context(), chat, userA, 1, true)
	if err != nil || cursors.Read != 1 || cursors.Delivered != 1 || !advanced {
		t.Fatal(cursors, advanced, err)
	}
}
