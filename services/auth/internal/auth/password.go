package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Fixed PHC parameters bound memory/CPU even if a stored hash is corrupted.
const passwordPrefix = "$argon2id$v=19$m=65536,t=3,p=2$"

// A service processes at most four memory-hard password operations at once.
// Waiting requests can be cancelled; an already running KDF must finish.
type passwords struct{ slots chan struct{} }

func (p *passwords) acquire(ctx context.Context) error {
	select {
	case p.slots <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-p.slots
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *passwords) hash(ctx context.Context, password string) (string, error) {
	if err := p.acquire(ctx); err != nil {
		return "", err
	}
	defer func() { <-p.slots }()
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt[:], 3, 65536, 2, 32)
	return passwordPrefix + base64.RawStdEncoding.EncodeToString(salt[:]) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

func (p *passwords) compare(ctx context.Context, hash, password string) (bool, error) {
	if !strings.HasPrefix(hash, passwordPrefix) {
		return false, errors.New("invalid stored password hash")
	}
	parts := strings.Split(strings.TrimPrefix(hash, passwordPrefix), "$")
	if len(parts) != 2 || len(parts[0]) != 22 || len(parts[1]) != 43 {
		return false, errors.New("invalid stored password hash")
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[0])
	if err != nil || len(salt) != 16 {
		return false, errors.New("invalid stored password hash")
	}
	expected, err := base64.RawStdEncoding.Strict().DecodeString(parts[1])
	if err != nil || len(expected) != 32 {
		return false, errors.New("invalid stored password hash")
	}
	if err := p.acquire(ctx); err != nil {
		return false, err
	}
	defer func() { <-p.slots }()
	key := argon2.IDKey([]byte(password), salt, 3, 65536, 2, 32)
	return subtle.ConstantTimeCompare(key, expected) == 1, nil
}
