package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func chatRoutes(service *chats.Service, verifier *jwtauth.Verifier, reader *reading.Service, saved *later.Service) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /chats/personal", verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		peer, err := readPeer(w, r)
		if err != nil {
			writeChatError(w, r, chats.ErrInvalid)
			return
		}
		identity, _ := jwtauth.FromContext(r.Context())
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		chat, created, err := service.Create(ctx, identity.UserID, peer)
		if err != nil {
			writeChatError(w, r, err)
			return
		}
		code := http.StatusOK
		if created {
			code = http.StatusCreated
		}
		writeChatJSON(w, code, chat)
	})))
	readingRoutes(mux, reader, verifier)
	laterRoutes(mux, saved, verifier)
	return mux
}
func readPeer(w http.ResponseWriter, r *http.Request) (string, error) {
	var id string
	err := readChatField(w, r, "user_id", &id)
	return id, err
}

// readChatField requires exactly one non-null field and a single JSON object.
func readChatField(w http.ResponseWriter, r *http.Request, name string, value any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return chats.ErrInvalid
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return chats.ErrInvalid
	}
	found := false
	for d.More() {
		key, err := d.Token()
		if err != nil || key != name || found {
			return chats.ErrInvalid
		}
		var raw json.RawMessage
		if err = d.Decode(&raw); err != nil || string(raw) == "null" {
			return chats.ErrInvalid
		}
		if err = json.Unmarshal(raw, value); err != nil {
			return chats.ErrInvalid
		}
		found = true
	}
	if _, err = d.Token(); err != nil || !found {
		return chats.ErrInvalid
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return chats.ErrInvalid
	}
	return nil
}
func writeChatJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeChatError(w http.ResponseWriter, r *http.Request, err error) {
	code, key, msg := http.StatusServiceUnavailable, "service_unavailable", "Сервис временно недоступен."
	switch {
	case errors.Is(err, chats.ErrInvalid):
		code, key, msg = 422, "validation_error", "Некорректный запрос."
	case errors.Is(err, chats.ErrIdentity):
		code, key, msg = 401, "unauthorized", "Требуется действующий пользователь."
		w.Header().Set("WWW-Authenticate", "Bearer")
	case errors.Is(err, chats.ErrNotFound):
		code, key, msg = 404, "not_found", "Пользователь не найден."
	default:
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "chat operation failed")
	}
	writeChatJSON(w, code, map[string]string{"code": key, "message": msg, "request_id": w.Header().Get("X-Request-ID")})
}
