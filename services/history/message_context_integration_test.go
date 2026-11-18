package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func contextPath(chat, message string) string {
	return "/chats/" + chat + "/messages/" + message + "/context"
}

func TestMessageContextWindowAndPaginationIntegration(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 220, userA, userB)
	ids := make(map[int64]string, 110)
	const messageTime = "2026-11-15T12:00:00Z"
	for seq := int64(2); seq <= 220; seq += 2 {
		ids[seq] = f.seed(t, chat, userB, seq, messageTime)
	}
	f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":4}`, 204)
	f.request(t, "POST", "/chats/"+chat+"/read", userB, `{"seq":8}`, 204)
	firstPage := f.page(t, chat, "", userA)
	if *firstPage.Before <= 10 {
		t.Fatalf("target must be older than the first page, starts at %d", *firstPage.Before)
	}
	f.authFailure.Store(2) // Context uses current membership in History, with no Auth lookup.

	for _, tc := range []struct {
		name, query           string
		target, first         int64
		last                  int64
		moreBefore, moreAfter bool
	}{
		{"target only", "?limit=1", 10, 10, 10, true, true},
		{"deep target", "?limit=3", 10, 8, 12, true, true},
		{"even limit favors newer", "?limit=4", 10, 8, 14, true, true},
		{"start without rebalancing", "?limit=4", 2, 2, 6, false, true},
		{"end without rebalancing", "?limit=4", 220, 218, 220, true, false},
		{"side exactly fits", "?limit=3", 4, 2, 6, false, true},
		{"default limit", "", 110, 62, 160, true, true},
		{"maximum limit", "?limit=100", 110, 12, 210, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := contextPath(strings.ToUpper(chat), strings.ToUpper(ids[tc.target])) + tc.query
			data := f.request(t, "GET", path, userA, "", 200)
			var out reading.MessageContext
			if err := json.Unmarshal(data, &out); err != nil {
				t.Fatal(err)
			}
			var shape map[string]json.RawMessage
			if json.Unmarshal(data, &shape) != nil || len(shape) != 6 {
				t.Fatalf("unexpected response fields: %s", data)
			}
			if out.TargetMessageID != ids[tc.target] || out.Before != tc.first || out.After != tc.last ||
				out.MoreBefore != tc.moreBefore || out.MoreAfter != tc.moreAfter {
				t.Fatalf("unexpected target, cursors or flags: %+v", out)
			}
			if want := int((tc.last-tc.first)/2 + 1); len(out.Messages) != want {
				t.Fatalf("got %d messages, want %d", len(out.Messages), want)
			}
			for i, m := range out.Messages {
				seq := tc.first + 2*int64(i)
				if m.Seq != seq || m.ID != ids[seq] || m.ChatID != chat || m.SenderID != userB ||
					m.Body != "  private text 🙂 " || m.CreatedAt.Format(time.RFC3339) != messageTime {
					t.Fatalf("unexpected message at seq %d: %+v", seq, m)
				}
			}
			if tc.name == "deep target" {
				older := f.page(t, chat, fmt.Sprintf("?before_seq=%d&limit=2", out.Before), userA)
				newer := f.page(t, chat, fmt.Sprintf("?after_seq=%d&limit=2", out.After), userA)
				var seqs []int64
				for _, m := range slices.Concat(older.Messages, out.Messages, newer.Messages) {
					seqs = append(seqs, m.Seq)
				}
				if !slices.Equal(seqs, []int64{4, 6, 8, 10, 12, 14, 16}) {
					t.Fatalf("pagination has a gap or duplicate: %v", seqs)
				}
			}
		})
	}
	for user, want := range map[string]int64{userA: 4, userB: 8} {
		if read, delivered := cursorState(t, f.db, chat, user); read != want || delivered != want {
			t.Fatalf("context changed cursors for %s: (%d, %d), want (%d, %d)", user, read, delivered, want, want)
		}
	}

	single := messageChat(t, f.db, 9, userA, userB)
	path := contextPath(single, f.seed(t, single, userB, 9, messageTime))
	data := f.request(t, "GET", path, userA, "", 200)
	var out reading.MessageContext
	if json.Unmarshal(data, &out) != nil || len(out.Messages) != 1 || out.Before != 9 || out.After != 9 || out.MoreBefore || out.MoreAfter {
		t.Fatalf("unexpected context for one-message chat: %s", data)
	}
}

func TestMessageContextAccessAndValidationIntegration(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 3, userA, userB)
	other := messageChat(t, f.db, 3, userA, userC)
	id := f.seed(t, chat, userB, 3, "2026-11-15T12:00:00Z")
	path := contextPath(chat, id)
	f.request(t, "POST", "/chats/"+chat+"/read", userB, `{"seq":2}`, 204)

	unavailable := func(path, user string) string {
		t.Helper()
		data := f.request(t, "GET", path, user, "", 404)
		var body map[string]string
		if json.Unmarshal(data, &body) != nil || len(body) != 3 ||
			body["code"] != "not_found" || body["message"] != "Сообщение недоступно." {
			t.Fatalf("unexpected inaccessible-resource response: %s", data)
		}
		return string(data)
	}
	want := unavailable(contextPath(chat, missing), userA)
	for _, tc := range []struct{ path, user string }{
		{contextPath(missing, id), userA}, {contextPath(other, id), userA}, {path, userC},
	} {
		if got := unavailable(tc.path, tc.user); got != want {
			t.Fatalf("404 discloses the reason: %s versus %s", got, want)
		}
	}

	f.request(t, "GET", path, userA, "", 200)
	if _, err := f.db.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userA); err != nil {
		t.Fatal(err)
	}
	if got := unavailable(path, userA); got != want {
		t.Fatalf("revoked membership has a distinct response: %s", got)
	}
	if _, err := f.db.ExecContext(t.Context(), `INSERT INTO history.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')`, chat, userA); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", path, userA, "", 200)
	if read, delivered := cursorState(t, f.db, chat, userB); read != 2 || delivered != 2 {
		t.Fatalf("context changed peer cursors: %d/%d", read, delivered)
	}
	if read, delivered := cursorState(t, f.db, chat, userA); read != 0 || delivered != 0 {
		t.Fatalf("context changed viewer cursors: %d/%d", read, delivered)
	}

	// A closed database proves that invalid queries and UUIDs fail before storage.
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"before_seq=1", "after_seq=1", "limit=3&user_id=" + userB, "unknown=1",
		"limit=1&limit=2", "limit=0", "limit=101", "limit=", "limit=1.5",
		"limit=1e1", "limit=%2B1", "limit=1%0A", "limit=%ZZ", "limit=1;before_seq=2",
		"limit=18446744073709551616",
	} {
		f.request(t, "GET", path+"?"+raw, "", "", 401)
		f.request(t, "GET", path+"?"+raw, userA, "", 422)
	}
	for _, invalid := range []string{contextPath("bad", id), contextPath(chat, "bad"), contextPath(chat, "x%2f..%2f"+id)} {
		f.request(t, "GET", invalid, "", "", 401)
		f.request(t, "GET", invalid, userA, "", 422)
	}
	data := f.request(t, "GET", path, userA, "", 503)
	var body map[string]string
	if json.Unmarshal(data, &body) != nil || len(body) != 3 || body["code"] != "service_unavailable" {
		t.Fatalf("unexpected storage error response: %s", data)
	}
}
