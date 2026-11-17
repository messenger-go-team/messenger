package reading

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
)

const (
	readerID = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	chatID   = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
)

type repositoryFuncs struct {
	list    func(context.Context, string) ([]ChatItem, error)
	history func(context.Context, string, string, Query) (Page, error)
	mark    func(context.Context, string, string, int64) error
}

func (r repositoryFuncs) List(c context.Context, user string) ([]ChatItem, error) {
	return r.list(c, user)
}
func (r repositoryFuncs) History(c context.Context, chat, user string, q Query) (Page, error) {
	return r.history(c, chat, user, q)
}
func (r repositoryFuncs) MarkRead(c context.Context, chat, user string, seq int64) error {
	return r.mark(c, chat, user, seq)
}

type lookupFunc func(context.Context, string) (chats.User, error)

func (f lookupFunc) Lookup(c context.Context, id string) (chats.User, error) { return f(c, id) }

func TestQueryBoundaries(t *testing.T) {
	ptr := func(v int64) *int64 { return &v }
	for _, tc := range []struct {
		name  string
		q     Query
		valid bool
	}{
		{"minimum limit", Query{Limit: 1}, true}, {"maximum limit", Query{Limit: 100}, true},
		{"zero limit", Query{}, false}, {"negative limit", Query{Limit: -1}, false}, {"over limit", Query{Limit: 101}, false},
		{"before minimum", Query{Before: ptr(1), Limit: 1}, true},
		{"before maximum", Query{Before: ptr(messages.MaxSeq), Limit: 100}, true},
		{"before zero", Query{Before: ptr(0), Limit: 1}, false},
		{"before negative", Query{Before: ptr(-1), Limit: 1}, false},
		{"before overflow", Query{Before: ptr(messages.MaxSeq + 1), Limit: 1}, false},
		{"after zero", Query{After: ptr(0), Limit: 1}, true},
		{"after maximum", Query{After: ptr(messages.MaxSeq), Limit: 100}, true},
		{"after negative", Query{After: ptr(-1), Limit: 1}, false},
		{"after overflow", Query{After: ptr(messages.MaxSeq + 1), Limit: 1}, false},
		{"int64 maximum", Query{After: ptr(math.MaxInt64), Limit: 1}, false},
		{"mutually exclusive", Query{Before: ptr(1), After: ptr(0), Limit: 1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.q.Validate()
			if (err == nil) != tc.valid || (err != nil && !errors.Is(err, chats.ErrInvalid)) {
				t.Fatal(tc.q, err)
			}
			if !tc.valid {
				// Validation must finish before a read or a cursor mutation is possible.
				out, err := (&Service{}).History(t.Context(), chatID, readerID, tc.q)
				if !errors.Is(err, chats.ErrInvalid) || !reflect.DeepEqual(out, Page{}) {
					t.Fatal(out, err)
				}
			}
		})
	}
}

func TestReadingIdentityAndSequenceValidationBeforeStorage(t *testing.T) {
	for _, tc := range []struct {
		name, chat, user string
		seq              int64
		want             error
	}{
		{"identity precedes chat", "bad", "bad", 0, chats.ErrIdentity},
		{"chat invalid", "bad", readerID, 0, chats.ErrInvalid},
		{"negative read", chatID, readerID, -1, chats.ErrInvalid},
		{"read above safe integer", chatID, readerID, messages.MaxSeq + 1, chats.ErrInvalid},
		{"int64 read overflow", chatID, readerID, math.MaxInt64, chats.ErrInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Service{} // Nil dependencies expose accidental calls on rejected input.
			if err := s.MarkRead(t.Context(), tc.chat, tc.user, tc.seq); !errors.Is(err, tc.want) {
				t.Fatal(err)
			}
			if tc.seq == 0 {
				if out, err := s.History(t.Context(), tc.chat, tc.user, Query{Limit: 1}); !errors.Is(err, tc.want) || !reflect.DeepEqual(out, Page{}) {
					t.Fatal(out, err)
				}
			}
		})
	}
}

func TestHistoryPreservesPageContextAndDoesNotMarkRead(t *testing.T) {
	for _, failure := range []error{nil, chats.ErrNotFound, chats.ErrForbidden, chats.ErrUnavailable, context.Canceled, context.DeadlineExceeded} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			after := int64(0)
			q := Query{After: &after, Limit: 100}
			first, last := int64(4), messages.MaxSeq
			want := Page{Messages: []Message{{ID: "source-a", ChatID: chatID, Seq: first}, {ID: "source-b", ChatID: chatID, Seq: last}}, Before: &first, After: &last, MoreBefore: true}
			if failure != nil {
				want = Page{}
			}
			calls := 0
			s := &Service{Repo: repositoryFuncs{history: func(got context.Context, chat, user string, query Query) (Page, error) {
				calls++
				if got != ctx || chat != chatID || user != readerID || !reflect.DeepEqual(query, q) {
					t.Fatal("read boundary changed")
				}
				return want, failure
			}}}
			// mark and Users are absent: even a successful GET cannot call them.
			out, err := s.History(ctx, strings.ToUpper(chatID), strings.ToUpper(readerID), q)
			if !errors.Is(err, failure) || !reflect.DeepEqual(out, want) || calls != 1 {
				t.Fatal(out, err, calls)
			}
		})
	}
}

func TestMarkReadPreservesOwnerSequenceAndDependencyError(t *testing.T) {
	for _, seq := range []int64{0, 1, messages.MaxSeq} {
		for _, failure := range []error{nil, chats.ErrForbidden, chats.ErrNotFound, chats.ErrInvalid, context.Canceled, context.DeadlineExceeded} {
			t.Run(fmt.Sprintf("%d/%v", seq, failure), func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				calls := 0
				s := &Service{Repo: repositoryFuncs{mark: func(got context.Context, chat, user string, n int64) error {
					calls++
					if got != ctx || chat != chatID || user != readerID || n != seq {
						t.Fatal("cursor identity or precision changed")
					}
					return failure
				}}}
				if err := s.MarkRead(ctx, strings.ToUpper(chatID), strings.ToUpper(readerID), seq); !errors.Is(err, failure) || calls != 1 {
					t.Fatal(err, calls)
				}
			})
		}
	}
}

func TestListEmptyIdentityAndFailureBoundaries(t *testing.T) {
	outage := errors.New("database unavailable")
	for _, failure := range []error{nil, outage, context.Canceled} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if errors.Is(failure, context.Canceled) {
				cancel()
			}
			s := &Service{Repo: repositoryFuncs{list: func(got context.Context, user string) ([]ChatItem, error) {
				if got != ctx || user != readerID {
					t.Fatal("list lost identity/context")
				}
				if failure != nil {
					return nil, failure
				}
				return []ChatItem{}, nil
			}}}
			out, err := s.List(ctx, strings.ToUpper(readerID))
			if !errors.Is(err, failure) || (failure != nil && out != nil) || (failure == nil && (out == nil || len(out) != 0)) {
				t.Fatal(out, err)
			}
			// No Users dependency: empty memberships must not trigger an Auth lookup.
		})
	}
}

func TestListEnrichmentPreservesUnreadAndNeverReturnsPartialList(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	lookupCalls := 0
	s := &Service{Repo: repositoryFuncs{list: func(got context.Context, user string) ([]ChatItem, error) {
		if got != ctx || user != readerID {
			t.Fatal("wrong list arguments")
		}
		return []ChatItem{{ID: chatID, Unread: 2, Members: []chats.User{{ID: readerID}, {ID: chatID}}},
			{ID: "another-chat", Unread: 7, Members: []chats.User{{ID: readerID}, {ID: chatID}}}}, nil
	}}, Users: lookupFunc(func(got context.Context, id string) (chats.User, error) {
		if got != ctx {
			t.Fatal("lookup lost cancellation")
		}
		lookupCalls++
		return chats.User{ID: id, Username: "public"}, nil
	})}
	out, err := s.List(ctx, readerID)
	if err != nil || len(out) != 2 || out[0].Unread != 2 || out[1].Unread != 7 || lookupCalls != 2 {
		t.Fatal(out, err, lookupCalls)
	}
	for _, item := range out {
		for _, member := range item.Members {
			if member.Username != "public" {
				t.Fatal("unenriched member")
			}
		}
	}
	for _, failure := range []error{chats.ErrNotFound, chats.ErrUnavailable, context.Canceled} {
		lookupCalls = 0
		s.Users = lookupFunc(func(context.Context, string) (chats.User, error) {
			lookupCalls++
			if lookupCalls == 2 {
				return chats.User{}, failure
			}
			return chats.User{ID: readerID, Username: "resolved"}, nil
		})
		// First member resolved, second failed: a successful partial list is unsafe.
		out, err = s.List(ctx, readerID)
		if out != nil || !errors.Is(err, chats.ErrUnavailable) || lookupCalls != 2 {
			t.Fatal(out, err, lookupCalls)
		}
	}
}
