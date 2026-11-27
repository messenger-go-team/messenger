package main

import (
	"database/sql"
	"slices"
	"strings"
	"testing"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestListPresencePeersIntegration(t *testing.T) {
	db := historyDatabase(t)
	repo := &postgres.Repository{DB: db}
	client := startHistoryTestRPC(t, repo)

	chat, created, err := repo.Personal(t.Context(), userA, userB)
	if err != nil || !created {
		t.Fatalf("create real personal chat: %v, created=%t", err, created)
	}
	duplicate := messageChat(t, db, 0, userA, userB)
	const groupOnly = "98f481a7-9ce9-4da4-bdd5-7a7acf63b5dd"
	seedPresenceChat(t, db, "group", userA, groupOnly)
	const invalidPersonalOnly = "e5f259b6-6d05-4b79-8813-3dc7acbc2c25"
	seedPresenceChat(t, db, "personal", userA, groupOnly, invalidPersonalOnly)
	seedPresenceChat(t, db, "personal", userA)

	list := func(requester string, want ...string) {
		t.Helper()
		out, err := client.ListPresencePeers(t.Context(), &historyv1.ListPresencePeersRequest{RequesterId: requester})
		if err != nil || !slices.Equal(out.GetUserIds(), want) {
			t.Fatalf("ListPresencePeers(%s) = %v, %v; want %v", requester, out, err, want)
		}
	}
	list(userA, userB)
	list(userB, userA)
	list(groupOnly)
	list(invalidPersonalOnly)
	list(userC)

	// A new chat makes both participants visible in the next SQL snapshot.
	newChat, created, err := repo.Personal(t.Context(), userA, userC)
	if err != nil || !created {
		t.Fatalf("create new chat: %v, created=%t", err, created)
	}
	list(userA, userB, userC)
	list(userC, userA)

	// Revocation in one chat preserves access through an independent valid chat.
	if _, err := db.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat.ID, userB); err != nil {
		t.Fatal(err)
	}
	list(userA, userB, userC)
	if _, err := db.ExecContext(t.Context(), `DELETE FROM history.chats WHERE id=$1`, duplicate); err != nil {
		t.Fatal(err)
	}
	list(userA, userC)
	list(userB)
	if _, err := db.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, newChat.ID, userA); err != nil {
		t.Fatal(err)
	}
	list(userA)
	list(userC)

	for _, invalid := range []string{"", strings.ToUpper(userA), "00000000-0000-0000-0000-000000000000"} {
		out, err := client.ListPresencePeers(t.Context(), &historyv1.ListPresencePeersRequest{RequesterId: invalid})
		if out != nil || status.Code(err) != codes.InvalidArgument {
			t.Fatalf("request with invalid UUID %q returned %v, %v", invalid, out, err)
		}
	}

	if _, err := db.ExecContext(t.Context(), `ALTER TABLE history.chat_members RENAME TO members_unavailable`); err != nil {
		t.Fatal(err)
	}
	out, err := client.ListPresencePeers(t.Context(), &historyv1.ListPresencePeersRequest{RequesterId: userA})
	if out != nil || status.Code(err) != codes.Unavailable {
		t.Fatalf("storage failure returned %v, %v", out, err)
	}
}

func seedPresenceChat(t *testing.T, db *sql.DB, kind string, users ...string) {
	t.Helper()
	var chatID string
	if err := db.QueryRowContext(t.Context(), `INSERT INTO history.chats(type) VALUES($1) RETURNING id`, kind).Scan(&chatID); err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if _, err := db.ExecContext(t.Context(), `INSERT INTO history.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, chatID, user); err != nil {
			t.Fatal(err)
		}
	}
}
