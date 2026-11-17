package main

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func TestUnreadCountAndCursorIsolation(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, messages.MaxSeq, userA, userB)
	// Sparse seq and mixed senders distinguish COUNT from last_seq-read_seq.
	for _, row := range []struct {
		seq    int64
		sender string
	}{{1, userB}, {4, userA}, {7, userB}, {11, userA}, {messages.MaxSeq, userB}} {
		f.seed(t, chat, row.sender, row.seq, "2026-11-17T00:00:00Z")
	}
	assertState := func(a, b, readA, readB int64) {
		t.Helper()
		for _, tc := range []struct {
			user         string
			unread, read int64
		}{{userA, a, readA}, {userB, b, readB}} {
			var out struct {
				Chats []reading.ChatItem `json:"chats"`
			}
			if err := json.Unmarshal(f.request(t, "GET", "/chats", tc.user, "", 200), &out); err != nil {
				t.Fatal(err)
			}
			if len(out.Chats) != 1 || out.Chats[0].ID != chat || out.Chats[0].Unread != tc.unread {
				t.Fatal("incorrect foreign-message count", tc.user, out)
			}
			if read, delivered := cursorState(t, f.db, chat, tc.user); read != tc.read || delivered != tc.read {
				t.Fatal("cursor isolation violated", tc.user, read, delivered)
			}
		}
	}
	assertState(3, 2, 0, 0)
	for _, seq := range []int64{7, 7, 4, 0} {
		f.request(t, "POST", "/chats/"+chat+"/read", userA, fmt.Sprintf(`{"seq":%d}`, seq), 204)
		assertState(1, 2, 7, 0)
	}
	// A successful GET and a rejected read must leave both participants intact.
	f.page(t, chat, "?after_seq=7", userA)
	f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":9007199254740992}`, 422)
	f.request(t, "POST", "/chats/"+chat+"/read", userC, `{"seq":7}`, 403)
	f.request(t, "GET", "/chats/"+chat+"/messages", userC, "", 403)
	assertState(1, 2, 7, 0)
	f.request(t, "POST", "/chats/"+chat+"/read", userB, `{"seq":11}`, 204)
	assertState(1, 0, 7, 11)
	f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":9007199254740991}`, 204)
	assertState(0, 0, messages.MaxSeq, 11)
}
