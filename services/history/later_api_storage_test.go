package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

func TestLaterListOrderingAndNoHiddenLimit(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat := messageChat(t, f.db, 140, userA, userB)
	if _, err := f.db.Exec(`INSERT INTO history.messages(chat_id,sender_id,client_msg_id,seq,body)
 SELECT $1,$2,gen_random_uuid(),n,'full unpaginated list' FROM generate_series(1,140)n`, chat, userA); err != nil {
		t.Fatal(err)
	}
	// Repeated dates/created_at exercise every tie-breaker. UUID text is fixed-width
	// canonical hex, so its lexicographic order also represents UUID value order.
	if _, err := f.db.Exec(`INSERT INTO history.later_entries(id,user_id,message_id,due_at,created_at,updated_at)
 SELECT md5(m.seq::text)::uuid,$2,m.id,CASE m.seq%3 WHEN 0 THEN NULL WHEN 1 THEN TIMESTAMPTZ '2024-02-29 16:00:00+00' + (m.seq%7)*INTERVAL '1 hour' ELSE TIMESTAMPTZ '9999-12-31 16:00:00+00' + (m.seq%7)*INTERVAL '1 hour' END,
 TIMESTAMPTZ '2020-01-01 00:00:00+00' + (m.seq%2)*INTERVAL '1 hour',TIMESTAMPTZ '2020-01-01 00:00:00+00' FROM history.messages m WHERE m.chat_id=$1`, chat, userB); err != nil {
		t.Fatal(err)
	}
	out := getLaterList(t, f, userB)
	if len(out.Entries) != 140 {
		t.Fatal("list was truncated", len(out.Entries))
	}
	// The plain GET above proves the full list; no query limit exists in MVP.
	f.request(t, "GET", "/later?limit=1", userB, "", 422)
	rank := map[string]int{"due": 0, "scheduled": 1, "unscheduled": 2}
	for i, entry := range out.Entries {
		want := "unscheduled"
		if entry.DueAt != nil {
			want = "scheduled"
			if !entry.DueAt.After(out.ServerTime) {
				want = "due"
			}
		}
		if entry.Status != want {
			t.Fatal("status used a different instant", entry)
		}
		if i > 0 {
			prev := out.Entries[i-1]
			if rank[prev.Status] > rank[entry.Status] {
				t.Fatal("wrong status order", prev, entry)
			}
			if prev.Status == entry.Status {
				sameDue := prev.DueAt == nil && entry.DueAt == nil
				if prev.DueAt != nil && entry.DueAt != nil {
					if prev.DueAt.After(*entry.DueAt) {
						t.Fatal("wrong deadline order", prev, entry)
					}
					sameDue = prev.DueAt.Equal(*entry.DueAt)
				}
				if sameDue && (prev.CreatedAt.After(entry.CreatedAt) || (prev.CreatedAt.Equal(entry.CreatedAt) && prev.ID > entry.ID)) {
					t.Fatal("unstable tie-breakers", prev, entry)
				}
			}
		}
	}
	// No memberships and no Auth lookup still means an empty personal list.
	if out := getLaterList(t, f, userC); len(out.Entries) != 0 {
		t.Fatal("foreign list disclosed", out)
	}
}

func TestLaterAPIProjectionRollsBackOnCommitFailure(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	initial, _, err := repo.SaveRecord(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE FUNCTION history.fail_later_api() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-later-api-commit'; END $$;
 CREATE CONSTRAINT TRIGGER fail_later_api AFTER INSERT OR UPDATE ON history.later_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history.fail_later_api()`); err != nil {
		t.Fatal(err)
	}
	due := time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	input.DueAt = &due
	out, created, err := repo.SaveRecord(t.Context(), input)
	if err == nil || created || !reflect.DeepEqual(out, later.Result{}) {
		t.Fatal("uncommitted save projection escaped", out, created, err)
	}
	out, err = repo.Reschedule(t.Context(), userB, initial.Entry.ID, &due)
	if err == nil || !reflect.DeepEqual(out, later.Result{}) {
		t.Fatal("uncommitted reschedule projection escaped", out, err)
	}
	list, err := repo.ListRecords(t.Context(), userB)
	if err != nil || len(list.Entries) != 1 || list.Entries[0].DueAt != nil || !list.Entries[0].UpdatedAt.Equal(initial.Entry.UpdatedAt) {
		t.Fatal("rollback changed metadata", list, err)
	}
}

func TestLaterAPIBlockedSQLCancellation(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	initial, _, err := repo.SaveRecord(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	gate, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Rollback() }()
	if _, err = gate.Exec(`LOCK history.later_entries IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"list", "save", "reschedule"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			switch operation {
			case "list":
				out, err := repo.ListRecords(ctx, userB)
				if !errors.Is(err, context.DeadlineExceeded) || !reflect.DeepEqual(out, later.List{}) {
					t.Fatal(out, err)
				}
			case "save":
				out, created, err := repo.SaveRecord(ctx, input)
				if !errors.Is(err, context.DeadlineExceeded) || created || !reflect.DeepEqual(out, later.Result{}) {
					t.Fatal(out, created, err)
				}
			case "reschedule":
				out, err := repo.Reschedule(ctx, userB, initial.Entry.ID, nil)
				if !errors.Is(err, context.DeadlineExceeded) || !reflect.DeepEqual(out, later.Result{}) {
					t.Fatal(out, err)
				}
			}
		})
	}
}

func TestLaterListUsesConsistentAccessSnapshot(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	entry, _, err := repo.SaveRecord(t.Context(), later.SaveInput{UserID: userB, ChatID: chat, MessageID: message})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	gate, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Rollback() }()
	if _, err = gate.Exec(`LOCK history.later_entries IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		list later.List
		err  error
	}
	done := make(chan result, 1)
	go func() { out, err := repo.ListRecords(ctx, userB); done <- result{out, err} }()
	waitMessageQuery(t, db, "SELECT e.id,e.due_at", true)
	if _, err = gate.Exec(`UPDATE history.later_entries SET state='done' WHERE id=$1;`, entry.Entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = gate.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || len(got.list.Entries) != 1 || got.list.Entries[0].ID != entry.Entry.ID {
		t.Fatal("timestamp/access/list used different snapshots", got)
	}
	fresh, err := repo.ListRecords(ctx, userB)
	if err != nil || len(fresh.Entries) != 0 {
		t.Fatal("next request retained stale access", fresh, err)
	}
}

func TestLaterRescheduleRechecksSourceAfterWait(t *testing.T) {
	for _, removed := range []string{"membership", "message", "chat"} {
		t.Run(removed, func(t *testing.T) {
			db := laterDatabase(t)
			repo := &postgres.LaterRepository{DB: db}
			chat, message := laterMessage(t, db)
			entry, _, err := repo.SaveRecord(t.Context(), later.SaveInput{UserID: userB, ChatID: chat, MessageID: message})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			gate, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback() }()
			if _, err = gate.Exec(`SELECT 1 FROM history.chats WHERE id=$1 FOR UPDATE`, chat); err != nil {
				t.Fatal(err)
			}
			type result struct {
				out later.Result
				err error
			}
			done := make(chan result, 1)
			go func() { out, err := repo.Reschedule(ctx, userB, entry.Entry.ID, nil); done <- result{out, err} }()
			waitMessageQuery(t, db, "SELECT 1 FROM history.chats WHERE id=", true)
			switch removed {
			case "membership":
				_, err = gate.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB)
			case "message":
				_, err = gate.Exec(`DELETE FROM history.messages WHERE id=$1`, message)
			case "chat":
				_, err = gate.Exec(`DELETE FROM history.chats WHERE id=$1`, chat)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = gate.Commit(); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if !errors.Is(got.err, later.ErrNotFound) || !reflect.DeepEqual(got.out, later.Result{}) {
				t.Fatal(got)
			}
		})
	}
}

func TestLaterRescheduleAndCompleteBothOrders(t *testing.T) {
	for _, doneFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(doneFirst), func(t *testing.T) {
			db := laterDatabase(t)
			repo := &postgres.LaterRepository{DB: db}
			chat, message := laterMessage(t, db)
			entry, _, err := repo.SaveRecord(t.Context(), later.SaveInput{UserID: userB, ChatID: chat, MessageID: message})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			gate, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback() }()
			if _, err = gate.Exec(`SELECT 1 FROM history.later_entries WHERE id=$1 FOR UPDATE`, entry.Entry.ID); err != nil {
				t.Fatal(err)
			}
			moved, completed := make(chan error, 1), make(chan error, 1)
			move := func() { _, err := repo.Reschedule(ctx, userB, entry.Entry.ID, nil); moved <- err }
			complete := func() { completed <- repo.Complete(ctx, userB, entry.Entry.ID) }
			if doneFirst {
				go complete()
				waitMessageQuery(t, db, "SELECT state FROM history.later_entries", true)
				go move()
				waitMessageQuery(t, db, "UPDATE history.later_entries SET due_at=", true)
			} else {
				go move()
				waitMessageQuery(t, db, "UPDATE history.later_entries SET due_at=", true)
				go complete()
				waitMessageQuery(t, db, "SELECT state FROM history.later_entries", true)
			}
			if err = gate.Rollback(); err != nil {
				t.Fatal(err)
			}
			moveErr, doneErr := <-moved, <-completed
			if doneErr != nil || (doneFirst && !errors.Is(moveErr, later.ErrNotFound)) || (!doneFirst && moveErr != nil) {
				t.Fatal(moveErr, doneErr)
			}
			if active, done := laterCount(t, db, userB, message); active != 0 || done != 1 {
				t.Fatal(active, done)
			}
		})
	}
}

func TestHistoryReadinessRequiresMigrations(t *testing.T) {
	db := historyDatabase(t)
	base := &postgres.Repository{DB: db}
	saved := &postgres.LaterRepository{DB: db}
	if err := base.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	check := historyReadiness(base, saved)
	if err := check(t.Context()); err == nil {
		t.Fatal("API ready against v1 schema")
	}
	migration, err := os.ReadFile("migrations/000002_later_entries.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), string(migration)); err != nil {
		t.Fatal(err)
	}
	if err = check(t.Context()); err == nil {
		t.Fatal("API ready against v2 schema")
	}
	applyHistoryMigration(t, db, "000003_public_receipts")
	if err = check(t.Context()); err != nil {
		t.Fatal("API not ready after v3", err)
	}
}
