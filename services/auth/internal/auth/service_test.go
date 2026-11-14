package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

type stubRepository struct {
	create  func(context.Context, string, string) (User, error)
	find    func(context.Context, string) (Account, error)
	session func(context.Context, string, string, time.Duration) error
	rotate  func(context.Context, string, string, time.Duration) (User, error)
	revoke  func(context.Context, string) error
}

func (r stubRepository) CreateUser(c context.Context, u, h string) (User, error) {
	return r.create(c, u, h)
}
func (r stubRepository) FindAccount(c context.Context, u string) (Account, error) {
	return r.find(c, u)
}
func (r stubRepository) CreateRefresh(c context.Context, u, h string, d time.Duration) error {
	return r.session(c, u, h, d)
}
func (r stubRepository) RotateRefresh(c context.Context, a, b string, d time.Duration) (User, error) {
	return r.rotate(c, a, b, d)
}
func (r stubRepository) RevokeRefresh(c context.Context, h string) error { return r.revoke(c, h) }

func TestServiceAuthentication(t *testing.T) {
	ctx := context.Background()
	const secret = "service-test-secret-at-least-32-bytes"
	const password = " 😀пароль длиннее семидесяти двух байтов 😀 "
	user := User{ID: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0", Username: "Alice_1", CreatedAt: time.Now().UTC()}
	var storedHash, sessionHash, previousHash string
	repo := stubRepository{
		create: func(_ context.Context, u, h string) (User, error) {
			if u != user.Username || !strings.HasPrefix(h, passwordPrefix) || strings.Contains(h, password) {
				t.Fatal("invalid password storage")
			}
			storedHash = h
			return user, nil
		},
		find: func(_ context.Context, u string) (Account, error) {
			if u == "unknown" {
				return Account{}, ErrUserNotFound
			}
			if u != "alice_1" {
				t.Fatal("lookup must be normalized")
			}
			return Account{User: user, PasswordHash: storedHash}, nil
		},
		session: func(_ context.Context, u, h string, ttl time.Duration) error {
			if u != user.ID || len(h) != 64 || ttl != RefreshLifetime {
				t.Fatal("invalid session storage")
			}
			sessionHash = h
			return nil
		},
		rotate: func(_ context.Context, previous, next string, ttl time.Duration) (User, error) {
			if previous != sessionHash || next == previous || ttl != RefreshLifetime {
				t.Fatal("invalid rotation")
			}
			previousHash, sessionHash = previous, next
			return user, nil
		},
		revoke: func(_ context.Context, h string) error {
			if h != sessionHash {
				t.Fatal("invalid logout hash")
			}
			return nil
		},
	}
	s, err := NewService(repo, secret)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.Register(ctx, user.Username, password)
	if err != nil || created != user {
		t.Fatalf("register: %v", err)
	}
	if sessionHash != "" {
		t.Fatal("registration must not start a session")
	}
	session, err := s.Login(ctx, "ALICE_1", password)
	if err != nil {
		t.Fatal(err)
	}
	check := func(session Session) {
		t.Helper()
		verifier, _ := jwtauth.New(secret)
		identity, err := verifier.Verify(session.Access.AccessToken)
		if err != nil || identity.UserID != user.ID || session.Access.TokenType != "Bearer" || session.Access.ExpiresIn != 900 {
			t.Fatal("JWT incompatible with shared verifier", err)
		}
		remaining := time.Until(identity.ExpiresAt)
		if remaining < 898*time.Second || remaining > 900*time.Second {
			t.Fatal("invalid JWT lifetime")
		}
		digest, err := HashRefresh(session.Refresh)
		if err != nil || digest != sessionHash {
			t.Fatal("raw refresh stored or invalid digest")
		}
		data, _ := json.Marshal(session)
		if strings.Contains(string(data), session.Refresh) {
			t.Fatal("refresh serialized into JSON")
		}
	}
	check(session)
	rotated, err := s.Refresh(ctx, session.Refresh)
	if err != nil {
		t.Fatal(err)
	}
	if previousHash == sessionHash {
		t.Fatal("refresh not rotated")
	}
	check(rotated)
	if err := s.Logout(ctx, rotated.Refresh); err != nil {
		t.Fatal(err)
	}
	for _, username := range []string{"alice_1", "unknown"} {
		if _, err := s.Login(ctx, username, "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("invalid login %s: %v", username, err)
		}
	}
	if _, err := s.Register(ctx, "bad-name", "short"); err == nil {
		t.Fatal("invalid registration accepted")
	}
	if _, err := s.Refresh(ctx, "invalid"); !errors.Is(err, ErrInvalidRefreshToken) {
		t.Fatal("invalid refresh accepted")
	}
	if err := s.Logout(ctx, "invalid"); !errors.Is(err, ErrInvalidRefreshToken) {
		t.Fatal("invalid logout accepted")
	}
}

func TestPasswordHashAndCancellation(t *testing.T) {
	p := passwords{slots: make(chan struct{}, 1)}
	ctx := context.Background()
	first, err := p.hash(ctx, "        ")
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.hash(ctx, "        ")
	if err != nil || first == second {
		t.Fatal("password salts must differ")
	}
	ok, err := p.compare(ctx, first, "        ")
	if err != nil || !ok {
		t.Fatal("password changed")
	}
	ok, err = p.compare(ctx, first, "       x")
	if err != nil || ok {
		t.Fatal("wrong password accepted")
	}
	for _, hash := range []string{"", strings.Replace(first, "m=65536", "m=999999999", 1), first + "$suffix", strings.Replace(first, "v=19", "v=16", 1)} {
		if _, err := p.compare(ctx, hash, "        "); err == nil {
			t.Fatal("invalid hash parameters accepted")
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	for range 10 {
		if _, err := p.hash(cancelled, "password"); !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled KDF started")
		}
	}
	if len(p.slots) != 0 {
		t.Fatal("cancelled request leaked KDF slot")
	}
	p.slots <- struct{}{}
	if _, err := p.compare(cancelled, first, "password"); !errors.Is(err, context.Canceled) {
		t.Fatal("KDF wait ignored cancellation")
	}
	<-p.slots
	if _, err := NewService(stubRepository{}, "short"); err == nil {
		t.Fatal("short secret accepted")
	}
}
