package jwtauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Sign literal JSON so duplicate members survive construction of the token.
func signLiteralToken(header, payload string) string {
	encode := base64.RawURLEncoding.EncodeToString
	unsigned := encode([]byte(header)) + "." + encode([]byte(payload))
	mac := hmac.New(sha256.New, []byte(testSecret))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + encode(mac.Sum(nil))
}

func fixedVerifier(t *testing.T, now time.Time) *Verifier {
	t.Helper()
	v, err := New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	v.parser = jwt.NewParser(jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithStrictDecoding(),
		jwt.WithTimeFunc(func() time.Time { return now }))
	return v
}

func TestExactClaimNamesAndDuplicates(t *testing.T) {
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	const other = "12345678-1234-4234-8234-123456789abc"
	for _, tc := range []struct {
		name, payload string
		valid         bool
	}{
		{"uppercase only", fmt.Sprintf(`{"SUB":%q,"IAT":1999999999,"EXP":2000000100}`, testUserID), false},
		{"uppercase cannot override", fmt.Sprintf(`{"sub":%q,"SUB":%q,"iat":1999999999,"exp":2000000100}`, testUserID, other), true},
		{"uppercase before exact", fmt.Sprintf(`{"SUB":%q,"sub":%q,"iat":1999999999,"exp":2000000100}`, other, testUserID), true},
		{"uppercase iat", fmt.Sprintf(`{"sub":%q,"IAT":1999999999,"exp":2000000100}`, testUserID), false},
		{"uppercase exp", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"EXP":2000000100}`, testUserID), false},
		{"uppercase dates cannot override", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"IAT":2000000100,"exp":2000000100,"EXP":1999999999,"NBF":2000000100}`, testUserID), true},
		{"sub then null", fmt.Sprintf(`{"sub":%q,"sub":null,"iat":1999999999,"exp":2000000100}`, testUserID), false},
		{"null then sub", fmt.Sprintf(`{"sub":null,"sub":%q,"iat":1999999999,"exp":2000000100}`, testUserID), false},
		{"escaped duplicate", fmt.Sprintf(`{"sub":%q,"s\u0075b":%q,"iat":1999999999,"exp":2000000100}`, testUserID, other), false},
		{"duplicate iat", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"iat":1999999998,"exp":2000000100}`, testUserID), false},
		{"duplicate exp", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100,"exp":null}`, testUserID), false},
		{"duplicate nbf", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100,"nbf":1999999998,"nbf":null}`, testUserID), false},
		{"duplicate unknown", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100,"x":1,"x":2}`, testUserID), false},
		{"null payload", `null`, false},
		{"array payload", `[]`, false},
		{"trailing JSON", fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100} {}`, testUserID), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			identity, err := v.Verify(signLiteralToken(`{"alg":"HS256"}`, tc.payload))
			if tc.valid {
				if err != nil || identity.UserID != testUserID {
					t.Fatalf("Verify = %+v, %v", identity, err)
				}
			} else if !errors.Is(err, ErrInvalidToken) || identity != (Identity{}) {
				t.Fatalf("Verify = %+v, %v; want rejection", identity, err)
			}
		})
	}
}

func TestFractionalDateBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, dates string
		nanos       int64
		valid       bool
	}{
		{"nbf before", `"iat":1999999999,"nbf":2000000000.75,"exp":2000000100`, 749999999, false},
		{"nbf equal", `"iat":1999999999,"nbf":2000000000.75,"exp":2000000100`, 750000000, true},
		{"iat before", `"iat":2000000000.75,"exp":2000000100`, 749999999, false},
		{"iat equal", `"iat":2000000000.75,"exp":2000000100`, 750000000, true},
		{"exp before", `"iat":1999999999,"exp":2000000000.75`, 749999999, true},
		{"exp equal", `"iat":1999999999,"exp":2000000000.75`, 750000000, false},
		{"exp after", `"iat":1999999999,"exp":2000000000.75`, 750000001, false},
		{"nanosecond before expiry", `"iat":1999999999,"exp":2000000000.000000001`, 0, true},
		{"nanosecond at expiry", `"iat":1999999999,"exp":2000000000.000000001`, 1, false},
		{"subnanosecond before expiry", `"iat":1999999999,"exp":2000000000.0000000001`, 0, true},
		{"subnanosecond after expiry", `"iat":1999999999,"exp":2000000000.0000000001`, 1, false},
		{"subnanosecond nbf before", `"iat":1999999999,"nbf":2000000000.0000000001,"exp":2000000100`, 0, false},
		{"subnanosecond nbf after", `"iat":1999999999,"nbf":2000000000.0000000001,"exp":2000000100`, 1, true},
		{"exponent", `"iat":1999999999,"exp":2.00000000075e9`, 749999999, true},
		{"exp after iat in same second", `"iat":2000000000.25,"exp":2000000000.75`, 500000000, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := fixedVerifier(t, time.Unix(2000000000, tc.nanos))
			raw := signLiteralToken(`{"alg":"HS256"}`, fmt.Sprintf(`{"sub":%q,%s}`, testUserID, tc.dates))
			identity, err := v.Verify(raw)
			if tc.valid {
				if err != nil || identity.UserID != testUserID {
					t.Fatalf("Verify = %+v, %v", identity, err)
				}
			} else if !errors.Is(err, ErrInvalidToken) || identity != (Identity{}) {
				t.Fatalf("Verify = %+v, %v; want rejection", identity, err)
			}
		})
	}
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	raw := signLiteralToken(`{"alg":"HS256"}`, fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000000.123456789}`, testUserID))
	identity, err := v.Verify(raw)
	if err != nil || !identity.ExpiresAt.Equal(time.Unix(2000000000, 123456789)) {
		t.Fatalf("fractional ExpiresAt = %v, %v", identity.ExpiresAt, err)
	}
}

func TestRejectCriticalExtensionsAndWhitespace(t *testing.T) {
	v := fixedVerifier(t, time.Unix(2000000000, 0))
	payload := fmt.Sprintf(`{"sub":%q,"iat":1999999999,"exp":2000000100}`, testUserID)
	for _, header := range []string{
		`{"alg":"HS256","crit":["ext"],"ext":true}`,
		`{"alg":"HS256","crit":[]}`,
		`{"alg":"HS256","crit":null}`,
		`{"alg":"HS256","crit":"ext"}`,
	} {
		if _, err := v.Verify(signLiteralToken(header, payload)); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("accepted critical header %s", header)
		}
	}
	valid := signLiteralToken(`{"alg":"HS256"}`, payload)
	for _, whitespace := range []string{"\r", "\n", "\r\n", " ", "\t", "\v", "\f", "\u00a0"} {
		for _, raw := range []string{whitespace + valid, valid + whitespace, strings.ReplaceAll(valid, ".", whitespace+".")} {
			if _, err := v.Verify(raw); !errors.Is(err, ErrInvalidToken) {
				t.Fatalf("accepted whitespace %q", whitespace)
			}
		}
	}
}

func TestNumericDatePrecisionAndLimits(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  time.Time
	}{
		{"-0.25", time.Unix(-1, 750000000)},
		{"-0.0000000001", time.Unix(0, 0)},
		{"0e1000", time.Unix(0, 0)},
		{"1e-1000", time.Unix(0, 1)},
	} {
		got, err := parseNumericDate([]byte(tc.value))
		if err != nil || !got.Equal(tc.want) {
			t.Fatalf("parseNumericDate(%s) = %v, %v", tc.value, got, err)
		}
	}
	for _, value := range []string{`"1"`, `null`, `true`, `[]`, `1e1001`, `0e999999999999999999999`, `1e-1001`, `253402300800`, `-62135596801`, strings.Repeat("1", 129)} {
		if _, err := parseNumericDate([]byte(value)); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("accepted invalid date %s", value)
		}
	}
}
