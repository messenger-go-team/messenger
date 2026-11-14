package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type directoryStub struct {
	get    func(context.Context, string) (User, error)
	search func(context.Context, string) ([]UserSummary, error)
	list   func(context.Context, string) ([]UserSummary, error)
	add    func(context.Context, string, string) error
	remove func(context.Context, string, string) error
}

func (r directoryStub) GetUser(c context.Context, id string) (User, error) { return r.get(c, id) }
func (r directoryStub) SearchUsers(c context.Context, p string) ([]UserSummary, error) {
	return r.search(c, p)
}
func (r directoryStub) ListContacts(c context.Context, id string) ([]UserSummary, error) {
	return r.list(c, id)
}
func (r directoryStub) AddContact(c context.Context, a, b string) error    { return r.add(c, a, b) }
func (r directoryStub) RemoveContact(c context.Context, a, b string) error { return r.remove(c, a, b) }

func TestDirectoryValidationAndOwnership(t *testing.T) {
	ctx := context.Background()
	const owner = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
	const other = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	const missing = "00000000-0000-0000-0000-000000000001"
	var seenOwner, seenContact, seenPrefix string
	repo := directoryStub{
		get: func(_ context.Context, id string) (User, error) {
			if id == missing {
				return User{}, ErrUserNotFound
			}
			if id != owner {
				t.Fatal("owner is not the verified user")
			}
			return User{ID: owner, Username: "Alice_1"}, nil
		},
		search: func(_ context.Context, p string) ([]UserSummary, error) { seenPrefix = p; return []UserSummary{}, nil },
		list:   func(_ context.Context, id string) ([]UserSummary, error) { seenOwner = id; return []UserSummary{}, nil },
		add:    func(_ context.Context, a, b string) error { seenOwner, seenContact = a, b; return nil },
		remove: func(_ context.Context, a, b string) error { seenOwner, seenContact = a, b; return nil },
	}
	d := NewDirectory(repo)
	if _, err := d.Search(ctx, owner, "ALI_"); err != nil || seenPrefix != "ali_" {
		t.Fatal("prefix normalization failed", err)
	}
	for _, prefix := range []string{"", strings.Repeat("a", 33), "ali%", "ali?", "али", " ali", "a\nb", "a-b"} {
		_, err := d.Search(ctx, owner, prefix)
		var invalid *ValidationError
		if !errors.As(err, &invalid) {
			t.Fatalf("invalid prefix accepted: %q", prefix)
		}
	}
	for _, raw := range []string{"", "alice", strings.ReplaceAll(other, "-", ""), " " + other, other + "x"} {
		var invalid *ValidationError
		if !errors.As(d.AddContact(ctx, owner, raw), &invalid) {
			t.Fatal("invalid contact accepted")
		}
		if !errors.As(d.RemoveContact(ctx, owner, raw), &invalid) {
			t.Fatal("invalid delete UUID accepted")
		}
	}
	var invalid *ValidationError
	if !errors.As(d.AddContact(ctx, owner, strings.ToUpper(owner)), &invalid) {
		t.Fatal("case-variant self contact accepted")
	}
	if err := d.AddContact(ctx, owner, strings.ToUpper(other)); err != nil || seenOwner != owner || seenContact != other {
		t.Fatal("contact ownership/normalization failed", err)
	}
	if err := d.RemoveContact(ctx, owner, owner); err != nil || seenOwner != owner || seenContact != owner {
		t.Fatal("delete self should be allowed", err)
	}
	if _, err := d.Contacts(ctx, owner); err != nil || seenOwner != owner {
		t.Fatal("list ownership failed", err)
	}
	for _, call := range []func() error{
		func() error { _, err := d.Me(ctx, missing); return err }, func() error { _, err := d.Search(ctx, missing, "a"); return err },
		func() error { _, err := d.Contacts(ctx, missing); return err }, func() error { return d.AddContact(ctx, missing, other) }, func() error { return d.RemoveContact(ctx, missing, other) },
	} {
		if err := call(); !errors.Is(err, ErrInvalidIdentity) {
			t.Fatal("deleted identity accepted", err)
		}
	}
}
