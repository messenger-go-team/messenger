package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/later"
)

func laterRoutes(mux *http.ServeMux, service *later.Service, verifier *jwtauth.Verifier) {
	handle := func(pattern string, next func(http.ResponseWriter, *http.Request, string) error) {
		mux.Handle(pattern, verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			// None of the Later routes declares query parameters. Check RawQuery
			// directly so unknown keys and malformed escapes cannot reach storage.
			if r.URL.RawQuery != "" {
				writeLaterError(w, r, later.ErrInvalid)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
			identity, _ := jwtauth.FromContext(ctx)
			if err := next(w, r, identity.UserID); err != nil {
				writeLaterError(w, r, err)
			}
		})))
	}
	handle("POST /later", func(w http.ResponseWriter, r *http.Request, owner string) error {
		fields, err := readLaterFields(w, r, "chat_id", "message_id", "due_at")
		if err != nil {
			return err
		}
		var chat, message string
		if json.Unmarshal(fields["chat_id"], &chat) != nil || json.Unmarshal(fields["message_id"], &message) != nil {
			return later.ErrInvalid
		}
		due, err := later.ParseDue(fields["due_at"])
		if err != nil {
			return err
		}
		out, created, err := service.Save(r.Context(), owner, chat, message, due)
		if err != nil {
			return err
		}
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeChatJSON(w, status, out)
		return nil
	})
	handle("GET /later", func(w http.ResponseWriter, r *http.Request, owner string) error {
		out, err := service.List(r.Context(), owner)
		if err != nil {
			return err
		}
		writeChatJSON(w, http.StatusOK, out)
		return nil
	})
	handle("PATCH /later/{later_id}", func(w http.ResponseWriter, r *http.Request, owner string) error {
		fields, err := readLaterFields(w, r, "due_at")
		if err != nil {
			return err
		}
		due, err := later.ParseDue(fields["due_at"])
		if err != nil {
			return err
		}
		out, err := service.Reschedule(r.Context(), owner, r.PathValue("later_id"), due)
		if err != nil {
			return err
		}
		writeChatJSON(w, http.StatusOK, out)
		return nil
	})
	handle("POST /later/{later_id}/done", func(w http.ResponseWriter, r *http.Request, owner string) error {
		// No request body is defined; reject it instead of accepting owner overrides.
		data, err := io.ReadAll(io.LimitReader(r.Body, 1))
		if err != nil || len(data) != 0 {
			return later.ErrInvalid
		}
		if err = service.Complete(r.Context(), owner, r.PathValue("later_id")); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
}

// Decode keys explicitly: struct decoding alone accepts duplicate keys, wrong
// capitalization and replacement characters for malformed UTF-8. Keep null due_at
// distinct from an omitted field, and bound allocation before parsing the object.
func readLaterFields(w http.ResponseWriter, r *http.Request, names ...string) (map[string]json.RawMessage, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, later.ErrInvalid
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || !utf8.Valid(body) {
		return nil, later.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, later.ErrInvalid
	}
	allowed := make(map[string]bool, len(names))
	for _, name := range names {
		allowed[name] = true
	}
	fields := make(map[string]json.RawMessage, len(names))
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, later.ErrInvalid
		}
		name, ok := key.(string)
		if !ok || !allowed[name] || fields[name] != nil {
			return nil, later.ErrInvalid
		}
		var raw json.RawMessage
		if err = d.Decode(&raw); err != nil {
			return nil, later.ErrInvalid
		}
		fields[name] = raw
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') || len(fields) != len(names) {
		return nil, later.ErrInvalid
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return nil, later.ErrInvalid
	}
	return fields, nil
}

func writeLaterError(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := http.StatusServiceUnavailable, "service_unavailable", "Сервис временно недоступен."
	switch {
	case errors.Is(err, later.ErrInvalid):
		status, code, message = 422, "validation_error", "Некорректный запрос."
	case errors.Is(err, later.ErrNotFound):
		status, code, message = 404, "not_found", "Сообщение недоступно."
	case errors.Is(err, chats.ErrIdentity):
		status, code, message = 401, "unauthorized", "Требуется действующий пользователь."
		w.Header().Set("WWW-Authenticate", "Bearer")
	default:
		// Do not log SQL parameters or expose why a private source is unavailable.
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "later operation failed")
	}
	writeChatJSON(w, status, map[string]string{"code": code, "message": message, "request_id": w.Header().Get("X-Request-ID")})
}
