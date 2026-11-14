package jwtauth

import (
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "test-jwt-key-at-least-32-bytes-long"
const testUserID = "abcdef01-2345-4567-89ab-cdef01234567"

func signTestToken(t *testing.T, method jwt.SigningMethod, claims jwt.Claims, key any) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(method, claims).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func validTestClaims() jwt.MapClaims {
	now := time.Now().Unix()
	return jwt.MapClaims{"sub": testUserID, "iat": now - 60, "exp": now + 900}
}

func TestVerify(t *testing.T) {
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		modify func(jwt.MapClaims)
	}{
		{"valid", func(jwt.MapClaims) {}},
		{"upper case UUID", func(c jwt.MapClaims) { c["sub"] = strings.ToUpper(testUserID) }},
		{"other UUID version", func(c jwt.MapClaims) { c["sub"] = "abcdef01-2345-7567-89ab-cdef01234567" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := validTestClaims()
			tc.modify(claims)
			identity, err := v.Verify(signTestToken(t, jwt.SigningMethodHS256, claims, []byte(testSecret)))
			if err != nil {
				t.Fatal(err)
			}
			if identity.UserID != strings.ToLower(claims["sub"].(string)) || identity.ExpiresAt.Unix() != claims["exp"] {
				t.Fatalf("unexpected identity: %+v", identity)
			}
		})
	}
}

func TestRejectInvalidClaims(t *testing.T) {
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		modify func(jwt.MapClaims)
	}{
		{"missing sub", func(c jwt.MapClaims) { delete(c, "sub") }},
		{"empty sub", func(c jwt.MapClaims) { c["sub"] = "" }},
		{"non UUID sub", func(c jwt.MapClaims) { c["sub"] = "alice" }},
		{"nil UUID", func(c jwt.MapClaims) { c["sub"] = "00000000-0000-0000-0000-000000000000" }},
		{"UUID without hyphens", func(c jwt.MapClaims) { c["sub"] = strings.ReplaceAll(testUserID, "-", "") }},
		{"non string sub", func(c jwt.MapClaims) { c["sub"] = 42 }},
		{"missing exp", func(c jwt.MapClaims) { delete(c, "exp") }},
		{"null exp", func(c jwt.MapClaims) { c["exp"] = nil }},
		{"expired", func(c jwt.MapClaims) { c["exp"] = time.Now().Unix() - 1 }},
		{"expires now", func(c jwt.MapClaims) { c["exp"] = time.Now().Unix() }},
		{"invalid exp type", func(c jwt.MapClaims) { c["exp"] = true }},
		{"string exp", func(c jwt.MapClaims) { c["exp"] = strconv.FormatInt(time.Now().Unix()+900, 10) }},
		{"missing iat", func(c jwt.MapClaims) { delete(c, "iat") }},
		{"null iat", func(c jwt.MapClaims) { c["iat"] = nil }},
		{"invalid iat type", func(c jwt.MapClaims) { c["iat"] = []string{"invalid"} }},
		{"string iat", func(c jwt.MapClaims) { c["iat"] = strconv.FormatInt(time.Now().Unix()-60, 10) }},
		{"future iat", func(c jwt.MapClaims) { c["iat"] = time.Now().Unix() + 3600 }},
		{"future nbf", func(c jwt.MapClaims) { c["nbf"] = time.Now().Unix() + 3600 }},
		{"null nbf", func(c jwt.MapClaims) { c["nbf"] = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := validTestClaims()
			tc.modify(claims)
			identity, err := v.Verify(signTestToken(t, jwt.SigningMethodHS256, claims, []byte(testSecret)))
			if !errors.Is(err, ErrInvalidToken) || identity != (Identity{}) {
				t.Fatalf("Verify = %+v, %v; want no identity and ErrInvalidToken", identity, err)
			}
		})
	}
}

func TestRejectWrongSignatureOrAlgorithm(t *testing.T) {
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	valid := signTestToken(t, jwt.SigningMethodHS256, validTestClaims(), []byte(testSecret))
	parts := strings.Split(valid, ".")
	parts[1] = "eyJzdWIiOiJhdHRhY2tlciJ9"
	for name, raw := range map[string]string{
		"wrong key": signTestToken(t, jwt.SigningMethodHS256, validTestClaims(), []byte("another-secret-at-least-32-bytes-long")),
		"HS384":     signTestToken(t, jwt.SigningMethodHS384, validTestClaims(), []byte(testSecret)),
		"HS512":     signTestToken(t, jwt.SigningMethodHS512, validTestClaims(), []byte(testSecret)),
		"none":      signTestToken(t, jwt.SigningMethodNone, validTestClaims(), jwt.UnsafeAllowNoneSignatureType),
		"tampered":  strings.Join(parts, "."),
		"malformed": "not-a-token",
		"empty":     "",
		"prefixed":  "Bearer " + valid,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := v.Verify(raw); !errors.Is(err, ErrInvalidToken) {
				t.Fatalf("Verify error = %v, want ErrInvalidToken", err)
			}
		})
	}
}

func TestSecretConfiguration(t *testing.T) {
	for _, secret := range []string{"", "short-secret-marker", strings.Repeat("x", 31)} {
		if _, err := New(secret); err == nil || (secret != "" && strings.Contains(err.Error(), secret)) {
			t.Fatal("expected configuration error without secret value")
		}
	}
	for _, secret := range []string{strings.Repeat("x", 32), strings.Repeat("я", 16)} {
		if _, err := New(secret); err != nil {
			t.Fatal("secret length is measured in bytes:", err)
		}
	}
	t.Setenv(SecretEnv, testSecret)
	v, err := NewFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	raw := signTestToken(t, jwt.SigningMethodHS256, validTestClaims(), []byte(testSecret))
	if _, err := v.Verify(raw); err != nil {
		t.Fatal(err)
	}
	t.Setenv(SecretEnv, "")
	if _, err := NewFromEnv(); err == nil {
		t.Fatal("empty environment secret must fail")
	}
}

func TestZeroVerifierAndConcurrentVerification(t *testing.T) {
	var zero Verifier
	for _, v := range []*Verifier{nil, &zero} {
		if _, err := v.Verify("anything"); !errors.Is(err, ErrInvalidToken) {
			t.Fatal("unconfigured verifier must reject tokens")
		}
	}
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	raw := signTestToken(t, jwt.SigningMethodHS256, validTestClaims(), []byte(testSecret))
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			if identity, err := v.Verify(raw); err != nil || identity.UserID != testUserID {
				t.Errorf("concurrent Verify = %+v, %v", identity, err)
			}
		})
	}
	wg.Wait()
}
