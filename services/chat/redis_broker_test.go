package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRedisBrokerReadyDuringRoutineSubscriptionChanges(t *testing.T) {
	broker := &redisBroker{
		ctx:     t.Context(),
		desired: make(map[string]struct{}),
		wake:    make(chan struct{}, 1),
	}
	broker.publisherReady.Store(true)
	session := &redisSubscriptionState{heartbeatSeen: true}
	broker.confirmSubscriptionState(session)
	if !broker.Ready() {
		t.Fatal("healthy Redis session is unready")
	}

	for _, present := range []bool{true, false} {
		broker.SetLocalUser(fanoutAlice, present)
		if !broker.Ready() {
			t.Fatal("routine socket registration changed readiness before Redis failure")
		}
		// Redis has not yet acknowledged this generation.
		broker.confirmSubscriptionState(session)
		if !broker.Ready() {
			t.Fatal("routine subscription reconciliation changed readiness before Redis failure")
		}
	}
}

func TestRedisBrokerValidatesWireEvents(t *testing.T) {
	now := time.Now().UTC()
	data := func(kind string, payload any) []byte {
		t.Helper()
		frame, err := json.Marshal(wsEnvelope{Type: kind, ID: newWSEventID(), TS: now, Payload: payload})
		if err != nil {
			t.Fatal(err)
		}
		return frame
	}
	typing := wsTypingPayload{ChatID: fanoutChat, UserID: fanoutAlice, IsTyping: true, ExpiresAt: now}
	stopTyping := typing
	stopTyping.IsTyping = false
	caseCollision := strings.Replace(string(data(wsTypingType, stopTyping)), "\"type\":\"typing\"", "\"type\":\"presence\",\"Type\":\"typing\"", 1)
	valid := wsReceiptPayload{ChatID: fanoutChat, UserID: fanoutAlice, Seq: 0}
	for _, test := range []struct {
		name    string
		raw     []byte
		valid   bool
		expired bool
	}{
		{"initial cursor", data(wsDeliveredType, valid), true, false},
		{"missing cursor", data(wsDeliveredType, map[string]any{"chat_id": fanoutChat, "user_id": fanoutAlice}), false, false},
		{"private ack", data("message.ack", valid), false, false},
		{"reserved presence", data("presence", valid), false, false},
		{"type case collision", []byte(caseCollision), false, false},
		{"invalid JSON", []byte("{"), false, false},
		{"oversized", []byte(strings.Repeat("x", wsMaxMessageBytes+1)), false, false},
		{"expired typing", data(wsTypingType, typing), true, true},
		{"typing cancellation", data(wsTypingType, stopTyping), true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			valid, expired := inspectRedisEvent(test.raw, now)
			if valid != test.valid || expired != test.expired {
				t.Fatalf("(valid, expired) = (%v, %v), want (%v, %v)", valid, expired, test.valid, test.expired)
			}
		})
	}
}

func TestRedisBrokerRejectsCanceledPublication(t *testing.T) {
	broker := &redisBroker{ctx: t.Context(), publications: make(chan redisPublication, 1)}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := broker.Publish(ctx, []string{fanoutAlice}, []byte("test")); err != context.Canceled {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if len(broker.publications) != 0 {
		t.Fatal("canceled publication was enqueued")
	}
}
