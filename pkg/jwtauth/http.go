package jwtauth

import (
	"context"
	"net/http"
	"strings"
)

// Middleware authenticates exactly one Authorization: Bearer header. Credentials
// in query parameters and cookies are not accepted by this REST middleware.
// Mount it on protected routes; login, refresh and health routes stay public.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			unauthorized(w)
			return
		}
		scheme, raw, found := strings.Cut(values[0], " ")
		raw = strings.TrimLeft(raw, " ")
		if !found || !strings.EqualFold(scheme, "Bearer") || raw == "" {
			unauthorized(w)
			return
		}
		identity, err := v.Verify(raw)
		if err != nil {
			unauthorized(w)
			return
		}
		ctx := context.WithValue(r.Context(), identityKey{}, identity)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusUnauthorized)
	// Client disconnects do not change the authentication result. Do not log credentials.
	_, _ = w.Write([]byte("{\"code\":\"unauthorized\",\"message\":\"Требуется действующий access-токен.\"}\n"))
}
