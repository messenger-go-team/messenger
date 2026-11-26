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
	if _, err := revocation.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}

	// The deletion has not committed. Discovery sees the previous membership.
	old, err := client.ListPresencePeers(t.Context(), &historyv1.ListPresencePeersRequest{RequesterId: userA})
	if err != nil || !slices.Equal(old.GetUserIds(), []string{userB}) {
		t.Fatalf("uncommitted deletion changed discovery: %v, %v", old, err)
	}

	checkCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	check := make(chan error, 1)
	go func() {
		current, err := client.AuthorizePresenceDelivery(checkCtx, request)
		if err != nil {
			check <- err
			return
		}
		if ids := current.GetUserIds(); len(ids) > 0 {
			check <- status.Errorf(codes.Internal, "obsolete authorization: %v", ids)
			return
		}
		check <- nil
	}()
	waitMessageQuery(t, db, "SELECT history.lock_presence_delivery", true)
	if err := revocation.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-check; err != nil {
		t.Fatal(err)
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
			ok, err := repo.AuthorizePresenceDelivery(t.Context(), userA, []string{userB})
			if err != nil || !slices.Equal(ok, []string{userB}) {
				t.Fatalf("authorization before %s = %v, %v", tc.name, ok, err)
			}
			begin := time.Now()
			if _, err := db.ExecContext(t.Context(), tc.mutation, tc.args(chat)...); err != nil {
				t.Fatal(err)
			}
			if elapsed := time.Since(begin); elapsed < 250*time.Millisecond {
				t.Fatalf("mutation committed within the Chat write window: %s", elapsed)
			}
			denied, err := repo.AuthorizePresenceDelivery(t.Context(), userA, []string{userB})
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
