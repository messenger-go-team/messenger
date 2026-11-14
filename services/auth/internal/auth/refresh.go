package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

const refreshEntropyBytes = 32

// GenerateRefresh creates an opaque cookie value and its database digest.
// The raw value is returned to the HTTP layer only for Set-Cookie.
func GenerateRefresh() (raw, digest string, err error) {
	var entropy [refreshEntropyBytes]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", "", err
	}
	raw = base64.RawURLEncoding.EncodeToString(entropy[:])
	return raw, refreshDigest(raw), nil
}

// HashRefresh checks the format issued by this service before hashing. Bound
// the input before decoding and reject CR/LF, padding and unused base64 bits.
func HashRefresh(raw string) (string, error) {
	if len(raw) != base64.RawURLEncoding.EncodedLen(refreshEntropyBytes) {
		return "", ErrInvalidRefreshToken
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || len(decoded) != refreshEntropyBytes || base64.RawURLEncoding.EncodeToString(decoded) != raw {
		return "", ErrInvalidRefreshToken
	}
	return refreshDigest(raw), nil
}

func refreshDigest(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}
