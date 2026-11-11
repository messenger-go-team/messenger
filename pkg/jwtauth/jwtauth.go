// Package jwtauth verifies the shared HS256 access JWT contract.
// It does not issue tokens or check resource-specific permissions.
package jwtauth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const SecretEnv = "JWT_SECRET"

// ErrInvalidToken deliberately hides parsing, signature and claim details.
var ErrInvalidToken = errors.New("invalid access token")

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type identityKey struct{}

// Identity contains only verified data. ExpiresAt also lets a WebSocket service
// limit the lifetime of its authenticated connection to the token's expiry.
type Identity struct {
	UserID    string
	ExpiresAt time.Time
}

// Verifier is immutable after construction and may be shared between requests.
// Its zero value rejects all tokens; construct it with New or NewFromEnv.
type Verifier struct {
	key    []byte
	parser *jwt.Parser
}

// New constructs a verifier using the literal secret bytes, without trimming
// or decoding. No default key or non-HS256 signing method is accepted.
func New(secret string) (*Verifier, error) {
	if len(secret) < 32 {
		return nil, errors.New("JWT_SECRET must contain at least 32 bytes")
	}
	return &Verifier{
		key: []byte(secret),
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
			jwt.WithExpirationRequired(),
			jwt.WithIssuedAt(),
			jwt.WithStrictDecoding(),
		),
	}, nil
}

// NewFromEnv loads JWT_SECRET from the process environment. It never reads .env
// files, logs the key or falls back to a built-in development secret.
func NewFromEnv() (*Verifier, error) {
	return New(os.Getenv(SecretEnv))
}

type accessClaims struct {
	jwt.RegisteredClaims
}

// NumericDate accepts quoted numbers in the dependency. The JWT contract uses
// JSON numbers, so reject strings/null/other types before decoding the claims.
func (c *accessClaims) UnmarshalJSON(data []byte) error {
	var dates struct {
		Exp json.RawMessage `json:"exp"`
		Iat json.RawMessage `json:"iat"`
		Nbf json.RawMessage `json:"nbf"`
	}
	if err := json.Unmarshal(data, &dates); err != nil {
		return ErrInvalidToken
	}
	for _, value := range []json.RawMessage{dates.Exp, dates.Iat, dates.Nbf} {
		if len(value) > 0 && value[0] != '-' && (value[0] < '0' || value[0] > '9') {
			return ErrInvalidToken
		}
	}
	return json.Unmarshal(data, &c.RegisteredClaims)
}

// Validate complements the library's signature, exp, iat and optional nbf checks.
// WithIssuedAt validates a present iat but does not make the claim mandatory.
func (c accessClaims) Validate() error {
	if c.IssuedAt == nil || c.ExpiresAt == nil || !uuidPattern.MatchString(c.Subject) ||
		c.Subject == "00000000-0000-0000-0000-000000000000" ||
		!c.ExpiresAt.After(c.IssuedAt.Time) {
		return ErrInvalidToken
	}
	return nil
}

// Verify checks a compact JWT and returns a canonical lower-case user UUID.
// Expiry is strict (no leeway). It does not accept a "Bearer " prefix.
func (v *Verifier) Verify(raw string) (Identity, error) {
	if v == nil || v.parser == nil || len(v.key) < 32 {
		return Identity{}, ErrInvalidToken
	}
	claims := &accessClaims{}
	token, err := v.parser.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return v.key, nil
	})
	if err != nil || token == nil || !token.Valid {
		return Identity{}, ErrInvalidToken
	}
	return Identity{UserID: strings.ToLower(claims.Subject), ExpiresAt: claims.ExpiresAt.Time}, nil
}

// FromContext returns the identity installed by Middleware after verification.
func FromContext(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityKey{}).(Identity)
	return identity, ok
}
