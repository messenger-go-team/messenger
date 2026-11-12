package jwtauth

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRejectMalformedSegments(t *testing.T) {
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	valid := signLiteralToken(`{"alg":"HS256"}`, fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100}`, testUserID))
	parts := strings.SplitN(valid, ".", 3)
	for name, raw := range map[string]string{
		"missing segment":         parts[0] + "." + parts[1],
		"empty header":            "." + parts[1] + "." + parts[2],
		"empty claims":            parts[0] + ".." + parts[2],
		"empty signature":         parts[0] + "." + parts[1] + ".",
		"extra signature segment": valid + ".extra",
		"trailing separator":      valid + ".",
		"leading separator":       "." + valid,
		"many separators":         strings.Repeat(".", 64<<10),
		"padded header":           parts[0] + "=." + parts[1] + "." + parts[2],
		"padded claims":           parts[0] + "." + parts[1] + "=." + parts[2],
		"padded signature":        valid + "=",
	} {
		t.Run(name, func(t *testing.T) {
			identity, err := v.Verify(raw)
			if !errors.Is(err, ErrInvalidToken) || identity != (Identity{}) {
				t.Fatalf("Verify = %+v, %v; want rejection", identity, err)
			}
		})
	}
}

func TestMalformedSegmentsAllocationBudget(t *testing.T) {
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	raw := strings.Repeat(".", 64<<10)
	result := testing.Benchmark(func(b *testing.B) {
		for b.Loop() {
			_, _ = v.Verify(raw)
		}
	})
	// Leave room for runtime/compiler variation, but fail if token separators
	// again cause a megabyte-sized allocation before signature verification.
	if bytes := result.AllocedBytesPerOp(); bytes > 4<<10 {
		t.Fatalf("malformed 64 KiB token allocated %d bytes/op; budget is 4 KiB", bytes)
	}
}

func TestRejectNoncanonicalSignature(t *testing.T) {
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	raw := signLiteralToken(`{"alg":"HS256"}`, fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100}`, testUserID))
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, raw[len(raw)-1])
	// HS256's final sextet contains two unused bits. Setting one produces the
	// same signature bytes with permissive decoding, but is not valid base64url.
	mutated := raw[:len(raw)-1] + string(alphabet[last|1])
	if _, err := v.Verify(raw); err != nil {
		t.Fatal(err)
	}
	if identity, err := v.Verify(mutated); err != ErrInvalidToken || identity != (Identity{}) {
		t.Fatalf("accepted noncanonical signature: %+v, %v", identity, err)
	}
}

func BenchmarkVerifyMalformedSegments(b *testing.B) {
	v, err := New(testSecret)
	if err != nil {
		b.Fatal(err)
	}
	for _, size := range []int{64, 64 << 10, 1 << 20} {
		b.Run(fmt.Sprintf("dots_%d", size), func(b *testing.B) {
			raw := strings.Repeat(".", size)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				identity, err := v.Verify(raw)
				if !errors.Is(err, ErrInvalidToken) || identity != (Identity{}) {
					b.Fatal("accepted malformed token")
				}
			}
		})
	}
}

func FuzzVerifyLiteralJSON(f *testing.F) {
	payload := fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100}`, testUserID)
	f.Add(`{"alg":"HS256"}`, payload)
	f.Add(`{"alg":"none"}`, payload)
	f.Add(`{"alg":"HS256","crit":null}`, payload)
	f.Add(`{"alg":"HS256","b64":false}`, payload)
	f.Add(`{"alg":"HS256","x":"`+string([]byte{0xff})+`"}`, payload)
	f.Add(`{"alg":"HS256"}`, `{"sub":null,"iat":1e1000,"exp":1e-1000}`)
	f.Add(`null`, `[]`)
	v := fixedVerifier(f, time.Unix(2000000000, 0))
	f.Fuzz(func(t *testing.T, header, claims string) {
		identity, err := v.Verify(signLiteralToken(header, claims))
		if err != nil {
			if err != ErrInvalidToken || identity != (Identity{}) {
				t.Fatalf("invalid token exposed identity or error details: %+v, %v", identity, err)
			}
			return
		}
		if identity.UserID == "" || identity.UserID != strings.ToLower(identity.UserID) || !uuidPattern.MatchString(identity.UserID) || identity.ExpiresAt.IsZero() {
			t.Fatalf("invalid verified identity: %+v", identity)
		}
	})
}
