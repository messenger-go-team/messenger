package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
)

func TestLaterListTimeBoundaryAndOrdering(t *testing.T) {
	f := newReadingFixture(t)
	applyHistoryMigration(t, f.db, "000002_later_entries")
	ctx := t.Context()
	const fixed = "2026-11-27T19:04:00Z"
	// Only connections to this disposable test database use the fixed clock.
	_, err := f.db.ExecContext(ctx, `CREATE SCHEMA qa_test_clock;
CREATE FUNCTION qa_test_clock.statement_timestamp() RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT '2026-11-27T19:04:00Z'::timestamptz $$;`)
	if err != nil {
		t.Fatal(err)
	}
	var database string
	if err := f.db.QueryRowContext(ctx, "SELECT current_database()").Scan(&database); err != nil {
		t.Fatal(err)
	}
	_, err = f.db.ExecContext(ctx, "ALTER DATABASE "+pgx.Identifier{database}.Sanitize()+
		" SET search_path = qa_test_clock, pg_catalog, public")
	if err != nil {
		t.Fatal(err)
	}
	f.db.SetMaxIdleConns(0)

	now, err := time.Parse(time.RFC3339, fixed)
	if err != nil {
		t.Fatal(err)
	}
	past, future := now.Add(-time.Minute), now.Add(time.Minute)
	earlier, laterAt := now.Add(-2*time.Hour), now.Add(-time.Hour)
	id := func(rank int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", rank) }
	entries := []struct {
		id      int
		due     *time.Time
		created time.Time
		status  string
	}{
		{9, &past, laterAt, "due"},
		{3, &now, earlier, "due"},
		{5, &now, laterAt, "due"},
		{6, &now, laterAt, "due"},
		{2, &future, earlier, "scheduled"},
		{8, nil, earlier, "unscheduled"},
		{1, nil, laterAt, "unscheduled"},
		{4, nil, laterAt, "unscheduled"},
	}
	chat := messageChat(t, f.db, int64(len(entries)), userA, userB)
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		message := f.seed(t, chat, userA, int64(i+1), earlier.Format(time.RFC3339))
		_, err := f.db.ExecContext(ctx, `INSERT INTO history.later_entries(id,user_id,message_id,due_at,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$5)`, id(entry.id), userB, message, entry.due, entry.created)
		if err != nil {
			t.Fatal(err)
		}
	}

	var got later.List
	data := f.request(t, http.MethodGet, "/later", userB, "", http.StatusOK)
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !got.ServerTime.Equal(now) || len(got.Entries) != len(entries) {
		t.Fatalf("server_time=%s, entries=%d, want %s and %d", got.ServerTime, len(got.Entries), now, len(entries))
	}
	for i, want := range entries {
		entry := got.Entries[i]
		dueMatches := entry.DueAt == nil && want.due == nil ||
			entry.DueAt != nil && want.due != nil && entry.DueAt.Equal(*want.due)
		if entry.ID != id(want.id) || entry.Status != want.status || !entry.CreatedAt.Equal(want.created) || !dueMatches {
			t.Fatalf("entry %d: got %s (%s), want %s (%s); full list: %s", i, entry.ID, entry.Status, id(want.id), want.status, data)
		}
	}
}
