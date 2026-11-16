package main

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
)

// Rejections must not wait behind SaveMessage's FOR UPDATE on an inaccessible
// chat. Keep the row locked until the operation returns; an elapsed deadline is
// a failure, not an acceptable replacement for the uniform ErrNotFound.
func TestLaterRejectsInaccessibleSourceBeforeChatLock(t *testing.T) {
	for _, tc := range []struct {
		name, user, source string
		complete, done     bool
	}{
		{"save outsider missing message", userC, "missing", false, false},
		{"save outsider existing message", userC, "current", false, false},
		{"save member missing message", userB, "missing", false, false},
		{"save member mismatched message", userB, "other chat", false, false},
		{"complete revoked active", userB, "current", true, false},
		{"complete revoked done", userB, "current", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := laterDatabase(t)
			repo := &postgres.LaterRepository{DB: db}
			chat, message := laterMessage(t, db)
			input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
			entry, _, err := repo.Save(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			if tc.complete {
				if tc.done {
					if err = repo.Complete(t.Context(), userB, entry.ID); err != nil {
						t.Fatal(err)
					}
					entry.State = "done"
				}
				if _, err = db.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
					t.Fatal(err)
				}
			} else {
				input.UserID = tc.user
				switch tc.source {
				case "missing":
					input.MessageID = missing
				case "other chat":
					_, input.MessageID = laterMessage(t, db)
				}
			}
			gate, err := db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback() }()
			if _, err = gate.ExecContext(t.Context(), `SELECT 1 FROM history.chats WHERE id=$1 FOR UPDATE`, chat); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			if tc.complete {
				err = repo.Complete(ctx, userB, entry.ID)
			} else {
				var out later.Entry
				var created bool
				out, created, err = repo.Save(ctx, input)
				if out != (later.Entry{}) || created {
					t.Fatal("inaccessible source returned entry data", out, created, err)
				}
			}
			if !errors.Is(err, later.ErrNotFound) {
				t.Fatal("inaccessible source must return ErrNotFound while the chat remains locked", err)
			}
			var state string
			if err = db.QueryRowContext(t.Context(), `SELECT state FROM history.later_entries WHERE id=$1`, entry.ID).Scan(&state); err != nil || state != entry.State {
				t.Fatal("rejected operation changed saved entry", state, err)
			}
			if active, done := laterCount(t, db, userC, message); active != 0 || done != 0 {
				t.Fatal("outsider created an entry", active, done)
			}
		})
	}
}

// The preliminary snapshot must not let a writer use access or a source that
// disappears while it waits for the first row lock.
func TestLaterRechecksSourceAfterChatLockWait(t *testing.T) {
	for _, complete := range []bool{false, true} {
		for _, removed := range []string{"membership", "message", "chat"} {
			operation := "save"
			if complete {
				operation = "complete"
			}
			t.Run(operation+" after removal of "+removed, func(t *testing.T) {
				db := laterDatabase(t)
				repo := &postgres.LaterRepository{DB: db}
				chat, message := laterMessage(t, db)
				input := later.SaveInput{UserID: userB, ChatID: chat, MessageID: message}
				entry, _, err := repo.Save(t.Context(), input)
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
				if _, err = gate.ExecContext(ctx, `SELECT 1 FROM history.chats WHERE id=$1 FOR UPDATE`, chat); err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() {
					if complete {
						done <- repo.Complete(ctx, userB, entry.ID)
						return
					}
					out, created, err := repo.Save(ctx, input)
					if out != (later.Entry{}) || created {
						err = errors.New("inaccessible source returned entry data")
					}
					done <- err
				}()
				waitMessageQuery(t, db, "SELECT 1 FROM history.chats WHERE id=", true)
				switch removed {
				case "membership":
					_, err = gate.ExecContext(ctx, `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB)
				case "message":
					_, err = gate.ExecContext(ctx, `DELETE FROM history.messages WHERE id=$1`, message)
				case "chat":
					_, err = gate.ExecContext(ctx, `DELETE FROM history.chats WHERE id=$1`, chat)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err = gate.Commit(); err != nil {
					t.Fatal(err)
				}
				if err = <-done; !errors.Is(err, later.ErrNotFound) {
					t.Fatal("preliminary snapshot bypassed current access/source check", err)
				}
				var state string
				var updated time.Time
				err = db.QueryRowContext(t.Context(), `SELECT state,updated_at FROM history.later_entries WHERE id=$1`, entry.ID).Scan(&state, &updated)
				if removed == "membership" {
					if err != nil || state != "active" || !updated.Equal(entry.UpdatedAt) {
						t.Fatal("revocation changed the saved entry", state, updated, err)
					}
				} else if !errors.Is(err, sql.ErrNoRows) {
					t.Fatal("removed source left an entry", err)
				}
			})
		}
	}
}

// A server-side timeout proves the DELETE reached PostgreSQL and was rejected
// specifically for a conflicting lock. Roll back every probe, even on failure,
// so an unexpectedly successful DELETE cannot corrupt the following phase.
func assertLaterSourceDeleteBlocked(t *testing.T, ctx context.Context, db *sql.DB, query string, args ...any) {
	t.Helper()
	probe, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = probe.Rollback() }()
	if _, err = probe.ExecContext(ctx, `SET LOCAL lock_timeout = '100ms'`); err != nil {
		t.Fatal(err)
	}
	_, err = probe.ExecContext(ctx, query, args...)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("source DELETE must fail with lock_not_available (55P03): %v", err)
	}
	if err = probe.Rollback(); err != nil {
		t.Fatal(err)
	}
}

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
			assertLaterSourceDeleteBlocked(t, ctx, db, query.sql, query.args...)
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
