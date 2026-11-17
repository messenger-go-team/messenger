package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/authclient"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

type readingFixture struct {
	db          *sql.DB
	repo        *postgres.Repository
	web         *httptest.Server
	authFailure atomic.Int32
	logs        recoveryLogs
}

func newReadingFixture(t *testing.T) *readingFixture {
	t.Helper()
	f := &readingFixture{db: historyDatabase(t)}
	f.repo = &postgres.Repository{DB: f.db}
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+serviceSecret {
			t.Error("incorrect service credential")
		}
		if f.authFailure.Load() == 1 {
			http.NotFound(w, r)
			return
		}
		if f.authFailure.Load() == 2 {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		id := strings.TrimPrefix(r.URL.Path, "/internal/users/")
		names := map[string]string{userA: "Alice_1", userB: "Bob_2", userC: "Carol_3"}
		_ = json.NewEncoder(w).Encode(chats.User{ID: id, Username: names[id]})
	}))
	t.Cleanup(auth.Close)
	users := authclient.New(auth.URL, serviceSecret)
	verifier, err := jwtauth.New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Bool
	ready.Store(true)
	f.web = httptest.NewServer(newServiceHandlerWithReadiness(&ready, newLogger(&f.logs, "history", 0), chatRoutes(&chats.Service{Repo: f.repo, Users: users}, verifier, &reading.Service{Repo: f.repo, Users: users}, &later.Service{Repo: &postgres.LaterRepository{DB: f.db}}), f.repo.Ready))
	t.Cleanup(f.web.Close)
	return f
}
func (f *readingFixture) request(t *testing.T, method, path, user, body string, want int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.web.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		req.Header.Set("Authorization", "Bearer "+historyJWT(t, user))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", "read-integration")
	res, err := f.web.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s: %d want %d: %s", method, path, res.StatusCode, want, data)
	}
	if want == 204 {
		if len(data) != 0 {
			t.Fatal("204 has body", string(data))
		}
	} else {
		if !json.Valid(data) {
			t.Fatal("non-JSON response", string(data))
		}
		if want >= 400 {
			var e map[string]json.RawMessage
			if json.Unmarshal(data, &e) != nil || len(e) < 2 || len(e) > 3 || (want != 401 && string(e["request_id"]) != `"read-integration"`) {
				t.Fatal("invalid ApiError", string(data))
			}
			if strings.Contains(string(data), serviceSecret) || strings.Contains(string(data), "private-sql") {
				t.Fatal("error leaks private diagnostics")
			}
		}
	}
	if want < 400 && res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("personal data response is cacheable")
	}
	return data
}
func (f *readingFixture) seed(t *testing.T, chat, sender string, seq int64, at string) string {
	t.Helper()
	var id string
	err := f.db.QueryRowContext(t.Context(), `INSERT INTO history.messages(chat_id,sender_id,client_msg_id,seq,body,created_at) VALUES($1,$2,gen_random_uuid(),$3,$4,$5) RETURNING id`, chat, sender, seq, "  private text 🙂 ", at).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func (f *readingFixture) page(t *testing.T, chat, query, user string) reading.Page {
	t.Helper()
	data := f.request(t, "GET", "/chats/"+chat+"/messages"+query, user, "", 200)
	var page reading.Page
	if err := json.Unmarshal(data, &page); err != nil {
		t.Fatal(err)
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(data, &shape) != nil || len(shape) != 5 {
		t.Fatal("incorrect page shape", string(data))
	}
	return page
}
func cursorState(t *testing.T, db *sql.DB, chat, user string) (int64, int64) {
	t.Helper()
	var read, delivered int64
	if err := db.QueryRowContext(t.Context(), `SELECT last_read_seq,last_delivered_seq FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, user).Scan(&read, &delivered); err != nil {
		t.Fatal(err)
	}
	return read, delivered
}
func TestHistoryRESTIntegration(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 12, userA, userB)
	for i, seq := range []int64{1, 3, 10, 12} {
		sender := userB
		if i%2 == 1 {
			sender = userA
		}
		f.seed(t, chat, sender, seq, "2026-11-15T12:00:00Z")
	}
	t.Run("pages ascending exclusive cursors and empty boundary", func(t *testing.T) {
		cases := []struct {
			query         string
			seqs          []int64
			before, after bool
		}{
			{"", []int64{1, 3, 10, 12}, false, false},
			{"?limit=2", []int64{10, 12}, true, false},
			{"?before_seq=10&limit=1", []int64{3}, true, true},
			{"?after_seq=1&limit=2", []int64{3, 10}, true, true},
			{"?after_seq=0&limit=1", []int64{1}, false, true},
			{"?before_seq=1", []int64{}, false, false},
			{"?after_seq=12", []int64{}, false, false},
			{"?after_seq=9007199254740991", []int64{}, false, false},
		}
		for _, c := range cases {
			page := f.page(t, strings.ToUpper(chat), c.query, userA)
			seqs := []int64{}
			for _, m := range page.Messages {
				seqs = append(seqs, m.Seq)
				if m.ChatID != chat || m.Body != "  private text 🙂 " || m.CreatedAt.Location() != time.UTC {
					t.Fatal("message modified", m)
				}
			}
			if !slices.Equal(seqs, c.seqs) || page.MoreBefore != c.before || page.MoreAfter != c.after {
				t.Fatalf("%s: %+v", c.query, page)
			}
			if len(c.seqs) == 0 {
				if page.Messages == nil || page.Before != nil || page.After != nil {
					t.Fatal("wrong empty page", page)
				}
			} else if page.Before == nil || page.After == nil || *page.Before != c.seqs[0] || *page.After != c.seqs[len(c.seqs)-1] {
				t.Fatal("wrong cursors", page)
			}
		}
		if read, delivered := cursorState(t, f.db, chat, userA); read != 0 || delivered != 0 {
			t.Fatal("GET changed cursor")
		}
		empty := messageChat(t, f.db, 0, userA, userB)
		if p := f.page(t, empty, "", userA); len(p.Messages) != 0 || p.MoreBefore || p.MoreAfter {
			t.Fatal(p)
		}
	})
	t.Run("JWT access and validation including empty pages", func(t *testing.T) {
		for _, path := range []string{"/chats", "/chats/" + chat + "/messages?before_seq=1", "/chats/" + missing + "/messages"} {
			f.request(t, "GET", path, "", "", 401)
		}
		f.request(t, "POST", "/chats/"+chat+"/read", "", `{"seq":0}`, 401)
		for _, q := range []string{"?before_seq=1", "?after_seq=9007199254740991", ""} {
			f.request(t, "GET", "/chats/"+chat+"/messages"+q, userC, "", 403)
			f.request(t, "GET", "/chats/"+missing+"/messages"+q, userA, "", 404)
		}
		f.request(t, "GET", "/chats/bad/messages", userA, "", 422)
		for _, q := range []string{"?before_seq=0", "?limit=101", "?after_seq=1&before_seq=12", "?after_seq=1&after_seq=2"} {
			f.request(t, "GET", "/chats/"+chat+"/messages"+q, userA, "", 422)
		}
		f.request(t, "POST", "/chats/"+chat+"/read", userC, `{"seq":13}`, 403)
		f.request(t, "POST", "/chats/"+missing+"/read", userA, `{"seq":0}`, 404)
		for _, body := range []string{`{}`, `null`, `{"seq":null}`, `{"seq":-1}`, `{"seq":13}`, `{"seq":9007199254740992}`, `{"seq":"1"}`, `{"seq":1.1}`, `{"seq":1e0}`, `{"seq":1,"seq":2}`, `{"seq":1,"user_id":"x"}`, `{"seq":1} {}`} {
			f.request(t, "POST", "/chats/"+chat+"/read", userA, body, 422)
		}
		if read, delivered := cursorState(t, f.db, chat, userA); read != 0 || delivered != 0 {
			t.Fatal("invalid request changed cursor")
		}
	})
	t.Run("private monotone read cursor gaps and new messages", func(t *testing.T) {
		for _, body := range []string{`{"seq":3}`, `{"seq":0}`, `{"seq":3}`, `{"seq":1}`} {
			f.request(t, "POST", "/chats/"+chat+"/read", userA, body, 204)
		}
		if read, delivered := cursorState(t, f.db, chat, userA); read != 3 || delivered != 3 {
			t.Fatal(read, delivered)
		}
		if read, delivered := cursorState(t, f.db, chat, userB); read != 0 || delivered != 0 {
			t.Fatal("peer cursor changed")
		}
		f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":9}`, 204)
		rows, err := f.repo.List(t.Context(), userA)
		if err != nil {
			t.Fatal(err)
		}
		var unread int64
		for _, row := range rows {
			if row.ID == chat {
				unread = row.Unread
			}
		}
		if unread != 1 {
			t.Fatal("gaps or own messages counted", unread)
		}
		f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":10}`, 204)
		saved, err := messages.New(f.repo).Save(t.Context(), messages.Input{ChatID: chat, SenderID: userB, ClientID: messageKey(t), Body: "after read"})
		if err != nil || saved.Seq != 13 {
			t.Fatal(saved, err)
		}
		results := make(chan error, 48)
		start := make(chan struct{})
		for i := range 48 {
			go func() { <-start; results <- f.repo.MarkRead(t.Context(), chat, userA, int64(i%13)) }()
		}
		close(start)
		for range 48 {
			if err := <-results; err != nil {
				t.Fatal(err)
			}
		}
		if read, delivered := cursorState(t, f.db, chat, userA); read != 12 || delivered != 12 {
			t.Fatal("concurrent cursor regressed", read, delivered)
		}
		rows, err = f.repo.List(t.Context(), userA)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if row.ID == chat && row.Unread != 1 {
				t.Fatal("new unread lost", row.Unread)
			}
		}
	})
}
func TestChatListRESTIntegration(t *testing.T) {
	f := newReadingFixture(t)
	a := messageChat(t, f.db, 9, userA, userB)
	b := messageChat(t, f.db, 2, userA, userC)
	emptyA := messageChat(t, f.db, 0, userA, userB)
	emptyB := messageChat(t, f.db, 0, userA, userC)
	hidden := messageChat(t, f.db, 1, userB, userC)
	f.seed(t, hidden, userB, 1, "2026-11-16T12:00:00Z")
	f.seed(t, a, userB, 1, "2026-11-16T12:00:00Z") // Later timestamp, but not the latest seq.
	last := f.seed(t, a, userA, 9, "2026-11-15T12:00:00Z")
	f.seed(t, b, userC, 2, "2026-11-15T12:00:00Z")
	data := f.request(t, "GET", "/chats", userA, "", 200)
	var out struct {
		Chats []reading.ChatItem `json:"chats"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	want := []string{a, b}
	slices.Sort(want)
	empties := []string{emptyA, emptyB}
	slices.Sort(empties)
	want = append(want, empties...)
	got := []string{}
	for _, item := range out.Chats {
		got = append(got, item.ID)
		if len(item.Members) != 2 || item.Members[0].Username != "Alice_1" {
			t.Fatal("missing public summaries", item)
		}
		if item.ID == a && (item.LastMessage == nil || item.LastMessage.ID != last || item.Unread != 1) {
			t.Fatal("last message must use seq; unread must exclude self", item)
		}
		if item.ID == b && item.Unread != 1 {
			t.Fatal("seq gaps counted as messages", item)
		}
		if (item.ID == emptyA || item.ID == emptyB) && (item.LastMessage != nil || item.Unread != 0) {
			t.Fatal("empty chat wrong", item)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatal("wrong ordering or leaked chat", got, want)
	}
	if strings.Contains(string(data), "last_read_seq") || strings.Contains(string(data), "client_msg_id") || strings.Contains(string(data), serviceSecret) {
		t.Fatal("private fields leaked")
	}
	for _, mode := range []int32{1, 2} {
		f.authFailure.Store(mode)
		f.request(t, "GET", "/chats", userA, "", 503)
	}
	// Neither history nor read cursor needs the Auth directory.
	f.page(t, a, "", userA)
	f.request(t, "POST", "/chats/"+a+"/read", userA, `{"seq":1}`, 204)
	f.authFailure.Store(0)
	if _, err := f.db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, b, userA); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/chats/"+b+"/messages?after_seq=2", userA, "", 403)
	f.request(t, "POST", "/chats/"+b+"/read", userA, `{"seq":0}`, 403)
	// History authenticates the JWT locally. Without memberships an unknown
	// subject has an empty list, even when the Auth directory is unavailable.
	for _, mode := range []int32{0, 1, 2} {
		f.authFailure.Store(mode)
		data = f.request(t, "GET", "/chats", missing, "", 200)
		if string(data) != "{\"chats\":[]}\n" {
			t.Fatal("empty list must be array", string(data))
		}
		f.request(t, "GET", "/chats/"+a+"/messages?before_seq=1", missing, "", 403)
		f.request(t, "POST", "/chats/"+a+"/read", missing, `{"seq":0}`, 403)
		f.request(t, "GET", "/chats/"+missing+"/messages", missing, "", 404)
		f.request(t, "POST", "/chats/"+missing+"/read", missing, `{"seq":0}`, 404)
	}
	f.authFailure.Store(0)
	if _, err := f.db.Exec(`ALTER TABLE history.messages RENAME TO missing_messages`); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/chats", "/chats/" + a + "/messages"} {
		f.request(t, "GET", path, userA, "", 503)
	}
	if err := f.repo.Ready(t.Context()); err == nil {
		t.Fatal("readiness ignored missing table")
	}
	if _, err := f.db.Exec(`ALTER TABLE history.missing_messages RENAME TO messages`); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.Ready(t.Context()); err != nil {
		t.Fatal("readiness did not recover", err)
	}
}
func TestHistoryPageSnapshot(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 4, userA, userB)
	for i := int64(1); i <= 4; i++ {
		f.seed(t, chat, userB, i, "2026-11-15T12:00:00Z")
	}
	gate, err := f.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Rollback() }()
	if _, err = gate.Exec(`LOCK history.messages IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		page reading.Page
		err  error
	}
	done := make(chan result, 1)
	after := int64(0)
	go func() {
		p, e := f.repo.History(t.Context(), chat, userA, reading.Query{After: &after, Limit: 4})
		done <- result{p, e}
	}()
	waitMessageQuery(t, f.db, "SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages", true)
	if _, err = gate.Exec(`INSERT INTO history.messages(chat_id,sender_id,client_msg_id,seq,body) VALUES($1,$2,gen_random_uuid(),5,'concurrent message');`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if _, err = gate.Exec(`UPDATE history.chats SET last_seq=5 WHERE id=$1`, chat); err != nil {
		t.Fatal(err)
	}
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || len(got.page.Messages) != 4 || got.page.MoreAfter {
		t.Fatal("page and flags saw different snapshots", got)
	}
	next := f.page(t, chat, "?after_seq=4", userA)
	if len(next.Messages) != 1 || next.Messages[0].Seq != 5 {
		t.Fatal(next)
	}
}

// An outsider must receive the contract's 403 while a legitimate writer still
// holds the chat row. A client deadline turns accidental lock waits into a
// failure without releasing the gate and allowing a false-positive response.
func TestMarkReadRejectsNonMembersWhileChatLocked(t *testing.T) {
	for _, tc := range []struct {
		name, user string
		revoked    bool
	}{
		{"outsider", userC, false},
		{"subject unknown to Auth", missing, false},
		{"revoked member", userA, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newReadingFixture(t)
			chat := messageChat(t, f.db, 10, userA, userB)
			if tc.revoked {
				if _, err := f.db.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, tc.user); err != nil {
					t.Fatal(err)
				}
			}
			gate, err := f.db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback() }()
			if _, err = gate.ExecContext(t.Context(), `SELECT 1 FROM history.chats WHERE id=$1 FOR UPDATE`, chat); err != nil {
				t.Fatal(err)
			}
			// Even seq above last_seq must not reveal chat state to a non-member.
			for _, body := range []string{`{"seq":0}`, `{"seq":11}`} {
				ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
				defer cancel()
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.web.URL+"/chats/"+chat+"/read", strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+historyJWT(t, tc.user))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Request-ID", "locked-nonmember")
				res, err := f.web.Client().Do(req)
				if err != nil {
					t.Fatalf("non-member must receive 403 before the chat lock is released: %v", err)
				}
				data, readErr := io.ReadAll(res.Body)
				_ = res.Body.Close()
				var apiErr map[string]string
				if readErr != nil || res.StatusCode != http.StatusForbidden || json.Unmarshal(data, &apiErr) != nil || apiErr["code"] != "chat_membership_required" || apiErr["request_id"] != "locked-nonmember" || res.Header.Get("Cache-Control") != "no-store" {
					t.Fatalf("non-member response: status=%d body=%s error=%v", res.StatusCode, data, readErr)
				}
			}
			if read, delivered := cursorState(t, f.db, chat, userB); read != 0 || delivered != 0 {
				t.Fatal("denied read changed another member's cursors", read, delivered)
			}
		})
	}
}

func TestReadCursorRollbackAndCancellation(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 20, userA, userB)
	t.Run("commit failure does not acknowledge or advance cursors", func(t *testing.T) {
		_, err := f.db.Exec(`CREATE FUNCTION history.fail_read_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-sql-read-failure'; END $$; CREATE CONSTRAINT TRIGGER fail_read_commit AFTER UPDATE ON history.chat_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history.fail_read_commit()`)
		if err != nil {
			t.Fatal(err)
		}
		f.request(t, "POST", "/chats/"+chat+"/read", userA, `{"seq":10}`, 503)
		if read, delivered := cursorState(t, f.db, chat, userA); read != 0 || delivered != 0 {
			t.Fatal(read, delivered)
		}
		if _, err = f.db.Exec(`DROP TRIGGER fail_read_commit ON history.chat_members`); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("waiting read rechecks revoked membership", func(t *testing.T) {
		gate, err := f.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Rollback() }()
		var last int64
		if err = gate.QueryRow(`SELECT last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, chat).Scan(&last); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- f.repo.MarkRead(t.Context(), chat, userA, 10) }()
		waitMessageQuery(t, f.db, "SELECT last_seq FROM history.chats", true)
		if _, err = gate.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userA); err != nil {
			t.Fatal(err)
		}
		if err = gate.Commit(); err != nil {
			t.Fatal(err)
		}
		if err = <-done; !errors.Is(err, chats.ErrForbidden) {
			t.Fatal("stale access advanced cursor", err)
		}
	})
	t.Run("context cancels blocked SQL", func(t *testing.T) {
		gate, err := f.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Rollback() }()
		var last int64
		if err = gate.QueryRow(`SELECT last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, chat).Scan(&last); err != nil {
			t.Fatal(err)
		}
		short, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		if err = f.repo.MarkRead(short, chat, userB, 10); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if read, delivered := cursorState(t, f.db, chat, userB); read != 0 || delivered != 0 {
			t.Fatal("cancelled update changed cursor")
		}
		if err = gate.Rollback(); err != nil {
			t.Fatal(err)
		}
	})
	for _, record := range f.logs.records(t) {
		line, _ := json.Marshal(record)
		if strings.Contains(string(line), "private-sql-read-failure") || strings.Contains(string(line), "private text") || strings.Contains(string(line), serviceSecret) {
			t.Fatal("log leaks private data")
		}
	}
}

func TestHistoryPageLimitsAndMaxSeq(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 135, userA, userB)
	if _, err := f.db.Exec(`INSERT INTO history.messages(chat_id,sender_id,client_msg_id,seq,body) SELECT $1,$2,gen_random_uuid(),n,'message' FROM generate_series(1,135)n`, chat, userB); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query         string
		first, last   int64
		count         int
		before, after bool
	}{
		{"", 86, 135, 50, true, false},
		{"?limit=100", 36, 135, 100, true, false},
		{"?after_seq=0&limit=100", 1, 100, 100, false, true},
		{"?before_seq=102&limit=2", 100, 101, 2, true, true},
	} {
		p := f.page(t, chat, tc.query, userA)
		if len(p.Messages) != tc.count || p.Messages[0].Seq != tc.first || p.Messages[len(p.Messages)-1].Seq != tc.last || p.MoreBefore != tc.before || p.MoreAfter != tc.after {
			t.Fatal(tc, p)
		}
	}
	maxChat := messageChat(t, f.db, messages.MaxSeq, userA, userB)
	f.seed(t, maxChat, userB, messages.MaxSeq, "2026-11-15T12:00:00Z")
	p := f.page(t, maxChat, "", userA)
	if len(p.Messages) != 1 || p.Messages[0].Seq != messages.MaxSeq || p.MoreBefore || p.MoreAfter {
		t.Fatal("max seq lost or rounded", p)
	}
	f.request(t, "POST", "/chats/"+maxChat+"/read", userA, `{"seq":9007199254740991}`, 204)
	if read, delivered := cursorState(t, f.db, maxChat, userA); read != messages.MaxSeq || delivered != messages.MaxSeq {
		t.Fatal("cursor rounded", read, delivered)
	}
}
func TestChatListSnapshotDuringSave(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 0, userA, userB)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	done := make(chan error, 1)
	keys := make([]string, 40)
	for i := range keys {
		keys[i] = messageKey(t)
	}
	go func() {
		for _, key := range keys {
			if _, err := messages.New(f.repo).Save(ctx, messages.Input{ChatID: chat, SenderID: userB, ClientID: key, Body: "incoming"}); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for range 40 {
		rows, err := f.repo.List(ctx, userA)
		if err != nil || len(rows) != 1 {
			t.Fatal(rows, err)
		}
		item := rows[0]
		if item.LastMessage == nil {
			if item.Unread != 0 {
				t.Fatal("mixed empty snapshot", item)
			}
		} else if item.Unread != item.LastMessage.Seq {
			t.Fatal("last message and unread count saw different snapshots", item)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestHistoryQueryPlans(t *testing.T) {
	f := newReadingFixture(t)
	chat := messageChat(t, f.db, 20000, userA, userB)
	if _, err := f.db.Exec(`INSERT INTO history.messages(chat_id,sender_id,client_msg_id,seq,body) SELECT $1,$2,gen_random_uuid(),n,'query plan fixture' FROM generate_series(1,20000)n`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`ANALYZE history.messages`); err != nil {
		t.Fatal(err)
	}
	// Same projections, predicates and ordering as Repository.History. Never
	// disable seqscan: the normal planner must choose the existing index.
	for _, query := range []string{
		`SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE chat_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3`,
		`SELECT id,chat_id,seq,sender_id,body,created_at FROM history.messages WHERE chat_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3`,
	} {
		var data []byte
		if err := f.db.QueryRowContext(t.Context(), "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+query, chat, 10000, 50).Scan(&data); err != nil {
			t.Fatal(err)
		}
		var plan []map[string]any
		if err := json.Unmarshal(data, &plan); err != nil {
			t.Fatal(err)
		}
		found := false
		var walk func(any)
		walk = func(value any) {
			switch v := value.(type) {
			case map[string]any:
				if v["Index Name"] == "messages_chat_seq_uq" {
					found = true
				}
				for _, child := range v {
					walk(child)
				}
			case []any:
				for _, child := range v {
					walk(child)
				}
			}
		}
		walk(plan[0])
		if !found {
			t.Fatal("history index not chosen", string(data))
		}
		t.Log(string(data))
	}
}
