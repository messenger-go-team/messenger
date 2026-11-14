package auth

import (
	"strings"
	"unicode/utf8"
)

// ValidateCredentials follows RegisterRequest/LoginRequest from auth OpenAPI.
// It returns the lookup key only after all checks pass. Passwords are never
// trimmed, normalized or capped at bcrypt's byte limit.
func ValidateCredentials(username, password string) (string, error) {
	var details []FieldError
	if !validUsername(username) {
		details = append(details, FieldError{Field: "username", Reason: "Длина 3–32 символа; допустимы латинские буквы, цифры и подчёркивание."})
	}
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 8 {
		details = append(details, FieldError{Field: "password", Reason: "Не менее 8 символов."})
	}
	if len(details) > 0 {
		return "", &ValidationError{Details: details}
	}
	return strings.ToLower(username), nil
}

func validUsername(value string) bool {
	if len(value) < 3 || len(value) > 32 {
		return false
	}
	for _, ch := range []byte(value) {
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9', ch == '_':
		default:
			return false
		}
	}
	return true
}
