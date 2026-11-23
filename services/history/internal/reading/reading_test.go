package reading

import (
	"context"
	"errors"
	"testing"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

type fakeRepo struct{ calls int }

func (r *fakeRepo) List(context.Context, string) ([]ChatItem, error) {
	r.calls++
	return []ChatItem{{Members: []chats.User{{ID: "23968cc7-c30c-47b0-a741-6b81249aa5e7"}, {ID: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"}}}, {Members: []chats.User{{ID: "23968cc7-c30c-47b0-a741-6b81249aa5e7"}, {ID: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"}}}}, nil
}
func (r *fakeRepo) History(context.Context, string, string, Query) (Page, error) {
	r.calls++
	return Page{Messages: []Message{}}, nil
}
func (r *fakeRepo) MessageContext(context.Context, string, string, string, int) (MessageContext, error) {
	r.calls++
	return MessageContext{}, nil
}
func (r *fakeRepo) MarkRead(context.Context, string, string, int64) error { r.calls++; return nil }

type fakeUsers struct {
	calls int
	err   error
}

func (u *fakeUsers) Lookup(_ context.Context, id string) (chats.User, error) {
	u.calls++
	return chats.User{ID: id, Username: "Alice_1"}, u.err
}
func TestValidationAndLookupBoundary(t *testing.T) {
	const user = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	r, u := &fakeRepo{}, &fakeUsers{}
	s := &Service{Repo: r, Users: u}
	both := int64(1)
	for _, q := range []Query{{Limit: 0}, {Limit: 101}, {Limit: 1, Before: &both, After: &both}} {
		if _, err := s.History(t.Context(), user, user, q); !errors.Is(err, chats.ErrInvalid) {
			t.Fatal(err)
		}
	}
	if err := s.MarkRead(t.Context(), user, user, -1); !errors.Is(err, chats.ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := s.List(t.Context(), "bad"); !errors.Is(err, chats.ErrIdentity) {
		t.Fatal(err)
	}
	if r.calls != 0 {
		t.Fatal("invalid request reached storage")
	}
	items, err := s.List(t.Context(), user)
	if err != nil || len(items) != 2 || u.calls != 2 || items[1].Members[1].Username != "Alice_1" {
		t.Fatal(items, u.calls, err)
	}
	// A second request must resolve summaries again; no cross-request cache.
	if _, err = s.List(t.Context(), user); err != nil || u.calls != 4 {
		t.Fatal(u.calls, err)
	}
	u.err = chats.ErrNotFound
	if items, err = s.List(t.Context(), user); items != nil || !errors.Is(err, chats.ErrUnavailable) {
		t.Fatal("missing summary must not return a partial list", items, err)
	}
	u.err = errors.New("Auth unavailable")
	if _, err = s.History(t.Context(), user, user, Query{Limit: 1}); err != nil {
		t.Fatal("history must not depend on Auth", err)
	}
	if err = s.MarkRead(t.Context(), user, user, 0); err != nil {
		t.Fatal("read cursor must not depend on Auth", err)
	}
}

func (*fakeRepo) Receipts(context.Context, string, string) ([]MemberReceipt, error) {
	panic("unexpected Receipts call")
}
