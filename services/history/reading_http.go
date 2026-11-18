package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

func readingRoutes(mux *http.ServeMux, service *reading.Service, verifier *jwtauth.Verifier) {
	handle := func(pattern string, next func(http.ResponseWriter, *http.Request, string) error) {
		mux.Handle(pattern, verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
			identity, _ := jwtauth.FromContext(ctx)
			if err := next(w, r, identity.UserID); err != nil {
				writeReadingError(w, r, err)
			}
		})))
	}
	handle("GET /chats", func(w http.ResponseWriter, r *http.Request, user string) error {
		items, err := service.List(r.Context(), user)
		if err != nil {
			return err
		}
		writeChatJSON(w, http.StatusOK, struct {
			Chats []reading.ChatItem `json:"chats"`
		}{items})
		return nil
	})
	handle("GET /chats/{chat_id}/messages", func(w http.ResponseWriter, r *http.Request, user string) error {
		q, err := readPageQuery(r.URL.RawQuery)
		if err != nil {
			return err
		}
		page, err := service.History(r.Context(), r.PathValue("chat_id"), user, q)
		if err != nil {
			return err
		}
		writeChatJSON(w, http.StatusOK, page)
		return nil
	})
	handle("GET /chats/{chat_id}/messages/{message_id}/context", func(w http.ResponseWriter, r *http.Request, user string) error {
		limit, err := readContextLimit(r.URL.RawQuery)
		if err != nil {
			return err
		}
		window, err := service.MessageContext(r.Context(), r.PathValue("chat_id"), user, r.PathValue("message_id"), limit)
		if err != nil {
			return err
		}
		writeChatJSON(w, http.StatusOK, window)
		return nil
	})
	handle("POST /chats/{chat_id}/read", func(w http.ResponseWriter, r *http.Request, user string) error {
		var seq int64
		if err := readChatField(w, r, "seq", &seq); err != nil {
			return chats.ErrInvalid
		}
		if err := service.MarkRead(r.Context(), r.PathValue("chat_id"), user, seq); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
}

func readPageQuery(raw string) (reading.Query, error) {
	q := reading.Query{Limit: 50}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return q, chats.ErrInvalid
	}
	for _, name := range []string{"before_seq", "after_seq", "limit"} {
		entries, ok := values[name]
		if !ok {
			continue
		}
		n, err := readQueryInteger(entries)
		if err != nil {
			return q, err
		}
		switch name {
		case "before_seq":
			q.Before = &n
		case "after_seq":
			q.After = &n
		case "limit":
			if n < 1 || n > 100 {
				return q, chats.ErrInvalid
			}
			q.Limit = int(n)
		}
	}
	return q, q.Validate()
}

func readContextLimit(raw string) (int, error) {
	if raw == "" {
		return 50, nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil || len(values) != 1 {
		return 0, chats.ErrInvalid
	}
	limit, err := readQueryInteger(values["limit"])
	if err != nil || limit < 1 || limit > 100 {
		return 0, chats.ErrInvalid
	}
	return int(limit), nil
}

func readQueryInteger(entries []string) (int64, error) {
	if len(entries) != 1 || entries[0] == "" {
		return 0, chats.ErrInvalid
	}
	for _, c := range entries[0] {
		if c < '0' || c > '9' {
			return 0, chats.ErrInvalid
		}
	}
	n, err := strconv.ParseInt(entries[0], 10, 64)
	if err != nil {
		return 0, chats.ErrInvalid
	}
	return n, nil
}

func writeReadingError(w http.ResponseWriter, r *http.Request, err error) {
	status, key, message := 503, "service_unavailable", "Сервис временно недоступен."
	switch {
	case errors.Is(err, chats.ErrInvalid):
		status, key, message = 422, "validation_error", "Некорректный запрос."
	case errors.Is(err, chats.ErrIdentity):
		status, key, message = 401, "unauthorized", "Требуется действующий пользователь."
		w.Header().Set("WWW-Authenticate", "Bearer")
	case errors.Is(err, chats.ErrForbidden):
		status, key, message = 403, "chat_membership_required", "Доступ разрешён только участникам чата."
	case errors.Is(err, reading.ErrMessageNotFound):
		status, key, message = 404, "not_found", "Сообщение недоступно."
	case errors.Is(err, chats.ErrNotFound):
		status, key, message = 404, "not_found", "Чат не найден."
	default:
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "history read operation failed")
	}
	writeChatJSON(w, status, map[string]string{"code": key, "message": message, "request_id": w.Header().Get("X-Request-ID")})
}
