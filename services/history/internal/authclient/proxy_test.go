package authclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

func TestLookupIgnoresEnvironmentProxy(t *testing.T) {
	const id = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
	const secret = "proxy-regression-service-credential-32-bytes"
	if os.Getenv("HISTORY_PROXY_TEST_CHILD") == "1" {
		ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
		defer cancel()
		_, err := New("http://auth.internal.invalid:8080", secret).Lookup(ctx, id)
		if !errors.Is(err, chats.ErrUnavailable) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("unreachable Auth must not accept a proxy-supplied user")
		}
		return
	}
	var calls, credentials atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer "+secret {
			credentials.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"` + id + `","username":"Alice_1"}`))
	}))
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLookupIgnoresEnvironmentProxy$", "-test.timeout=10s")
	// net/http caches proxy environment settings. A fresh process tests the
	// actual HTTP_PROXY boundary, independently of other tests and NO_PROXY.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUEST_METHOD", "HISTORY_PROXY_TEST_CHILD":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "HISTORY_PROXY_TEST_CHILD=1", "HTTP_PROXY="+proxy.URL, "HTTPS_PROXY="+proxy.URL, "NO_PROXY=", "no_proxy=")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Errorf("proxy regression child failed: %v\n%s", err, output)
	}
	if calls.Load() != 0 || credentials.Load() != 0 {
		t.Error("internal Auth request or credential reached an environment proxy")
	}
}
