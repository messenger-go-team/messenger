package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestWSMessageSendRateLimitBeforeHistory(t *testing.T) {
	var saves, fanouts atomic.Int32
	history := startTestHistoryRPC(t, messageTestServer{
		membershipTestServer: membershipTestServer{members: func(_ context.Context, r *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			fanouts.Add(1)
			return &historyv1.GetChatMembersResponse{UserIds: []string{r.GetRequesterId()}}, nil
		}},
		save: func(context.Context, *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			return &historyv1.SaveMessageResponse{
				MessageId: newWSEventID(), Seq: int64(saves.Add(1)), CreatedAt: timestamppb.Now(),
			}, nil
		},
	})
	cfg := testConfig(t)
	cfg.SendInterval, cfg.SendBurst = time.Hour, 2
	ws, url := startTestWSEndpointWithConfig(t, cfg, defaultWSTiming(), history)
	alice, _ := dialTestUser(t, url, fanoutAlice)
	aliceTab, _ := dialTestUser(t, url, fanoutAlice)
	bob, _ := dialTestUser(t, url, fanoutBob)
	waitForConnections(t, ws, 3)

	sendAccepted := func(sender *websocket.Conn, recipients ...*websocket.Conn) {
		t.Helper()
		id, key := newWSEventID(), newWSEventID()
		sendTestMessage(t, sender, id, key, "accepted message")
		var ack wsAckPayload
		if got := readTestEvent(t, sender, "message.ack", &ack); got != id || ack.ClientMsgID != key {
			t.Fatalf("uncorrelated ack: %s %v", got, ack)
		}
		for _, conn := range recipients {
			var event wsNewPayload
			readTestEvent(t, conn, "message.new", &event)
			if event.wsAckPayload != ack {
				t.Fatalf("broadcast = %v, want %v", event.wsAckPayload, ack)
			}
		}
	}
	sendRejected := func(conn *websocket.Conn) {
		t.Helper()
		id := newWSEventID()
		sendTestMessage(t, conn, id, sendTestClientID, "rejected message")
		readTestSendError(t, conn, id, "rate_limited", true)
		if saves.Load() != 2 || fanouts.Load() != 2 {
			t.Fatalf("rejected command reached History: %d saves, %d fanout lookups", saves.Load(), fanouts.Load())
		}
	}

	invalidID := newWSEventID()
	sendTestMessage(t, alice, invalidID, sendTestClientID, " ")
	readTestSendError(t, alice, invalidID, "invalid_payload", false)
	sendAccepted(alice, alice, aliceTab)
	sendAccepted(aliceTab, alice, aliceTab)
	sendRejected(aliceTab)
	assertNoBroadcast(t, ws, fanoutAlice, alice)
	assertTextFrame(t, aliceTab, "{\"marker\":true}")

	_ = alice.Close()
	_ = aliceTab.Close()
	waitForConnections(t, ws, 1)
	reconnected, _ := dialTestUser(t, url, fanoutAlice)
	sendRejected(reconnected)
	sendAccepted(bob, bob)

	other, otherURL := startTestWSEndpointWithConfig(t, cfg, defaultWSTiming(), history)
	aliceOnOther, _ := dialTestUser(t, otherURL, fanoutAlice)
	waitForConnections(t, other, 1)
	sendAccepted(aliceOnOther, aliceOnOther)
	if saves.Load() != 4 || fanouts.Load() != 4 {
		t.Fatalf("want 4 accepted saves and fanout lookups, got %d and %d", saves.Load(), fanouts.Load())
	}

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url+"/metrics", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var samples []string
	for line := range strings.SplitSeq(string(data), "\n") {
		if strings.HasPrefix(line, "chat_ws_message_send_rejected_total") {
			samples = append(samples, line)
		}
	}
	const want = "chat_ws_message_send_rejected_total{reason=\"rate_limited\"} 2"
	if resp.StatusCode != http.StatusOK || len(samples) != 1 || samples[0] != want {
		t.Fatalf("metrics status %d, rejection samples %q, want %q", resp.StatusCode, samples, want)
	}
}
