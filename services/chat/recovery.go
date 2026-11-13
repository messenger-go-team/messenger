package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"runtime/debug"
)

// requestLogging must be outside recovery so the context has a request logger.
func recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state, tracked := trackResponse(w)
		requestID := w.Header().Get("X-Request-ID")
		defer func() {
			value := recover()
			if value == nil {
				return
			}
			if value == http.ErrAbortHandler {
				panic(value)
			}
			loggerFromContext(r.Context()).ErrorContext(r.Context(), "panic recovered",
				"panic", value, "stack", string(debug.Stack()))
			if state.hijacked != nil {
				// net/http no longer owns a hijacked connection.
				if err := state.hijacked.Close(); err != nil {
					loggerFromContext(r.Context()).ErrorContext(r.Context(), "close hijacked connection", "error", err)
				}
				panic(http.ErrAbortHandler)
			}
			if state.started {
				// Do not turn an already-started response into a successful partial one.
				panic(http.ErrAbortHandler)
			}
			writeInternalError(w, r, requestID)
		}()
		next.ServeHTTP(tracked, r)
	})
}

func writeInternalError(w http.ResponseWriter, r *http.Request, requestID string) {
	// Discard representation/framing headers prepared by the failed handler.
	for _, name := range []string{"Content-Length", "Content-Encoding", "Content-Range", "Trailer", "Transfer-Encoding"} {
		w.Header().Del(name)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-ID", requestID)
	w.WriteHeader(http.StatusInternalServerError)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"code": "internal_error", "message": "Внутренняя ошибка сервера.", "request_id": requestID,
	}); err != nil {
		loggerFromContext(r.Context()).ErrorContext(r.Context(), "write internal error", "error", err)
	}
}

type responseState struct {
	http.ResponseWriter
	started  bool
	hijacked net.Conn
}

func (w *responseState) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseState) WriteHeader(code int) {
	w.ResponseWriter.WriteHeader(code)
	// Informational responses allow a later final status; 101 is an exception.
	if code >= 200 || code == http.StatusSwitchingProtocols {
		w.started = true
	}
}

func (w *responseState) Write(body []byte) (int, error) {
	w.started = true // Write implicitly sends 200 when no final status was sent.
	return w.ResponseWriter.Write(body)
}

func (w *responseState) FlushError() error {
	previous := w.started
	w.started = true
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if errors.Is(err, http.ErrNotSupported) {
		w.started = previous
	}
	return err
}

type flushingResponse struct{ *responseState }

func (w flushingResponse) Flush() { _ = w.FlushError() }

type hijackingResponse struct{ *responseState }

func (w hijackingResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.hijacked = conn
	}
	return conn, buffer, err
}

type responseUnwrapper interface {
	Unwrap() http.ResponseWriter
}

func trackResponse(original http.ResponseWriter) (*responseState, http.ResponseWriter) {
	state := &responseState{ResponseWriter: original}
	var flush, hijack bool
	// Include capabilities reachable through transparent middleware wrappers.
	for current := original; ; {
		_, f := current.(http.Flusher)
		_, fe := current.(interface{ FlushError() error })
		_, h := current.(http.Hijacker)
		flush, hijack = flush || f || fe, hijack || h
		unwrapper, ok := current.(responseUnwrapper)
		if !ok {
			break
		}
		current = unwrapper.Unwrap()
	}
	switch {
	case flush && hijack:
		return state, struct {
			*responseState
			http.Flusher
			http.Hijacker
		}{state, flushingResponse{state}, hijackingResponse{state}}
	case flush:
		return state, struct {
			*responseState
			http.Flusher
		}{state, flushingResponse{state}}
	case hijack:
		return state, struct {
			*responseState
			http.Hijacker
		}{state, hijackingResponse{state}}
	default:
		return state, state
	}
}
