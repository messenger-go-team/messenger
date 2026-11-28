package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

func TestLaterFailureCountAndScope(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	f := &faults{rules: make(map[string]*rule)}
	arm := httptest.NewRecorder()
	f.control().ServeHTTP(arm, httptest.NewRequest(http.MethodPost,
		"/arm?kind=fail-later&user="+testViewer+"&seconds=45&count=2", nil))
	if arm.Code != http.StatusNoContent {
		t.Fatal(arm.Code, arm.Body.String())
	}

	handler := f.history(target)
	for _, tc := range []struct {
		method, path, subject string
		status                int
	}{
		{http.MethodGet, "/later", "", 401},
		{http.MethodGet, "/later", testClient, 200},
		{http.MethodPost, "/later", testViewer, 200},
		{http.MethodGet, "/later/item", testViewer, 200},
		{http.MethodGet, "/later", testViewer, 503},
		{http.MethodGet, "/later", testViewer, 503},
		{http.MethodGet, "/later", testViewer, 200},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.subject != "" {
			token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": tc.subject}).SignedString([]byte("qa-proxy-test"))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != tc.status {
			t.Fatalf("%+v: got %d (%s)", tc, recorder.Code, recorder.Body.String())
		}
		if tc.status == 503 && !strings.Contains(recorder.Body.String(), "service_unavailable") {
			t.Fatal(recorder.Body.String())
		}
	}
}

func TestHoldReleaseAndRepeatOnViewerSocket(t *testing.T) {
	f := &faults{rules: make(map[string]*rule)}
	arm := func(rule, client string) {
		t.Helper()
		r, err := expectedRule(url.Values{
			"kind": {rule}, "chat": {testChat}, "user": {testViewer},
			"seconds": {"45"}, "client": {client},
		})
		if err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.rules[rule] = r
		f.mu.Unlock()
	}
	arm("hold-new", testClient)
	arm("repeat-new", testChat)
	source, upstream := socketPair(t)
	viewer, downstream := socketPair(t)
	done := make(chan struct{}, 1)
	go f.relayToViewer(downstream, upstream, testViewer, done)

	first := `{"type":"message.new","payload":{"chat_id":"` + testChat + `","client_msg_id":"` + testClient + `"}}`
	second := `{"type":"message.new","payload":{"chat_id":"` + testChat + `","client_msg_id":"` + testChat + `"}}`
	for _, body := range []string{first, second} {
		if err := source.WriteMessage(websocket.TextMessage, []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := viewer.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	read := func(want string) {
		t.Helper()
		if _, data, err := viewer.ReadMessage(); err != nil || string(data) != want {
			t.Fatalf("got %q (%v), want %q", data, err, want)
		}
	}
	read(second)
	read(second)

	release := httptest.NewRecorder()
	f.control().ServeHTTP(release, httptest.NewRequest(http.MethodPost, "/release?kind=hold-new", nil))
	if release.Code != http.StatusNoContent {
		t.Fatal(release.Code)
	}
	read(first)

	replay := httptest.NewRecorder()
	f.control().ServeHTTP(replay, httptest.NewRequest(http.MethodPost, "/replay-new?user="+testViewer, strings.NewReader(first)))
	if replay.Code != http.StatusNoContent {
		t.Fatalf("Replay: %d %s", replay.Code, replay.Body.String())
	}
	read(first)
}

func socketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			t.Error(err)
		}
		accepted <- conn
	}))
	t.Cleanup(srv.Close)
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	server := <-accepted
	if server == nil {
		t.Fatal("upgrader returned no connection")
	}
	t.Cleanup(func() { _ = server.Close() })
	return client, server
}

const testChat = "f9288071-f7e6-4c8f-932c-08a2c76153f9"
const testViewer = "f9288071-f7e6-4c8f-932c-08a2c76153f0"
const testClient = "f9288071-f7e6-4c8f-932c-08a2c76153f1"

func TestDropFrameIsScopedToEventChatViewerAndClient(t *testing.T) {
	f := &faults{rules: map[string]*rule{"drop-ack": {
		Kind: "drop-ack", Chat: testChat, User: testViewer, Client: testClient, Until: time.Now().Add(time.Minute),
	}}}
	frame := func(kind, chat, client string) []byte {
		return []byte(`{"type":"` + kind + `","payload":{"chat_id":"` + chat + `","client_msg_id":"` + client + `"}}`)
	}
	for _, tc := range []struct {
		kind, chat, viewer, client string
		drop                       bool
	}{
		{"message.ack", testChat, testViewer, testClient, true},
		{"message.new", testChat, testViewer, testClient, false},
		{"message.ack", testChat, "another-viewer", testClient, false},
		{"message.ack", "another-chat", testViewer, testClient, false},
		{"message.ack", testChat, testViewer, "another-client", false},
	} {
		if got := f.dropFrame(tc.viewer, parseMessageEvent(frame(tc.kind, tc.chat, tc.client))); got != tc.drop {
			t.Errorf("scope %+v: drop=%v", tc, got)
		}
	}
}

func TestOneShotAndExpiry(t *testing.T) {
	r, err := expectedRule(url.Values{"kind": {"drop-read"}, "chat": {testChat}, "user": {testViewer}, "seconds": {"2"}})
	if err != nil {
		t.Fatal(err)
	}
	f := &faults{rules: map[string]*rule{r.Kind: r}}
	for _, want := range []bool{true, false} {
		if _, _, got := f.match(r.Kind, testChat, testViewer, "", true); got != want {
			t.Fatalf("one-shot matching: got %v, want %v", got, want)
		}
	}
	r.Until = time.Now().Add(-time.Second)
	if _, _, got := f.match(r.Kind, testChat, testViewer, "", false); got {
		t.Fatal("expired rule matched")
	}
}
