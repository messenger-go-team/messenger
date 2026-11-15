package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

func laterDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db := historyDatabase(t)
	migration, err := os.ReadFile("migrations/000002_later_entries.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), string(migration)); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(16)
	return db
}
func laterMessage(t *testing.T, db *sql.DB) (string, string) {
	t.Helper()
	chat := messageChat(t, db, 0, userA, userB)
	saved, err := messages.New(&postgres.Repository{DB: db}).Save(t.Context(), messages.Input{ChatID: chat, SenderID: userA, ClientID: messageKey(t), Body: "original private source"})
	if err != nil {
		t.Fatal(err)
	}
	return chat, saved.ID
}
func laterCount(t *testing.T, db *sql.DB, user, message string) (int, int) {
	t.Helper()
	var active, done int
	if err := db.QueryRowContext(t.Context(), `SELECT count(*) FILTER(WHERE state='active'),count(*) FILTER(WHERE state='done') FROM history.later_entries WHERE user_id=$1 AND message_id=$2`, user, message).Scan(&active, &done); err != nil {
		t.Fatal(err)
	}
	return active, done
}
func TestLaterPersistence(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	first, created, err := repo.Save(t.Context(), input)
	if err != nil || !created || first.DueAt != nil || first.State != "active" || first.UserID != userB || first.MessageID != message || first.ID == "" || first.CreatedAt.IsZero() || first.CreatedAt != first.UpdatedAt {
		t.Fatal(first, created, err)
	}
	// Past dates and microseconds are valid; presets and calendar-string parsing are #87/#90.
	due := time.Date(2024, 2, 29, 19, 0, 0, 123456000, time.FixedZone("device", 3*3600))
	input.DueAt = &due
	repeated, created, err := repo.Save(t.Context(), input)
	if err != nil || created || repeated.ID != first.ID || repeated.CreatedAt != first.CreatedAt || repeated.DueAt == nil || !repeated.DueAt.Equal(due) || repeated.DueAt.Location() != time.UTC || repeated.UpdatedAt.Before(first.UpdatedAt) {
		t.Fatal(repeated, created, err)
	}
	input.DueAt = nil
	unscheduled, created, err := repo.Save(t.Context(), input)
	if err != nil || created || unscheduled.ID != first.ID || unscheduled.DueAt != nil {
		t.Fatal(unscheduled, created, err)
	}
	own, created, err := repo.Save(t.Context(), later.SaveInput{UserID: userA, ChatID: chat, MessageID: message})
	if err != nil || !created || own.ID == first.ID {
		t.Fatal("owners shared an entry", own, err)
	}
	if err = repo.Complete(t.Context(), userB, first.ID); err != nil {
		t.Fatal(err)
	}
	if err = repo.Complete(t.Context(), userB, first.ID); err != nil {
		t.Fatal("done retry", err)
	}
	next, created, err := repo.Save(t.Context(), input)
	if err != nil || !created || next.ID == first.ID {
		t.Fatal("save after done must create another ID", next, created, err)
	}
	if err = repo.Complete(t.Context(), userB, first.ID); err != nil {
		t.Fatal(err)
	}
	if active, done := laterCount(t, db, userB, message); active != 1 || done != 1 {
		t.Fatal("old done affected new active", active, done)
	}
	if active, done := laterCount(t, db, userA, message); active != 1 || done != 0 {
		t.Fatal("peer entry changed", active, done)
	}
	assertMessageCounts(t, db, chat, 1, 1)
	var read, delivered int64
	if err = db.QueryRow(`SELECT last_read_seq,last_delivered_seq FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB).Scan(&read, &delivered); err != nil || read != 0 || delivered != 0 {
		t.Fatal("Later changed read/delivery cursors", read, delivered, err)
	}
}
func TestLaterConcurrentUpsert(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	type result struct {
		entry   later.Entry
		created bool
		err     error
	}
	run := func(n int) {
		t.Helper()
		results := make(chan result, n)
		start := make(chan struct{})
		for i := range n {
			go func() {
				input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
				if i%2 == 0 {
					due := time.Date(2026, 11, 16, 19, i%60, 0, 123456000, time.UTC)
					input.DueAt = &due
				}
				<-start
				e, c, err := repo.Save(t.Context(), input)
				results <- result{e, c, err}
			}()
		}
		close(start)
		id := ""
		created := 0
		var original time.Time
		for range n {
			r := <-results
			if r.err != nil {
				t.Fatal(r.err)
			}
			if r.created {
				created++
			}
			if id == "" {
				id = r.entry.ID
				original = r.entry.CreatedAt
			}
			if r.entry.ID != id || r.entry.CreatedAt != original {
				t.Fatal("unstable entry identity", r)
			}
		}
		if created != 1 {
			t.Fatal("created count", created)
		}
		if active, _ := laterCount(t, db, userB, message); active != 1 {
			t.Fatal("duplicate active entries", active)
		}
		if err := repo.Complete(t.Context(), userB, id); err != nil {
			t.Fatal(err)
		}
	}
	run(64)
	run(32)
	if active, done := laterCount(t, db, userB, message); active != 0 || done != 2 {
		t.Fatal(active, done)
	}
}
func TestLaterAuthorizationAndSourceLifecycle(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	in := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	entry, _, err := repo.Save(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []later.SaveInput{{UserID: userC, ChatID: chat, MessageID: message}, {UserID: userB, ChatID: missing, MessageID: message}, {UserID: userB, ChatID: chat, MessageID: missing}} {
		out, created, err := repo.Save(t.Context(), input)
		if !errors.Is(err, later.ErrNotFound) || out.ID != "" || created {
			t.Fatal("absence leaked entry", out, err)
		}
	}
	otherChat, _ := laterMessage(t, db)
	if out, _, err := repo.Save(t.Context(), later.SaveInput{UserID: userB, ChatID: otherChat, MessageID: message}); !errors.Is(err, later.ErrNotFound) || out.ID != "" {
		t.Fatal("chat/message mismatch", out, err)
	}
	for _, target := range []struct{ user, id string }{{userA, entry.ID}, {userB, missing}} {
		if err := repo.Complete(t.Context(), target.user, target.id); !errors.Is(err, later.ErrNotFound) {
			t.Fatal("foreign/missing completion", err)
		}
	}
	if _, err = db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	// No FK to the owner's membership: losing access must not destroy the entry.
	if active, _ := laterCount(t, db, userB, message); active != 1 {
		t.Fatal("revocation deleted saved entry")
	}
	if out, _, err := repo.Save(t.Context(), in); !errors.Is(err, later.ErrNotFound) || out.ID != "" {
		t.Fatal("revoked save", out, err)
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); !errors.Is(err, later.ErrNotFound) {
		t.Fatal("revoked completion", err)
	}
	if _, err = db.Exec(`INSERT INTO history.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')`, chat, userB); err != nil {
		t.Fatal(err)
	}
	restored, created, err := repo.Save(t.Context(), in)
	if err != nil || created || restored.ID != entry.ID || restored.CreatedAt != entry.CreatedAt {
		t.Fatal("restored access lost saved entry", restored, created, err)
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); !errors.Is(err, later.ErrNotFound) {
		t.Fatal("done retry bypassed current access", err)
	}
	if _, err = db.Exec(`DELETE FROM history.messages WHERE id=$1`, message); err != nil {
		t.Fatal(err)
	}
	if active, done := laterCount(t, db, userB, message); active != 0 || done != 0 {
		t.Fatal("message deletion left orphan entries")
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); !errors.Is(err, later.ErrNotFound) {
		t.Fatal(err)
	}
}
func TestLaterCommitRollback(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	in := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	if _, err := db.Exec(`CREATE FUNCTION history.fail_later_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-later-commit-detail'; END $$; CREATE CONSTRAINT TRIGGER fail_later_commit AFTER INSERT OR UPDATE ON history.later_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history.fail_later_commit()`); err != nil {
		t.Fatal(err)
	}
	out, created, err := repo.Save(t.Context(), in)
	if err == nil || out.ID != "" || created {
		t.Fatal("uncommitted entry returned", out, err)
	}
	if active, done := laterCount(t, db, userB, message); active != 0 || done != 0 {
		t.Fatal("insert commit failure persisted", active, done)
	}
	if _, err = db.Exec(`DROP TRIGGER fail_later_commit ON history.later_entries`); err != nil {
		t.Fatal(err)
	}
	initial, _, err := repo.Save(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE CONSTRAINT TRIGGER fail_later_commit AFTER INSERT OR UPDATE ON history.later_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history.fail_later_commit()`); err != nil {
		t.Fatal(err)
	}
	due := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	in.DueAt = &due
	if out, created, err = repo.Save(t.Context(), in); err == nil || out.ID != "" || created {
		t.Fatal("failed update acknowledged", out, err)
	}
	if err = repo.Complete(t.Context(), userB, initial.ID); err == nil {
		t.Fatal("failed done acknowledged")
	}
	var storedDue sql.NullTime
	var updated time.Time
	var state string
	if err = db.QueryRow(`SELECT due_at,updated_at,state FROM history.later_entries WHERE id=$1`, initial.ID).Scan(&storedDue, &updated, &state); err != nil || storedDue.Valid || !updated.Equal(initial.UpdatedAt) || state != "active" {
		t.Fatal("failed writes changed entry", err)
	}
}
func TestLaterAccessLocksAndCancellation(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	gate, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Rollback() }()
	if _, err = gate.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, _, err := repo.Save(t.Context(), input); done <- err }()
	waitMessageQuery(t, db, "SELECT 1 FROM history.chat_members", true)
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, later.ErrNotFound) {
		t.Fatal("stale access allowed save", err)
	}
	if _, err = db.Exec(`INSERT INTO history.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')`, chat, userB); err != nil {
		t.Fatal(err)
	}
	gate, err = db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Rollback() }()
	if _, err = gate.Exec(`LOCK history.later_entries IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	out, created, err := repo.Save(ctx, input)
	if !errors.Is(err, context.DeadlineExceeded) || out.ID != "" || created {
		t.Fatal("cancelled insert", out, err)
	}
	waitMessageQuery(t, db, "INSERT INTO history.later_entries", false)
	if err = gate.Rollback(); err != nil {
		t.Fatal(err)
	}
	if active, done := laterCount(t, db, userB, message); active != 0 || done != 0 {
		t.Fatal("cancelled write persisted")
	}
}
func TestLaterDatabaseConstraints(t *testing.T) {
	db := laterDatabase(t)
	chat, message := laterMessage(t, db)
	_ = chat
	for _, sql := range []string{
		`INSERT INTO history.later_entries(user_id,message_id,state)VALUES('` + userB + `','` + message + `','due')`,
		`INSERT INTO history.later_entries(user_id,message_id,due_at)VALUES('` + userB + `','` + message + `','infinity')`,
		`INSERT INTO history.later_entries(user_id,message_id,due_at)VALUES('` + userB + `','` + message + `','-infinity')`,
		`INSERT INTO history.later_entries(user_id,message_id,due_at)VALUES('` + userB + `','` + message + `','10000-01-01 00:00:00+00')`,
		`INSERT INTO history.later_entries(user_id,message_id)VALUES('` + userB + `','` + missing + `')`,
	} {
		if _, err := db.ExecContext(t.Context(), sql); err == nil {
			t.Fatal("constraint accepted invalid row")
		}
	}
	if _, err := db.Exec(`INSERT INTO history.later_entries(user_id,message_id)VALUES($1,$2)`, userB, message); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO history.later_entries(user_id,message_id)VALUES($1,$2)`, userB, message); err == nil {
		t.Fatal("DB unique index allowed duplicate active row")
	}
	if _, err := db.Exec(`INSERT INTO history.later_entries(user_id,message_id,state)VALUES($1,$2,'done'),($1,$2,'done')`, userB, message); err != nil {
		t.Fatal("done history conflicts with active uniqueness", err)
	}
	for _, name := range []string{"later_entries_active_uq", "later_entries_active_list_idx", "later_entries_message_idx"} {
		var definition string
		if err := db.QueryRow(`SELECT indexdef FROM pg_indexes WHERE schemaname='history' AND indexname=$1`, name).Scan(&definition); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(name, "active") && !strings.Contains(definition, "WHERE (state = 'active'::text)") {
			t.Fatal("missing partial predicate", definition)
		}
	}
}

func TestLaterStorageFailureIsNotAbsence(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	entry, _, err := repo.Save(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`ALTER TABLE history.later_entries RENAME TO unavailable_later`); err != nil {
		t.Fatal(err)
	}
	if err = repo.Ready(t.Context()); err == nil {
		t.Fatal("readiness missed table outage")
	}
	if e, created, err := repo.Save(t.Context(), input); err == nil || errors.Is(err, later.ErrNotFound) || e.ID != "" || created {
		t.Fatal("storage failure became normal absence", e, err)
	}
	if err = repo.Complete(t.Context(), userB, entry.ID); err == nil || errors.Is(err, later.ErrNotFound) {
		t.Fatal("failed completion became normal absence", err)
	}
	if _, err = db.Exec(`ALTER TABLE history.unavailable_later RENAME TO later_entries`); err != nil {
		t.Fatal(err)
	}
	if err = repo.Ready(t.Context()); err != nil {
		t.Fatal("readiness did not recover", err)
	}
}
