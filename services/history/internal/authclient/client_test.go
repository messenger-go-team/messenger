package authclient

import (
	"context"
	"errors"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLookupTrustBoundary(t *testing.T) {
	const id = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	const key = "separate-service-credential-at-least-32-bytes"
	var redirectCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirectCalls.Add(1) }))
	defer target.Close()
	for _, tc := range []struct {
		status int
		body   string
		want   error
	}{
		{200, `{"id":"` + id + `","username":"Alice_1"}`, nil}, {404, ``, chats.ErrNotFound}, {401, ``, chats.ErrUnavailable}, {503, ``, chats.ErrUnavailable},
		{200, `{"id":"wrong","username":"Alice_1"}`, chats.ErrUnavailable}, {200, `{"id":"` + id + `","username":"Alice_1","password_hash":"secret"}`, chats.ErrUnavailable},
		{200, `{"id":"` + id + `","username":"Alice_1"} {}`, chats.ErrUnavailable}, {302, ``, chats.ErrUnavailable},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+key || r.URL.Path != "/internal/users/"+id {
				t.Error("incorrect service request")
			}
			if tc.status == 302 {
				w.Header().Set("Location", target.URL)
			}
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		client := New(server.URL, key)
		_, err := client.Lookup(t.Context(), id)
		server.Close()
		if !errors.Is(err, tc.want) {
			t.Fatalf("status=%d err=%v", tc.status, err)
		}
	}
	if redirectCalls.Load() != 0 {
		t.Fatal("credential-bearing redirect followed")
	}
}
func TestLookupCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := New(server.URL, "test").Lookup(ctx, "id")
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
