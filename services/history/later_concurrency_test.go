package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

func TestLaterSourceLocksUntilCommit(t *testing.T) {
	db := laterDatabase(t)
	repo := &postgres.LaterRepository{DB: db}
	chat, message := laterMessage(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, err := db.Exec(`CREATE FUNCTION history.pause_later() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(860086); RETURN NEW; END $$;
 CREATE TRIGGER pause_later BEFORE INSERT OR UPDATE ON history.later_entries FOR EACH ROW EXECUTE FUNCTION history.pause_later()`)
	if err != nil {
		t.Fatal(err)
	}
	input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
	var entry later.Entry
	for _, complete := range []bool{false, true} {
		gate, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Rollback() }()
		if _, err = gate.Exec(`SELECT pg_advisory_xact_lock(860086)`); err != nil {
			t.Fatal(err)
		}
		type result struct {
			entry later.Entry
			err   error
		}
		done := make(chan result, 1)
		if complete {
			go func() { done <- result{err: repo.Complete(ctx, userB, entry.ID)} }()
			waitMessageQuery(t, db, "UPDATE history.later_entries SET state=", true)
		} else {
			go func() { e, _, err := repo.Save(ctx, input); done <- result{e, err} }()
			waitMessageQuery(t, db, "INSERT INTO history.later_entries", true)
		}
		for _, query := range []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, []any{chat, userB}},
			{`DELETE FROM history.messages WHERE id=$1`, []any{message}},
			{`DELETE FROM history.chats WHERE id=$1`, []any{chat}},
		} {
			short, stop := context.WithTimeout(ctx, 100*time.Millisecond)
			_, err = db.ExecContext(short, query.sql, query.args...)
			stop()
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("source/access was not held until commit", complete, err)
			}
		}
		if err = gate.Rollback(); err != nil {
			t.Fatal(err)
		}
		got := <-done
		if got.err != nil {
			t.Fatal(got.err)
		}
		if !complete {
			entry = got.entry
		}
	}
	if active, done := laterCount(t, db, userB, message); active != 0 || done != 1 {
		t.Fatal(active, done)
	}
}
func TestLaterSaveCompleteSerialization(t *testing.T) {
	for _, doneFirst := range []bool{false, true} {
		name := "save before done"
		if doneFirst {
			name = "done before save"
		}
		t.Run(name, func(t *testing.T) {
			db := laterDatabase(t)
			repo := &postgres.LaterRepository{DB: db}
			chat, message := laterMessage(t, db)
			input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
			first, _, err := repo.Save(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			state := "active"
			if doneFirst {
				state = "done"
			}
			if _, err = db.Exec(`CREATE FUNCTION history.pause_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(860087); RETURN NEW; END $$;
    CREATE TRIGGER pause_transition BEFORE UPDATE ON history.later_entries FOR EACH ROW WHEN(NEW.state='` + state + `') EXECUTE FUNCTION history.pause_transition()`); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			gate, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback() }()
			if _, err = gate.Exec(`SELECT pg_advisory_xact_lock(860087)`); err != nil {
				t.Fatal(err)
			}
			type result struct {
				e       later.Entry
				created bool
				err     error
			}
			saved := make(chan result, 1)
			completed := make(chan error, 1)
			save := func() { e, c, err := repo.Save(ctx, input); saved <- result{e, c, err} }
			complete := func() { completed <- repo.Complete(ctx, userB, first.ID) }
			if doneFirst {
				go complete()
				waitMessageQuery(t, db, "UPDATE history.later_entries SET state=", true)
				go save()
				waitMessageQuery(t, db, "INSERT INTO history.later_entries", true)
			} else {
				go save()
				waitMessageQuery(t, db, "INSERT INTO history.later_entries", true)
				go complete()
				waitMessageQuery(t, db, "SELECT state FROM history.later_entries", true)
			}
			if err = gate.Rollback(); err != nil {
				t.Fatal(err)
			}
			got := <-saved
			if got.err != nil {
				t.Fatal(got.err)
			}
			if err = <-completed; err != nil {
				t.Fatal(err)
			}
			active, done := laterCount(t, db, userB, message)
			if doneFirst {
				if !got.created || got.e.ID == first.ID || active != 1 || done != 1 {
					t.Fatal("save after done lost new identity", got, active, done)
				}
			} else if got.created || got.e.ID != first.ID || active != 0 || done != 1 {
				t.Fatal("done after save did not complete old entry", got, active, done)
			}
		})
	}
}
