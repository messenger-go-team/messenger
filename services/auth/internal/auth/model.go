// Package auth defines the authentication domain for the auth service.
// HTTP endpoints and PostgreSQL adapters are implemented separately.
package auth

import (
	"errors"
	"time"
)

const (
	AccessLifetime  = 900 * time.Second
	RefreshLifetime = 30 * 24 * time.Hour
)

var (
	ErrUsernameTaken       = errors.New("username is already taken")
	ErrUserNotFound        = errors.New("user not found")
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrInvalidRefreshToken = errors.New("invalid refresh token")
)

// User contains only the public profile returned by registration.
type User struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"created_at"`
}

// Account is repository data; PasswordHash must never reach an API response.
type Account struct {
	User
	PasswordHash string `json:"-"`
}

type FieldError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

type ValidationError struct {
	Details []FieldError
}

// Error deliberately excludes supplied usernames, passwords and tokens.
func (*ValidationError) Error() string { return "invalid credentials payload" }
