package chats

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	ownerID = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	peerID  = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
)

type personalRepository struct {
	personal func(context.Context, string, string) (Chat, bool, error)
}

func (r personalRepository) Personal(ctx context.Context, owner, peer string) (Chat, bool, error) {
	return r.personal(ctx, owner, peer)
}
func (personalRepository) Members(context.Context, string, string) ([]string, error) {
	panic("Create must not call Members")
}
func (personalRepository) Membership(context.Context, string, string) (bool, error) {
	panic("Create must not call Membership")
}

type usersFunc func(context.Context, string) (User, error)

func (f usersFunc) Lookup(ctx context.Context, id string) (User, error) { return f(ctx, id) }

func TestIDBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, raw, normalized string
		rpc                   bool
	}{
		{"canonical", ownerID, ownerID, true},
		{"REST uppercase", strings.ToUpper(ownerID), ownerID, false},
		{"zero remains a REST UUID", "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000", false},
		{"empty", "", "", false}, {"short", "bad", "", false},
		{"no trim", " " + ownerID, "", false},
		{"trailing newline", ownerID + "\n", "", false},
		{"missing hyphens", strings.ReplaceAll(ownerID, "-", ""), "", false},
		{"nonhex", "z" + ownerID[1:], "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeID(tc.raw)
			if got != tc.normalized || (err != nil) != (tc.normalized == "") {
				t.Fatalf("NormalizeID = %q, %v", got, err)
			}
			if err != nil && !errors.Is(err, ErrInvalid) {
				t.Fatal("unexpected validation error", err)
			}
			if ValidRPCID(tc.raw) != tc.rpc {
				t.Fatal("REST normalization must not weaken canonical RPC validation")
			}
		})
	}
}

func TestCreateValidatesBeforeDependencies(t *testing.T) {
	for _, tc := range []struct {
		name, owner, peer string
		want              error
	}{
		{"invalid identity first", "bad", "bad", ErrIdentity},
		{"invalid peer", ownerID, "bad", ErrInvalid},
		{"same user after normalization", ownerID, strings.ToUpper(ownerID), ErrInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Nil dependencies make any accidental lookup/write fail this test.
			out, created, err := (&Service{}).Create(t.Context(), tc.owner, tc.peer)
			if !errors.Is(err, tc.want) || created || !reflect.DeepEqual(out, Chat{}) {
				t.Fatal(out, created, err)
			}
		})
	}
}

func TestCreateResolvesUsersAndPreservesRepositoryResult(t *testing.T) {
	for _, created := range []bool{true, false} {
		for _, reverse := range []bool{false, true} {
			t.Run(fmt.Sprintf("created=%t/reverse=%t", created, reverse), func(t *testing.T) {
				owner, peer := ownerID, peerID
				if reverse {
					owner, peer = peer, owner
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				var calls []string
				want := Chat{ID: "10000000-0000-4000-8000-000000000001", Type: "personal", LastSeq: 17,
					CreatedAt: time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC),
					Members:   []User{{ID: ownerID, Username: "Alice_1"}, {ID: peerID, Username: "Bob_2"}}}
				s := Service{
					Users: usersFunc(func(got context.Context, id string) (User, error) {
						if got != ctx {
							t.Fatal("lookup lost request context")
						}
						calls = append(calls, "lookup:"+id)
						if id == ownerID {
							return want.Members[0], nil
						}
						if id == peerID {
							return want.Members[1], nil
						}
						t.Fatal("lookup received unexpected identity")
						return User{}, nil
					}),
					Repo: personalRepository{personal: func(got context.Context, a, b string) (Chat, bool, error) {
						if got != ctx || a != owner || b != peer {
							t.Fatal("wrong repository arguments")
						}
						calls = append(calls, "personal")
						stored := want
						stored.Members = nil
						return stored, created, nil
					}},
				}
				out, isNew, err := s.Create(ctx, strings.ToUpper(owner), strings.ToUpper(peer))
				if err != nil || isNew != created || !reflect.DeepEqual(out, want) {
					t.Fatal(out, isNew, err)
				}
				if !reflect.DeepEqual(calls, []string{"lookup:" + owner, "lookup:" + peer, "personal"}) {
					t.Fatal("must resolve both users before storage", calls)
				}
			})
		}
	}
}

func TestCreateDependencyFailuresDoNotCreatePartialChat(t *testing.T) {
	outage := errors.New("dependency failed")
	for _, tc := range []struct {
		name, stage   string
		failure, want error
	}{
		{"missing owner", "owner", fmt.Errorf("lookup: %w", ErrNotFound), ErrIdentity},
		{"owner unavailable", "owner", outage, outage},
		{"missing peer", "peer", ErrNotFound, ErrNotFound},
		{"peer unavailable", "peer", ErrUnavailable, ErrUnavailable},
		{"cancelled lookup", "owner", context.Canceled, context.Canceled},
		{"storage failure", "storage", outage, outage},
		{"storage deadline", "storage", context.DeadlineExceeded, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var lookups, writes int
			s := Service{
				Users: usersFunc(func(_ context.Context, id string) (User, error) {
					lookups++
					if (tc.stage == "owner" && id == ownerID) || (tc.stage == "peer" && id == peerID) {
						return User{}, tc.failure
					}
					return User{ID: id}, nil
				}),
				Repo: personalRepository{personal: func(context.Context, string, string) (Chat, bool, error) {
					writes++
					// A failed adapter result must not leak its partial projection.
					return Chat{ID: "partial"}, true, tc.failure
				}},
			}
			out, created, err := s.Create(t.Context(), ownerID, peerID)
			if !errors.Is(err, tc.want) || created || !reflect.DeepEqual(out, Chat{}) {
				t.Fatal("partial result escaped", out, created, err)
			}
			wantLookups, wantWrites := 2, 0
			if tc.stage == "owner" {
				wantLookups = 1
			}
			if tc.stage == "storage" {
				wantWrites = 1
			}
			if lookups != wantLookups || writes != wantWrites {
				t.Fatal(lookups, writes)
			}
		})
	}
}
