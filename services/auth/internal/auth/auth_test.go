package auth

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestValidateCredentials(t *testing.T) {
	for _, tc := range []struct {
		name, username, password, normalized string
		fields                               []string
	}{
		{"ASCII normalization", "Alice_1", "password", "alice_1", nil},
		{"minimum username", "A_1", "password", "a_1", nil},
		{"maximum username", strings.Repeat("A", 32), "password", strings.Repeat("a", 32), nil},
		{"unicode password", "alice", "😀😀😀😀😀😀😀😀", "alice", nil},
		{"password beyond 72 bytes", "alice", strings.Repeat("я", 100), "alice", nil},
		{"password whitespace preserved", "alice", "        ", "alice", nil},
		{"short username", "ab", "password", "", []string{"username"}},
		{"long username", strings.Repeat("a", 33), "password", "", []string{"username"}},
		{"username is not trimmed", " alice", "password", "", []string{"username"}},
		{"non ASCII username", "Алиса", "password", "", []string{"username"}},
		{"username punctuation", "alice-1", "password", "", []string{"username"}},
		{"short password", "alice", "1234567", "", []string{"password"}},
		{"password length is not bytes", "alice", "😀😀😀😀", "", []string{"password"}},
		{"invalid UTF8 password", "alice", "12345678" + string([]byte{0xff}), "", []string{"password"}},
		{"both invalid", "", "", "", []string{"username", "password"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, err := ValidateCredentials(tc.username, tc.password)
			if key != tc.normalized {
				t.Fatalf("lookup key = %q, want %q", key, tc.normalized)
			}
			if len(tc.fields) == 0 {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var validation *ValidationError
			if !errors.As(err, &validation) || len(validation.Details) != len(tc.fields) {
				t.Fatalf("validation error = %v", err)
			}
			for i, field := range tc.fields {
				if validation.Details[i].Field != field {
					t.Fatalf("unexpected details: %+v", validation.Details)
				}
			}
			if err.Error() != "invalid credentials payload" {
				t.Fatalf("error includes input: %v", err)
			}
		})
	}
}

func TestRefreshCredentials(t *testing.T) {
	raw, digest, err := GenerateRefresh()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 43 || len(digest) != 64 || strings.Contains(digest, raw) {
		t.Fatal("unexpected token/digest representation")
	}
	got, err := HashRefresh(raw)
	if err != nil || got != digest {
		t.Fatal("generated token does not match its digest")
	}
	other, otherDigest, err := GenerateRefresh()
	if err != nil || other == raw || otherDigest == digest {
		t.Fatal("independent tokens must differ")
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, raw[len(raw)-1])
	for name, invalid := range map[string]string{
		"empty": "", "short": raw[:42], "long": raw + "a", "padded": raw + "=",
		"newline": raw[:20] + "\n" + raw[21:], "space": " " + raw[1:],
		"noncanonical bits": raw[:42] + string(alphabet[last|1]),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := HashRefresh(invalid)
			if got != "" || !errors.Is(err, ErrInvalidRefreshToken) {
				t.Fatal("invalid token must return no digest and a safe error")
			}
		})
	}
}

func TestAccountJSONExcludesPasswordHash(t *testing.T) {
	account := Account{User: User{ID: "test-id", Username: "Alice_1"}, PasswordHash: "private-hash-marker"}
	data, err := json.Marshal(account)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "private-hash-marker") || strings.Contains(string(data), "PasswordHash") {
		t.Fatal("password hash leaked to JSON")
	}
}
