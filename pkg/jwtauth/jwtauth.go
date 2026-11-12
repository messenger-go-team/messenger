// Package jwtauth verifies the shared HS256 access JWT contract.
// It does not issue tokens or check resource-specific permissions.
package jwtauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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

// Read exact claim names and reject duplicates, including escaped spellings.
func (c *accessClaims) UnmarshalJSON(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return ErrInvalidToken
	}
	*c = accessClaims{}
	seen := make(map[string]bool)
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return ErrInvalidToken
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return ErrInvalidToken
		}
		seen[name] = true
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return ErrInvalidToken
		}
		switch name {
		case "sub":
			if err := json.Unmarshal(value, &c.Subject); err != nil {
				return ErrInvalidToken
			}
		case "iat", "exp", "nbf":
			date, err := parseNumericDate(value)
			if err != nil {
				return err
			}
			switch name {
			case "iat":
				c.IssuedAt = date
			case "exp":
				c.ExpiresAt = date
			case "nbf":
				c.NotBefore = date
			}
		}
	}
	if _, err := d.Token(); err != nil {
		return ErrInvalidToken
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrInvalidToken
	}
	return nil
}

// Convert decimal seconds exactly, without float64 or global TimePrecision.
// Round up to the next nanosecond: comparisons at time.Time resolution then
// preserve now < exp and now >= nbf/iat even for sub-nanosecond fractions.
func parseNumericDate(value json.RawMessage) (*jwt.NumericDate, error) {
	if len(value) == 0 || (value[0] != '-' && (value[0] < '0' || value[0] > '9')) || len(value) > 128 {
		return nil, ErrInvalidToken
	}
	// Bound exponents before big.Rat allocates powers of ten.
	if index := bytes.IndexAny(value, "eE"); index >= 0 {
		exponent, err := strconv.Atoi(string(value[index+1:]))
		if err != nil || exponent < -1000 || exponent > 1000 {
			return nil, ErrInvalidToken
		}
	}
	r, ok := new(big.Rat).SetString(string(value))
	if !ok {
		return nil, ErrInvalidToken
	}
	seconds, remainder := new(big.Int), new(big.Int)
	seconds.QuoRem(r.Num(), r.Denom(), remainder)
	if !seconds.IsInt64() || seconds.Int64() < -62135596800 || seconds.Int64() > 253402300799 {
		return nil, ErrInvalidToken
	}
	remainder.Mul(remainder, big.NewInt(1e9))
	nanos, fraction := new(big.Int), new(big.Int)
	nanos.QuoRem(remainder, r.Denom(), fraction)
	if fraction.Sign() > 0 {
		nanos.Add(nanos, big.NewInt(1))
	}
	date := time.Unix(seconds.Int64(), nanos.Int64()).UTC()
	if date.Year() < 1 || date.Year() > 9999 {
		return nil, ErrInvalidToken
	}
	return &jwt.NumericDate{Time: date}, nil
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
	if v == nil || v.parser == nil || len(v.key) < 32 || strings.ContainsFunc(raw, unicode.IsSpace) {
		return Identity{}, ErrInvalidToken
	}
	// A fourth part proves the token malformed. Do not allocate a slice entry
	// for every separator in an unauthenticated input.
	parts := strings.SplitN(raw, ".", 4)
	if len(parts) != 3 {
		return Identity{}, ErrInvalidToken
	}
	// encoding/json replaces invalid UTF-8 with U+FFFD. Reject the original
	// bytes before the JWT parser decodes either JSON segment.
	for _, segment := range parts[:2] {
		decoded, err := v.parser.DecodeSegment(segment)
		if err != nil || !utf8.Valid(decoded) {
			return Identity{}, ErrInvalidToken
		}
	}
	claims := &accessClaims{}
	token, err := v.parser.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		if _, present := token.Header["crit"]; present {
			return nil, ErrInvalidToken
		}
		if _, present := token.Header["b64"]; present {
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
