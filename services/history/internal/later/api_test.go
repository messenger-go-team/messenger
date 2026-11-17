package later

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func TestParseDueStrictCalendar(t *testing.T) {
	for _, text := range []string{"0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999999Z", "2000-02-29T12:00:00Z", "2024-02-29T19:00:00.1Z"} {
		raw, _ := json.Marshal(text)
		at, err := ParseDue(raw)
		if err != nil || at == nil || at.Location() != time.UTC {
			t.Fatal(text, at, err)
		}
	}
	if at, err := ParseDue(json.RawMessage("null")); err != nil || at != nil {
		t.Fatal(at, err)
	}
	for _, text := range []string{"", "0000-01-01T00:00:00Z", "2026-02-30T16:00:00Z", "2025-02-29T16:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:59:60Z", "2026-01-01T00:00:00.1234567Z", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00Z\n", "2026-01-01T00:00:00Z\r\n", " 2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z ", "2026-01-01t00:00:00z", "2026-01-01T00:00:00,1Z"} {
		raw, _ := json.Marshal(text)
		if at, err := ParseDue(raw); !errors.Is(err, ErrInvalid) || at != nil {
			t.Fatal("invalid timestamp accepted", text, at, err)
		}
	}
	for _, raw := range []json.RawMessage{nil, json.RawMessage("0"), json.RawMessage("false"), json.RawMessage("{}"), json.RawMessage("[]")} {
		if at, err := ParseDue(raw); !errors.Is(err, ErrInvalid) || at != nil {
			t.Fatal(raw, at, err)
		}
	}
}

func TestProjectStatusAtOneDatabaseInstant(t *testing.T) {
	at := time.Date(2026, 11, 17, 19, 0, 0, 123456000, time.UTC)
	for _, offset := range []time.Duration{-time.Microsecond, 0, time.Microsecond} {
		due := at.Add(offset)
		e := Entry{ID: "private-id", UserID: "owner", State: "active", DueAt: &due, CreatedAt: at, UpdatedAt: at}
		m := reading.Message{ID: "source", Body: "original"}
		out := Project(e, m, at)
		want := "due"
		if offset > 0 {
			want = "scheduled"
		}
		if out.Status != want || out.Message != m || out.ID != e.ID || !out.CreatedAt.Equal(at) {
			t.Fatal(out)
		}
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), "owner") || strings.Contains(string(raw), "active") {
			t.Fatal("internal metadata leaked", string(raw))
		}
	}
	if out := Project(Entry{}, reading.Message{}, at); out.Status != "unscheduled" || out.DueAt != nil {
		t.Fatal(out)
	}
}

type apiStub struct {
	save func(context.Context, SaveInput) (Result, bool, error)
	list func(context.Context, string) (List, error)
	move func(context.Context, string, string, *time.Time) (Result, error)
	done func(context.Context, string, string) error
}

func (r apiStub) SaveRecord(c context.Context, in SaveInput) (Result, bool, error) {
	return r.save(c, in)
}
func (r apiStub) ListRecords(c context.Context, u string) (List, error) { return r.list(c, u) }
func (r apiStub) Reschedule(c context.Context, u, id string, at *time.Time) (Result, error) {
	return r.move(c, u, id, at)
}
func (r apiStub) Complete(c context.Context, u, id string) error { return r.done(c, u, id) }

func TestServiceValidationBeforeStorage(t *testing.T) {
	const valid = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	s := &Service{} // No rejected input may invoke a repository method.
	if _, err := s.List(t.Context(), "bad"); !errors.Is(err, chats.ErrIdentity) {
		t.Fatal(err)
	}
	if _, _, err := s.Save(t.Context(), "bad", valid, valid, nil); !errors.Is(err, chats.ErrIdentity) {
		t.Fatal(err)
	}
	for _, ids := range [][2]string{{"bad", valid}, {valid, "bad"}} {
		if _, _, err := s.Save(t.Context(), valid, ids[0], ids[1], nil); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	if _, err := s.Reschedule(t.Context(), "bad", valid, nil); !errors.Is(err, chats.ErrIdentity) {
		t.Fatal(err)
	}
	if _, err := s.Reschedule(t.Context(), valid, "bad", nil); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if err := s.Complete(t.Context(), "bad", valid); !errors.Is(err, chats.ErrIdentity) {
		t.Fatal(err)
	}
	if err := s.Complete(t.Context(), valid, "bad"); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	invalid := time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, _, err := s.Save(t.Context(), valid, valid, valid, &invalid); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := s.Reschedule(t.Context(), valid, valid, &invalid); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestServiceIdentityContextAndFailures(t *testing.T) {
	const id = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	due := time.Date(2024, 2, 29, 19, 0, 0, 123456000, time.FixedZone("device", 10800))
	for _, failure := range []error{nil, ErrNotFound, context.Canceled, errors.New("storage unavailable")} {
		calls := 0
		check := func(c context.Context, u string) {
			t.Helper()
			calls++
			if c != ctx || u != id {
				t.Fatal("identity/context lost")
			}
		}
		result := Result{ServerTime: due.UTC(), Entry: Record{ID: id}}
		list := List{ServerTime: due.UTC(), Entries: []Record{}}
		s := &Service{Repo: apiStub{
			save: func(c context.Context, in SaveInput) (Result, bool, error) {
				check(c, in.UserID)
				if in.ChatID != id || in.MessageID != id || in.DueAt.Location() != time.UTC || !in.DueAt.Equal(due) {
					t.Fatal(in)
				}
				return result, true, failure
			},
			list: func(c context.Context, u string) (List, error) { check(c, u); return list, failure },
			move: func(c context.Context, u, key string, at *time.Time) (Result, error) {
				check(c, u)
				if key != id || at.Location() != time.UTC || !at.Equal(due) {
					t.Fatal(key, at)
				}
				return result, failure
			},
			done: func(c context.Context, u, key string) error {
				check(c, u)
				if key != id {
					t.Fatal(key)
				}
				return failure
			},
		}}
		wantResult, wantList, wantCreated := result, list, true
		if failure != nil {
			wantResult = Result{}
			wantList = List{}
			wantCreated = false
		}
		upper := strings.ToUpper(id)
		if out, created, err := s.Save(ctx, upper, upper, upper, &due); !errors.Is(err, failure) || !reflect.DeepEqual(out, wantResult) || created != wantCreated {
			t.Fatal(out, created, err)
		}
		if out, err := s.List(ctx, upper); !errors.Is(err, failure) || !reflect.DeepEqual(out, wantList) {
			t.Fatal(out, err)
		}
		if out, err := s.Reschedule(ctx, upper, upper, &due); !errors.Is(err, failure) || !reflect.DeepEqual(out, wantResult) {
			t.Fatal(out, err)
		}
		if err := s.Complete(ctx, upper, upper); !errors.Is(err, failure) {
			t.Fatal(err)
		}
		if calls != 4 {
			t.Fatal(calls)
		}
	}
}
