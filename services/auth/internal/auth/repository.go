package auth

import (
	"context"
	"time"
)

// Repository operates exclusively on auth-owned tables. PostgreSQL must enforce
// username uniqueness; a check-then-insert in the service is insufficient.
type Repository interface {
	// CreateUser preserves username spelling and stores its ASCII lowercase
	// counterpart. A concurrent duplicate returns ErrUsernameTaken.
	// Registration never creates a refresh session.
	CreateUser(ctx context.Context, username, passwordHash string) (User, error)
	// FindAccount returns ErrUserNotFound when absent. The service must map it
	// to the same public error as a wrong password and still run a dummy hash
	// comparison to avoid a cheap username-existence timing distinction.
	FindAccount(ctx context.Context, normalizedUsername string) (Account, error)

	// Refresh methods receive hashes only, never the opaque client credentials.
	// ttl is applied using database time; expiry checks must also use database
	// time after acquiring the relevant row lock.
	CreateRefresh(ctx context.Context, userID, tokenHash string, ttl time.Duration) error

	// RotateRefresh consumes one unexpired, unrevoked token and inserts its
	// successor in one transaction. Exactly one concurrent caller may succeed.
	// Errors before commit must roll back revocation of the previous token.
	// If commit acknowledgement is lost, its outcome is unknown: do not claim
	// that the previous token remains valid or automatically retry its use.
	// Return ErrInvalidRefreshToken for missing, expired or revoked credentials.
	RotateRefresh(ctx context.Context, previousHash, nextHash string, ttl time.Duration) (User, error)

	// RevokeRefresh revokes only this live token. Missing, expired and already
	// revoked tokens return ErrInvalidRefreshToken (HTTP 401, including logout).
	// A concurrent rotation/logout must serialize on the previous token.
	RevokeRefresh(ctx context.Context, tokenHash string) error
}
