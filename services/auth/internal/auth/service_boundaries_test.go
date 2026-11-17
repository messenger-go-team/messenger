package auth

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type fixedClock struct{ at time.Time }

func (c fixedClock) Now() time.Time { return c.at }

func TestAccessTokenUsesInjectedClock(t *testing.T) {
	const secret = "clock-test-signing-secret-at-least-32-bytes"
	s, err := NewService(stubRepository{}, secret)
	if err != nil {
		t.Fatal(err)
	}
	// Non-UTC and fractional seconds expose accidental local-time/rounding changes.
	at := time.Date(2024, 2, 29, 23, 59, 59, 987654321, time.FixedZone("device", 3*3600))
	s.clock = fixedClock{at: at}
	access, err := s.issue("8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0")
	if err != nil {
		t.Fatal(err)
	}
	var claims jwt.RegisteredClaims
	token, err := jwt.ParseWithClaims(access.AccessToken, &claims, func(token *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithTimeFunc(func() time.Time { return at }))
	issued := at.UTC().Truncate(time.Second)
	if err != nil || !token.Valid || claims.Subject != "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0" ||
		claims.IssuedAt == nil || !claims.IssuedAt.Equal(issued) ||
		claims.ExpiresAt == nil || !claims.ExpiresAt.Equal(issued.Add(AccessLifetime)) ||
		access.TokenType != "Bearer" || access.ExpiresIn != int(AccessLifetime/time.Second) {
		t.Fatal("JWT claims do not follow the injected clock", claims, access.ExpiresIn, err)
	}
	// Expiry is exclusive: exact exp must already be rejected, without sleeps.
	_, err = jwt.ParseWithClaims(access.AccessToken, &jwt.RegisteredClaims{}, func(*jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithTimeFunc(func() time.Time { return issued.Add(AccessLifetime) }))
	if !errors.Is(err, jwt.ErrTokenExpired) {
		t.Fatal("token valid at exp", err)
	}
}

func TestRegisterDependencyErrorsAndCancellation(t *testing.T) {
	s, err := NewService(stubRepository{}, "register-test-secret-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	for _, failure := range []error{ErrUsernameTaken, errors.New("storage unavailable")} {
		t.Run(failure.Error(), func(t *testing.T) {
			calls := 0
			s.repo = stubRepository{create: func(got context.Context, name, hash string) (User, error) {
				calls++
				if got != ctx || name != "Alice_1" || !strings.HasPrefix(hash, passwordPrefix) {
					t.Fatal("registration changed context, spelling, or password storage")
				}
				return User{}, failure
			}}
			if out, err := s.Register(ctx, "Alice_1", "password"); !errors.Is(err, failure) || out != (User{}) || calls != 1 {
				t.Fatal(out, err, calls)
			}
		})
	}
	// Nil callbacks prove validation/cancelled KDF cannot reach persistence.
	s.repo = stubRepository{}
	if _, err = s.Register(ctx, "invalid-name", "password"); err == nil {
		t.Fatal("invalid registration")
	}
	cancel()
	if out, err := s.Register(ctx, "Alice_1", "password"); !errors.Is(err, context.Canceled) || out != (User{}) {
		t.Fatal("cancelled hashing reached storage", out, err)
	}
}

func TestLoginDependencyFailureDoesNotReturnSession(t *testing.T) {
	s, err := NewService(stubRepository{}, "login-test-secret-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	hash, err := s.passwords.hash(ctx, "password")
	if err != nil {
		t.Fatal(err)
	}
	outage := errors.New("session storage unavailable")
	for _, stage := range []string{"find", "create refresh"} {
		t.Run(stage, func(t *testing.T) {
			var calls []string
			s.repo = stubRepository{
				find: func(got context.Context, name string) (Account, error) {
					calls = append(calls, "find")
					if got != ctx || name != "alice_1" {
						t.Fatal("wrong lookup boundary")
					}
					if stage == "find" {
						return Account{}, outage
					}
					return Account{User: User{ID: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"}, PasswordHash: hash}, nil
				},
				session: func(got context.Context, user, digest string, ttl time.Duration) error {
					calls = append(calls, "session")
					if got != ctx || user != "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0" || len(digest) != 64 || ttl != RefreshLifetime {
						t.Fatal("wrong refresh persistence arguments")
					}
					return outage
				},
			}
			out, err := s.Login(ctx, "ALICE_1", "password")
			want := []string{"find"}
			if stage != "find" {
				want = append(want, "session")
			}
			if !errors.Is(err, outage) || out != (Session{}) || !reflect.DeepEqual(calls, want) {
				t.Fatal("failed login exposed a usable session", out, err, calls)
			}
		})
	}
	s.repo = stubRepository{}
	if out, err := s.Login(ctx, "alice!", "password"); err == nil || out != (Session{}) {
		t.Fatal("invalid login reached dependencies")
	}
	// A cancelled password comparison must not create a refresh session.
	cancel()
	s.repo = stubRepository{find: func(got context.Context, _ string) (Account, error) {
		if got != ctx {
			t.Fatal("context replaced")
		}
		return Account{PasswordHash: hash}, nil
	}}
	if out, err := s.Login(ctx, "alice", "password"); !errors.Is(err, context.Canceled) || out != (Session{}) {
		t.Fatal(out, err)
	}
}

func TestRefreshAndLogoutRepositoryBoundaries(t *testing.T) {
	s, err := NewService(stubRepository{}, "refresh-test-secret-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	raw, oldDigest, err := GenerateRefresh()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	for i, failure := range []error{fmt.Errorf("rotation: %w", ErrInvalidRefreshToken), errors.New("database unavailable"), context.Canceled} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			rotations, revocations := 0, 0
			s.repo = stubRepository{
				rotate: func(got context.Context, old, next string, ttl time.Duration) (User, error) {
					rotations++
					if got != ctx || old != oldDigest || next == old || len(next) != 64 || ttl != RefreshLifetime {
						t.Fatal("rotation must receive digests and DB-relative TTL")
					}
					return User{}, failure
				},
				revoke: func(got context.Context, digest string) error {
					revocations++
					if got != ctx || digest != oldDigest {
						t.Fatal("logout received raw credential or wrong context")
					}
					return failure
				},
			}
			out, err := s.Refresh(ctx, raw)
			if !errors.Is(err, failure) || out != (Session{}) || rotations != 1 {
				t.Fatal(out, err, rotations)
			}
			if err = s.Logout(ctx, raw); !errors.Is(err, failure) || revocations != 1 {
				t.Fatal(err, revocations)
			}
		})
	}
	// Invalid cookie syntax is rejected before either repository operation.
	s.repo = stubRepository{}
	for _, invalid := range []string{"", raw + "=", raw[:42], raw[:20] + "\n" + raw[21:]} {
		if out, err := s.Refresh(ctx, invalid); !errors.Is(err, ErrInvalidRefreshToken) || out != (Session{}) {
			t.Fatal(out, err)
		}
		if err = s.Logout(ctx, invalid); !errors.Is(err, ErrInvalidRefreshToken) {
			t.Fatal(err)
		}
	}
}
