package main

import (
	"context"
	"database/sql"
	"slices"
	"testing"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestPresenceDeliveryWaitsForRevocationAndRereadsMembership(t *testing.T) {
	db := historyDatabase(t)
	applyHistoryMigration(t, db, "000004_presence_delivery")
	chat := messageChat(t, db, 0, userA, userB)
	client := startHistoryTestRPC(t, &postgres.Repository{DB: db})
	request := &historyv1.AuthorizePresenceDeliveryRequest{RequesterId: userA, UserIds: []string{userB}}
	out, err := client.AuthorizePresenceDelivery(t.Context(), request)
	if err != nil || !slices.Equal(out.GetUserIds(), []string{userB}) {
		t.Fatalf("valid chat authorization = %v, %v", out, err)
	}

	revocation, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = revocation.Rollback() }()
	const deletePeer = `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`
	deletion := make(chan error, 1)
	go func() {
		_, err := revocation.ExecContext(t.Context(), deletePeer, chat, userB)
		deletion <- err
	}()
	waitPresenceRevocation(t, db, deletePeer)

	// Discovery still sees the old membership. New grants are denied, and
	// the previous writer's grant keeps this revocation from committing.
	old, err := client.ListPresencePeers(t.Context(), &historyv1.ListPresencePeersRequest{RequesterId: userA})
	if err != nil || !slices.Equal(old.GetUserIds(), []string{userB}) {
		t.Fatalf("uncommitted deletion changed discovery: %v, %v", old, err)
	}
	now, err := client.AuthorizePresenceDelivery(t.Context(), request)
	if err != nil || len(now.GetUserIds()) != 0 {
		t.Fatalf("revocation in progress permitted another writer: %v, %v", now, err)
	}
	if out.GetGrantId() == "" {
		t.Fatal("only a persisted grant may authorize a write")
	}
	_, err = client.BatchPresence(t.Context(), &historyv1.BatchPresenceRequest{ReleasedGrantIds: []string{out.GetGrantId()}})
	if err != nil {
		t.Fatal(err)
	}
	if err := <-deletion; err != nil {
		t.Fatal(err)
	}
	if err := revocation.Commit(); err != nil {
		t.Fatal(err)
	}
	after, err := client.AuthorizePresenceDelivery(t.Context(), request)
	if err != nil || len(after.GetUserIds()) != 0 {
		t.Fatalf("committed revocation permitted new writes: %v, %v", after, err)
	}
}

func TestPresenceDeliveryRevocationGuardsEveryAuthorizationPath(t *testing.T) {
	db := historyDatabase(t)
	applyHistoryMigration(t, db, "000004_presence_delivery")
	repo := &postgres.Repository{DB: db}
	for _, tc := range []struct {
		name, mutation string
		args           func(string) []any
	}{
		{"delete membership", `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, func(chat string) []any { return []any{chat, userB} }},
		{"delete chat cascade", `DELETE FROM history.chats WHERE id=$1`, func(chat string) []any { return []any{chat} }},
		{"change member identity", `UPDATE history.chat_members SET user_id=$3 WHERE chat_id=$1 AND user_id=$2`, func(chat string) []any { return []any{chat, userB, userC} }},
		{"add third member", `INSERT INTO history.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, func(chat string) []any { return []any{chat, userC} }},
		{"change chat type", `UPDATE history.chats SET type='group' WHERE id=$1`, func(chat string) []any { return []any{chat} }},
		{"truncate members", `TRUNCATE history.chat_members CASCADE`, func(string) []any { return nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chat := messageChat(t, db, 0, userA, userB)
			ok, grantID, err := repo.AuthorizePresenceDelivery(t.Context(), userA, []string{userB})
			if err != nil || grantID == "" || !slices.Equal(ok, []string{userB}) {
				t.Fatalf("authorization before %s = %v, %v", tc.name, ok, err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := db.ExecContext(t.Context(), tc.mutation, tc.args(chat)...)
				done <- err
			}()
			waitPresenceRevocation(t, db, tc.mutation)
			if err := repo.ReleasePresenceDeliveries(t.Context(), []string{grantID}); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			denied, _, err := repo.AuthorizePresenceDelivery(t.Context(), userA, []string{userB})
			if err != nil || len(denied) > 0 {
				t.Fatalf("authorization after %s = %v, %v", tc.name, denied, err)
			}
		})
	}
}

func TestPresenceDeliveryTakesLocksForEntireBatch(t *testing.T) {
	db := historyDatabase(t)
	applyHistoryMigration(t, db, "000004_presence_delivery")
	ab := messageChat(t, db, 0, userA, userB)
	ac := messageChat(t, db, 0, userA, userC)
	var others int
	grant, err := db.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = grant.Rollback() }()
	if _, err := grant.ExecContext(t.Context(), `SELECT history.lock_presence_delivery($1::uuid[])`, []string{ab, ac}); err != nil {
		t.Fatal(err)
	}
	if err := grant.QueryRowContext(t.Context(), `
		SELECT count(*) FROM pg_locks
		WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ShareLock' AND classid=132`).Scan(&others); err != nil {
		t.Fatal(err)
	}
	if others != 2 {
		t.Fatalf("batch locked %d chats, want 2", others)
	}
}

func TestPresenceDeliveryWithoutGuardMigrationFailsClosed(t *testing.T) {
	db := historyDatabase(t)
	messageChat(t, db, 0, userA, userB)
	client := startHistoryTestRPC(t, &postgres.Repository{DB: db})
	reply, err := client.AuthorizePresenceDelivery(t.Context(), &historyv1.AuthorizePresenceDeliveryRequest{
		RequesterId: userA, UserIds: []string{userB},
	})
	if reply != nil || status.Code(err) != codes.Unavailable {
		t.Fatalf("guardless History authorized presence: %v, %v", reply, err)
	}
}

func TestPresenceDeliveryWithLostReleaseHasBoundedWait(t *testing.T) {
	db := historyDatabase(t)
	applyHistoryMigration(t, db, "000004_presence_delivery")
	repo := &postgres.Repository{DB: db}
	chat := messageChat(t, db, 0, userA, userB)
	_, grantID, err := repo.AuthorizePresenceDelivery(t.Context(), userA, []string{userB})
	if err != nil || grantID == "" {
		t.Fatalf("initial grant = %q, %v", grantID, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 18*time.Second)
	defer cancel()
	begin := time.Now()
	if _, err := db.ExecContext(ctx, `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(begin); elapsed < 11*time.Second {
		t.Fatalf("revocation outpaced a possible writer after %s", elapsed)
	}
	if grants, err := repo.ActivePresenceGrants(t.Context()); err != nil || len(grants) != 0 {
		t.Fatalf("fallback left grants active: %v, %v", grants, err)
	}
}

func waitPresenceRevocation(t *testing.T, db *sql.DB, mutation string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := db.QueryRowContext(ctx, `
			SELECT EXISTS (
			    SELECT 1 FROM pg_stat_activity
			    WHERE datname = current_database() AND query = $1 AND wait_event = 'PgSleep'
			)`, mutation).Scan(&waiting); err != nil {
			t.Fatalf("revocation did not wait for the active reservation: %v", err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}
