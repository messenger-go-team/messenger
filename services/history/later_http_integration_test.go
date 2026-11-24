package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func newLaterHTTPFixture(t *testing.T) *readingFixture {
	t.Helper()
	f := &readingFixture{db: laterDatabase(t)}
	applyHistoryMigration(t, f.db, "000003_public_receipts")
	f.repo = &postgres.Repository{DB: f.db}
	saved := &postgres.LaterRepository{DB: f.db}
	verifier, err := jwtauth.New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Bool
	ready.Store(true)
	// No Users adapter: Later must not depend on Auth directory availability.
	routes := chatRoutes(&chats.Service{}, verifier, &reading.Service{Repo: f.repo}, &later.Service{Repo: saved})
	f.web = httptest.NewServer(newServiceHandlerWithReadiness(&ready, newLogger(&f.logs, "history", 0), routes, historyReadiness(f.repo, saved)))
	t.Cleanup(f.web.Close)
	return f
}
func decodeLaterResult(t *testing.T, data []byte) later.Result {
	t.Helper()
	var out later.Result
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(data, &shape) != nil || len(shape) != 2 || shape["entry"] == nil || shape["server_time"] == nil {
		t.Fatal("bad result envelope", string(data))
	}
	var entry map[string]json.RawMessage
	if json.Unmarshal(shape["entry"], &entry) != nil || len(entry) != 6 {
		t.Fatal("bad public entry", string(data))
	}
	for _, field := range []string{"user_id", "state", "client_msg_id", "last_read_seq", "last_delivered_seq"} {
		if strings.Contains(string(data), `"`+field+`"`) {
			t.Fatal("internal field disclosed", field)
		}
	}
	if out.ServerTime.IsZero() || out.Entry.ID == "" || out.Entry.Message.ID == "" || !strings.HasSuffix(out.ServerTime.Format("2006-01-02T15:04:05Z07:00"), "Z") {
		t.Fatal(out)
	}
	return out
}
func getLaterList(t *testing.T, f *readingFixture, user string) later.List {
	t.Helper()
	var out later.List
	data := f.request(t, "GET", "/later", user, "", 200)
	var shape map[string]json.RawMessage
	if json.Unmarshal(data, &out) != nil || json.Unmarshal(data, &shape) != nil || len(shape) != 2 || out.ServerTime.IsZero() || out.Entries == nil {
		t.Fatal("bad list", string(data))
	}
	return out
}
func laterBody(chat, message, due string) string {
	return fmt.Sprintf(`{"chat_id":%q,"message_id":%q,"due_at":%s}`, chat, message, due)
}

func TestLaterRESTLifecycleAndOwnership(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat, message := laterMessage(t, f.db)
	if out := getLaterList(t, f, userB); len(out.Entries) != 0 {
		t.Fatal(out)
	}
	first := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201))
	id := first.Entry.ID
	if first.Entry.Status != "unscheduled" || first.Entry.DueAt != nil || first.Entry.Message.ID != message || first.Entry.Message.ChatID != chat || first.Entry.Message.Body != "original private source" {
		t.Fatal(first)
	}
	repeated := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(strings.ToUpper(chat), strings.ToUpper(message), `"2024-02-29T19:00:00.123456Z"`), 200))
	if repeated.Entry.ID != id || !repeated.Entry.CreatedAt.Equal(first.Entry.CreatedAt) || repeated.Entry.Status != "due" {
		t.Fatal(repeated)
	}
	moved := decodeLaterResult(t, f.request(t, "PATCH", "/later/"+strings.ToUpper(id), userB, `{"due_at":"9999-12-31T23:59:59.999999Z"}`, 200))
	if moved.Entry.ID != id || moved.Entry.Status != "scheduled" || !moved.Entry.CreatedAt.Equal(first.Entry.CreatedAt) {
		t.Fatal(moved)
	}
	cleared := decodeLaterResult(t, f.request(t, "PATCH", "/later/"+id, userB, `{"due_at":null}`, 200))
	if cleared.Entry.Status != "unscheduled" || cleared.Entry.DueAt != nil {
		t.Fatal(cleared)
	}
	// A different owner may save the same source, but cannot address this entry.
	own := decodeLaterResult(t, f.request(t, "POST", "/later", userA, laterBody(chat, message, "null"), 201))
	if own.Entry.ID == id {
		t.Fatal("owners share a personal entry")
	}
	for _, key := range []string{id, missing} {
		for _, action := range []struct{ method, suffix, body string }{{"PATCH", "", `{"due_at":null}`}, {"POST", "/done", ""}} {
			data := f.request(t, action.method, "/later/"+key+action.suffix, userA, action.body, 404)
			var e map[string]string
			_ = json.Unmarshal(data, &e)
			if e["code"] != "not_found" || e["message"] != "Сообщение недоступно." || len(e) != 3 {
				t.Fatal("nonuniform private 404", string(data))
			}
		}
	}
	f.request(t, "GET", "/later?user_id="+userA, userB, "", 422)
	if out := getLaterList(t, f, userB); len(out.Entries) != 1 || out.Entries[0].ID != id {
		t.Fatal("rejected query changed JWT owner's list", out)
	}
	if out := getLaterList(t, f, userA); len(out.Entries) != 1 || out.Entries[0].ID != own.Entry.ID {
		t.Fatal("rejected query changed peer's list", out)
	}
	f.request(t, "POST", "/later/"+id+"/done", userB, "", 204)
	f.request(t, "POST", "/later/"+id+"/done", userB, "", 204)
	f.request(t, "PATCH", "/later/"+id, userB, `{"due_at":null}`, 404)
	if out := getLaterList(t, f, userB); len(out.Entries) != 0 {
		t.Fatal("done still visible", out)
	}
	next := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201))
	if next.Entry.ID == id {
		t.Fatal("new lifecycle reused completed ID")
	}
	f.request(t, "POST", "/later/"+id+"/done", userB, "", 204)
	if out := getLaterList(t, f, userB); len(out.Entries) != 1 || out.Entries[0].ID != next.Entry.ID {
		t.Fatal("old retry completed new entry", out)
	}
	if out := getLaterList(t, f, userA); len(out.Entries) != 1 || out.Entries[0].ID != own.Entry.ID {
		t.Fatal("peer changed", out)
	}
	if read, delivered := cursorState(t, f.db, chat, userB); read != 0 || delivered != 0 {
		t.Fatal("Later advanced cursors", read, delivered)
	}
	assertMessageCounts(t, f.db, chat, 1, 1)
}

func TestLaterRESTCurrentAccessAndSourceDeletion(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat, message := laterMessage(t, f.db)
	entry := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201)).Entry
	other, _ := laterMessage(t, f.db)
	for _, in := range []struct{ user, chat, msg string }{{userC, chat, message}, {userB, missing, message}, {userB, chat, missing}, {userB, other, message}} {
		f.request(t, "POST", "/later", in.user, laterBody(in.chat, in.msg, "null"), 404)
	}
	if _, err := f.db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if out := getLaterList(t, f, userB); len(out.Entries) != 0 {
		t.Fatal("revoked source visible", out)
	}
	if active, _ := laterCount(t, f.db, userB, message); active != 1 {
		t.Fatal("revocation deleted entry")
	}
	f.request(t, "PATCH", "/later/"+entry.ID, userB, `{"due_at":null}`, 404)
	f.request(t, "POST", "/later/"+entry.ID+"/done", userB, "", 404)
	f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 404)
	if _, err := f.db.Exec(`INSERT INTO history.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')`, chat, userB); err != nil {
		t.Fatal(err)
	}
	if out := getLaterList(t, f, userB); len(out.Entries) != 1 || out.Entries[0].ID != entry.ID {
		t.Fatal("restored source missing", out)
	}
	if _, err := f.db.Exec(`DELETE FROM history.messages WHERE id=$1`, message); err != nil {
		t.Fatal(err)
	}
	if out := getLaterList(t, f, userB); len(out.Entries) != 0 {
		t.Fatal(out)
	}
	f.request(t, "PATCH", "/later/"+entry.ID, userB, `{"due_at":null}`, 404)
	f.request(t, "POST", "/later/"+entry.ID+"/done", userB, "", 404)
	chat, message = laterMessage(t, f.db)
	entry = decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201)).Entry
	if _, err := f.db.Exec(`DELETE FROM history.chats WHERE id=$1`, chat); err != nil {
		t.Fatal(err)
	}
	if out := getLaterList(t, f, userB); len(out.Entries) != 0 {
		t.Fatal(out)
	}
	f.request(t, "POST", "/later/"+entry.ID+"/done", userB, "", 404)
}

func TestLaterRESTValidationAndAuthorization(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat, message := laterMessage(t, f.db)
	entry := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201)).Entry
	for _, req := range []struct{ method, path, body string }{{"GET", "/later", ""}, {"POST", "/later", "{}"}, {"PATCH", "/later/" + entry.ID, "{}"}, {"POST", "/later/" + entry.ID + "/done", ""}} {
		f.request(t, req.method, req.path, "", req.body, 401)
	}
	for _, date := range []string{"0000-01-01T00:00:00Z", "2026-02-30T16:00:00Z", "2025-02-29T16:00:00Z", "2026-01-01T00:00:00Z\n", "2026-01-01T00:00:00Z\r\n", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.1234567Z", " 2026-01-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:59:60Z"} {
		raw, _ := json.Marshal(date)
		f.request(t, "POST", "/later", userB, laterBody(chat, message, string(raw)), 422)
		f.request(t, "PATCH", "/later/"+entry.ID, userB, `{"due_at":`+string(raw)+`}`, 422)
	}
	for _, raw := range []string{"null", `"2000-02-29T16:00:00Z"`, `"2024-02-29T16:00:00.123456Z"`, `"9999-12-31T23:59:59.999999Z"`} {
		decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, raw), 200))
		decodeLaterResult(t, f.request(t, "PATCH", "/later/"+entry.ID, userB, `{"due_at":`+raw+`}`, 200))
	}
	for _, body := range []string{`{}`, `null`, `[]`, `{"due_at":false}`, `{"due_at":0}`, `{"due_at":{}}`, `{"due_at":null,"due_at":null}`, `{"Due_at":null}`, `{"due_at":null,"user_id":"` + userA + `"}`, `{"due_at":null} {}`, `{"due_at":null}` + strings.Repeat(" ", 1<<20), "{\xff}"} {
		f.request(t, "PATCH", "/later/"+entry.ID, userB, body, 422)
	}
	for _, body := range []string{`{}`, `null`, fmt.Sprintf(`{"chat_id":%q,"message_id":%q}`, chat, message), laterBody(chat, message, "null") + ` {}`, fmt.Sprintf(`{"chat_id":%q,"message_id":%q,"due_at":null,"owner_id":%q}`, chat, message, userA), fmt.Sprintf(`{"chat_id":%q,"message_id":%q,"due_at":null,"due_at":null}`, chat, message), laterBody("bad", message, "null"), laterBody(chat, "bad", "null")} {
		f.request(t, "POST", "/later", userB, body, 422)
	}
	f.request(t, "PATCH", "/later/bad", userB, `{"due_at":null}`, 422)
	f.request(t, "POST", "/later/bad/done", userB, "", 422)
	f.request(t, "POST", "/later/"+entry.ID+"/done", userB, `{}`, 422)
	if active, done := laterCount(t, f.db, userB, message); active != 1 || done != 0 {
		t.Fatal("invalid input changed lifecycle", active, done)
	}
	if out := getLaterList(t, f, userA); len(out.Entries) != 0 {
		t.Fatal("owner override created peer entry", out)
	}
}

func TestLaterRESTOutageAndReadiness(t *testing.T) {
	f := newLaterHTTPFixture(t)
	assertLaterReadiness(t, f, 200)
	chat, message := laterMessage(t, f.db)
	entry := decodeLaterResult(t, f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201)).Entry
	if _, err := f.db.Exec(`ALTER TABLE history.later_entries RENAME TO unavailable_later`); err != nil {
		t.Fatal(err)
	}
	for _, req := range []struct{ method, path, body string }{{"GET", "/later", ""}, {"POST", "/later", laterBody(chat, message, "null")}, {"PATCH", "/later/" + entry.ID, `{"due_at":null}`}, {"POST", "/later/" + entry.ID + "/done", ""}} {
		data := f.request(t, req.method, req.path, userB, req.body, 503)
		// Input rejection must still win over a real storage outage.
		f.request(t, req.method, req.path+"?limit=1", userB, req.body, 422)
		f.request(t, req.method, req.path+"?due_at=%zz", userB, req.body, 422)
		var out map[string]string
		if json.Unmarshal(data, &out) != nil || out["code"] != "service_unavailable" || len(out) != 3 {
			t.Fatal(string(data))
		}
	}
	assertLaterReadiness(t, f, 503)
	if _, err := f.db.Exec(`ALTER TABLE history.unavailable_later RENAME TO later_entries`); err != nil {
		t.Fatal(err)
	}
	assertLaterReadiness(t, f, 200)
	if out := getLaterList(t, f, userB); len(out.Entries) != 1 || out.Entries[0].ID != entry.ID {
		t.Fatal(out)
	}
}

func TestLaterRESTLogsExcludePrivatePayload(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat, message := laterMessage(t, f.db)
	f.request(t, "POST", "/later", userB, laterBody(chat, message, "null"), 201)
	if _, err := f.db.Exec(`ALTER TABLE history.later_entries RENAME TO private_sql_later_marker`); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/later", userB, "", 503)
	for _, record := range f.logs.records(t) {
		raw, _ := json.Marshal(record)
		for _, private := range []string{"original private source", "private_sql_later_marker", serviceSecret} {
			if strings.Contains(string(raw), private) {
				t.Fatal("private diagnostic logged", private)
			}
		}
	}
}

func assertLaterReadiness(t *testing.T, f *readingFixture, want int) {
	t.Helper()
	res, err := f.web.Client().Get(f.web.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != want {
		t.Fatal("unexpected readiness", res.StatusCode, want)
	}
}

func TestLaterRESTConcurrentSaveHasOneCreatedResponse(t *testing.T) {
	f := newLaterHTTPFixture(t)
	chat, message := laterMessage(t, f.db)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	token := historyJWT(t, userB)
	type result struct {
		status int
		body   []byte
		err    error
	}
	const n = 24
	results := make(chan result, n)
	start := make(chan struct{})
	for range n {
		go func() {
			<-start
			r, err := http.NewRequestWithContext(ctx, http.MethodPost, f.web.URL+"/later", strings.NewReader(laterBody(chat, message, "null")))
			if err != nil {
				results <- result{err: err}
				return
			}
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			res, err := f.web.Client().Do(r)
			if err != nil {
				results <- result{err: err}
				return
			}
			body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
			_ = res.Body.Close()
			results <- result{status: res.StatusCode, body: body, err: err}
		}()
	}
	close(start)
	created, id := 0, ""
	for range n {
		got := <-results
		if got.err != nil || (got.status != 200 && got.status != 201) {
			t.Fatal(got.status, got.err)
		}
		if got.status == 201 {
			created++
		}
		out := decodeLaterResult(t, got.body)
		if id == "" {
			id = out.Entry.ID
		}
		if out.Entry.ID != id {
			t.Fatal("concurrent HTTP saved duplicate entries", out)
		}
	}
	if created != 1 {
		t.Fatal("wrong created response count", created)
	}
	if out := getLaterList(t, f, userB); len(out.Entries) != 1 || out.Entries[0].ID != id {
		t.Fatal(out)
	}
}
