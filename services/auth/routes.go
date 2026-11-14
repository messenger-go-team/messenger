package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

const maxCredentialsBody = 1 << 20

type authentication interface {
	Register(context.Context, string, string) (auth.User, error)
	Login(context.Context, string, string) (auth.Session, error)
	Refresh(context.Context, string) (auth.Session, error)
	Logout(context.Context, string) error
}

type authAPI struct{ service authentication }

func newAuthHandler(ready *atomic.Bool, logger *slog.Logger, service authentication, checkReady func(context.Context) error) http.Handler {
	api := authAPI{service: service}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", api.register)
	mux.HandleFunc("POST /auth/login", api.login)
	mux.HandleFunc("POST /auth/refresh", api.refresh)
	mux.HandleFunc("POST /auth/logout", api.logout)
	application := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
	return newServiceHandlerWithReadiness(ready, logger, application, checkReady)
}

func (api authAPI) register(w http.ResponseWriter, r *http.Request) {
	username, password, err := readCredentials(r)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	user, err := api.service.Register(r.Context(), username, password)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusCreated, user)
}

func (api authAPI) login(w http.ResponseWriter, r *http.Request) {
	username, password, err := readCredentials(r)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	session, err := api.service.Login(r.Context(), username, password)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeSession(w, r, session)
}

func (api authAPI) refresh(w http.ResponseWriter, r *http.Request) {
	raw, err := refreshCookie(r)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	session, err := api.service.Refresh(r.Context(), raw)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	writeSession(w, r, session)
}

func (api authAPI) logout(w http.ResponseWriter, r *http.Request) {
	raw, err := refreshCookie(r)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	if err := api.service.Logout(r.Context(), raw); err != nil {
		writeAuthError(w, r, err)
		return
	}
	cookie := sessionCookie("")
	cookie.MaxAge = -1
	cookie.Expires = time.Unix(1, 0).UTC()
	http.SetCookie(w, cookie)
	w.WriteHeader(http.StatusNoContent)
}

func refreshCookie(r *http.Request) (string, error) {
	cookies := r.CookiesNamed("refresh_token")
	if len(cookies) != 1 {
		return "", auth.ErrInvalidRefreshToken
	}
	return cookies[0].Value, nil
}

func sessionCookie(raw string) *http.Cookie {
	return &http.Cookie{Name: "refresh_token", Value: raw, Path: "/auth", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
		MaxAge: int(auth.RefreshLifetime / time.Second), Expires: time.Now().UTC().Add(auth.RefreshLifetime)}
}

func writeSession(w http.ResponseWriter, r *http.Request, session auth.Session) {
	http.SetCookie(w, sessionCookie(session.Refresh))
	writeJSON(w, r, http.StatusOK, session.Access)
}

// Decode exact field names once, rejecting duplicates, unknown fields, invalid
// UTF-8 and trailing JSON. The request body is bounded before allocating it.
func readCredentials(r *http.Request) (string, string, error) {
	invalid := &auth.ValidationError{Details: []auth.FieldError{{Field: "body", Reason: "Ожидается JSON с полями username и password."}}}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return "", "", invalid
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCredentialsBody+1))
	if err != nil || len(body) > maxCredentialsBody || !utf8.Valid(body) {
		return "", "", invalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return "", "", invalid
	}
	fields := make(map[string]string, 2)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return "", "", invalid
		}
		name, ok := token.(string)
		if !ok || (name != "username" && name != "password") {
			return "", "", invalid
		}
		if _, exists := fields[name]; exists {
			return "", "", invalid
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil || len(value) == 0 || value[0] != '"' || !validSurrogateEscapes(value) {
			return "", "", invalid
		}
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return "", "", invalid
		}
		fields[name] = text
	}
	if _, err := d.Token(); err != nil {
		return "", "", invalid
	}
	if _, err := d.Token(); err != io.EOF || len(fields) != 2 {
		return "", "", invalid
	}
	return fields["username"], fields["password"], nil
}

// encoding/json accepts lone UTF-16 surrogates and silently replaces them
// with U+FFFD. Validate escapes before decoding so a password is never changed.
// raw is already a syntactically valid JSON string from Decoder.Decode.
func validSurrogateEscapes(raw []byte) bool {
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		} // Also consumes escaped backslashes and quotes.
		code, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		switch {
		case code >= 0xdc00 && code <= 0xdfff:
			return false
		case code >= 0xd800 && code <= 0xdbff:
			if i+6 >= len(raw)-1 || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func writeAuthError(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "Внутренняя ошибка сервера."
	var validation *auth.ValidationError
	response := map[string]any{"request_id": w.Header().Get("X-Request-ID")}
	switch {
	case errors.As(err, &validation):
		status, code, message = http.StatusUnprocessableEntity, "validation_error", "Запрос содержит некорректные поля."
		response["details"] = validation.Details
	case errors.Is(err, auth.ErrUsernameTaken):
		status, code, message = http.StatusConflict, "username_taken", "Username уже занят."
	case errors.Is(err, auth.ErrInvalidCredentials):
		status, code, message = http.StatusUnauthorized, "invalid_credentials", "Неверный username или пароль."
	case errors.Is(err, auth.ErrInvalidRefreshToken):
		status, code, message = http.StatusUnauthorized, "invalid_refresh_token", "Требуется действующий refresh-токен."
	default:
		// Do not serialize driver/credential errors even into server logs.
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "authentication operation failed")
	}
	response["code"], response["message"] = code, message
	writeJSON(w, r, status, response)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "write auth response failed")
	}
}
