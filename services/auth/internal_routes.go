package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/messenger-go-team/messenger/services/auth/internal/auth"
)

type userLookup interface {
	Lookup(context.Context, string) (auth.UserSummary, error)
}

func newInternalHandler(service userLookup, secret string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /internal/users/{user_id}", internalAuthorization(secret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := service.Lookup(r.Context(), r.PathValue("user_id"))
		if err != nil {
			writeAuthError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, user)
	})))
	return mux
}

func internalAuthorization(secret string, next http.Handler) http.Handler {
	configured := validateInternalToken(secret) == nil
	expected := sha256.Sum256([]byte(secret))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		values := r.Header.Values("Authorization")
		var raw string
		if len(values) == 1 {
			scheme, value, ok := strings.Cut(values[0], " ")
			if ok && strings.EqualFold(scheme, "Bearer") {
				raw = strings.TrimLeft(value, " ")
			}
		}
		actual := sha256.Sum256([]byte(raw))
		if !configured || raw == "" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSON(w, r, http.StatusUnauthorized, map[string]string{"code": "unauthorized", "message": "Требуется служебная авторизация.", "request_id": w.Header().Get("X-Request-ID")})
			return
		}
		next.ServeHTTP(w, r)
	})
}
