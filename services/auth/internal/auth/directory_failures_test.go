package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDirectoryDependencyErrorsAndContext(t *testing.T) {
	const owner = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
	const peer = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	outage := errors.New("directory storage unavailable")
	for _, operation := range []string{"me", "search", "contacts", "add", "remove", "lookup"} {
		for _, ownerFails := range []bool{false, true} {
			if ownerFails && (operation == "me" || operation == "lookup") {
				continue // These operations contain only the profile lookup.
			}
			stage := "/operation"
			if ownerFails {
				stage = "/owner"
			}
			t.Run(operation+stage, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				calls := 0
				check := func(got context.Context) {
					t.Helper()
					if got != ctx {
						t.Fatal("request context lost")
					}
				}
				repo := directoryStub{
					get: func(got context.Context, id string) (User, error) {
						check(got)
						calls++
						if id != owner {
							t.Fatal("wrong profile identity")
						}
						if ownerFails || operation == "me" || operation == "lookup" {
							return User{}, outage
						}
						return User{ID: owner}, nil
					},
					search: func(got context.Context, prefix string) ([]UserSummary, error) {
						check(got)
						calls++
						if prefix != "ali_" {
							t.Fatal("prefix changed")
						}
						return nil, outage
					},
					list: func(got context.Context, id string) ([]UserSummary, error) {
						check(got)
						calls++
						if id != owner {
							t.Fatal("wrong contact owner")
						}
						return nil, outage
					},
					add: func(got context.Context, a, b string) error {
						check(got)
						calls++
						if a != owner || b != peer {
							t.Fatal("wrong contact pair")
						}
						return outage
					},
					remove: func(got context.Context, a, b string) error {
						check(got)
						calls++
						if a != owner || b != peer {
							t.Fatal("wrong delete pair")
						}
						return outage
					},
				}
				d := NewDirectory(repo)
				var err error
				switch operation {
				case "me":
					_, err = d.Me(ctx, owner)
				case "search":
					_, err = d.Search(ctx, owner, "ALI_")
				case "contacts":
					_, err = d.Contacts(ctx, owner)
				case "add":
					err = d.AddContact(ctx, owner, strings.ToUpper(peer))
				case "remove":
					err = d.RemoveContact(ctx, owner, strings.ToUpper(peer))
				case "lookup":
					_, err = d.Lookup(ctx, strings.ToUpper(owner))
				}
				wantCalls := 2
				if ownerFails || operation == "me" || operation == "lookup" {
					wantCalls = 1
				}
				if !errors.Is(err, outage) || calls != wantCalls {
					t.Fatal("outage became missing identity or write continued", err, calls)
				}
			})
		}
	}
}
