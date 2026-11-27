package main

import (
	"net/url"
	"testing"
	"time"
)

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
		if got := f.dropFrame(tc.viewer, frame(tc.kind, tc.chat, tc.client)); got != tc.drop {
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
