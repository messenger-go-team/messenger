package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The proxy speaks Redis's request framing only to hold a command at an exact
// boundary. Replies and Pub/Sub pushes are forwarded unchanged.
type redisTestProxy struct {
	listener net.Listener
	target   string
	mu       sync.Mutex
	online   bool
	tunnels  map[*redisTestTunnel]struct{}
	gate     *redisTestCommandGate
	workers  sync.WaitGroup
}

type redisTestTunnel struct {
	front net.Conn
	back  net.Conn
	done  chan struct{}
}

type redisTestCommandGate struct {
	command string
	channel string
	started chan struct{}
	release chan struct{}
	began   sync.Once
	resumed sync.Once
}

func (g *redisTestCommandGate) unblock() {
	g.resumed.Do(func() { close(g.release) })
}

func startRedisTestProxy(t *testing.T, target string) *redisTestProxy {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &redisTestProxy{listener: listener, target: target, online: true, tunnels: make(map[*redisTestTunnel]struct{})}
	p.workers.Go(func() {
		for {
			front, err := listener.Accept()
			if err != nil {
				return
			}
			p.workers.Go(func() { p.forward(front) })
		}
	})
	t.Cleanup(func() {
		_ = listener.Close()
		p.setOnline(false)
		p.workers.Wait()
	})
	return p
}

func (p *redisTestProxy) setOnline(online bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.online = online
	if !online {
		for tunnel := range p.tunnels {
			_ = tunnel.back.Close()
			_ = tunnel.front.Close()
		}
	}
}

func (p *redisTestProxy) holdCommand(t *testing.T, command, channel string) *redisTestCommandGate {
	t.Helper()
	gate := &redisTestCommandGate{command: command, channel: channel, started: make(chan struct{}), release: make(chan struct{})}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gate = gate
	t.Cleanup(gate.unblock)
	return gate
}

func (p *redisTestProxy) forward(front net.Conn) {
	defer func() { _ = front.Close() }()
	back, err := net.DialTimeout("tcp", p.target, time.Second)
	if err != nil {
		return
	}
	defer func() { _ = back.Close() }()

	tunnel := &redisTestTunnel{front: front, back: back, done: make(chan struct{})}
	p.mu.Lock()
	if !p.online {
		p.mu.Unlock()
		return
	}
	p.tunnels[tunnel] = struct{}{}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.tunnels, tunnel)
		p.mu.Unlock()
	}()

	go func() {
		_, _ = io.Copy(front, back)
		_ = front.Close()
		close(tunnel.done)
	}()
	defer func() {
		_ = back.Close()
		<-tunnel.done
	}()

	reader := bufio.NewReader(front)
	for {
		command, channel, raw, err := readRedisTestRequest(reader)
		if err != nil {
			return
		}
		p.mu.Lock()
		gate := p.gate
		p.mu.Unlock()
		if gate != nil && strings.EqualFold(command, gate.command) && channel == gate.channel {
			gate.began.Do(func() { close(gate.started) })
			select {
			case <-gate.release:
			case <-tunnel.done:
				return
			}
		}
		if _, err := back.Write(raw); err != nil {
			return
		}
	}
}

func readRedisTestRequest(reader *bufio.Reader) (command, channel string, raw []byte, err error) {
	header, err := reader.ReadString('\n')
	if err != nil {
		return "", "", nil, err
	}
	count, err := redisTestFrameSize(header, '*', 65536)
	if err != nil {
		return "", "", nil, err
	}
	var request bytes.Buffer
	request.WriteString(header)
	for i := range count {
		header, err = reader.ReadString('\n')
		if err != nil {
			return "", "", nil, err
		}
		size, err := redisTestFrameSize(header, '$', 2*wsMaxMessageBytes)
		if err != nil {
			return "", "", nil, err
		}
		field := make([]byte, size+2)
		if _, err := io.ReadFull(reader, field); err != nil {
			return "", "", nil, err
		}
		switch i {
		case 0:
			command = string(field[:size])
		case 1:
			channel = string(field[:size])
		}
		request.WriteString(header)
		request.Write(field)
	}
	return command, channel, request.Bytes(), nil
}

func redisTestFrameSize(header string, kind byte, maxSize int) (int, error) {
	if len(header) < 4 || header[0] != kind || !strings.HasSuffix(header, "\r\n") {
		return 0, fmt.Errorf("invalid Redis request frame")
	}
	n, err := strconv.Atoi(header[1 : len(header)-2])
	if err != nil || n < 0 || n > maxSize {
		return 0, fmt.Errorf("invalid Redis request frame size")
	}
	return n, nil
}

func redisIntegrationClient(t *testing.T) (string, *redis.Client) {
	t.Helper()
	redisURL := os.Getenv("CHAT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("set CHAT_TEST_REDIS_URL to run the real Redis integration tests")
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil || !strings.HasPrefix(redisURL, "redis://") {
		t.Fatal("CHAT_TEST_REDIS_URL must be a plain TCP redis:// URL for the integration proxy")
	}
	client := redis.NewClient(options)
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("Redis test fixture is not ready: %v", err)
	}
	return redisURL, client
}

func (p *redisTestProxy) redisURL(t *testing.T, upstream string) string {
	t.Helper()
	parsed, err := url.Parse(upstream)
	if err != nil {
		t.Fatal("invalid CHAT_TEST_REDIS_URL")
	}
	parsed.Host = p.listener.Addr().String()
	return parsed.String()
}

func startRedisTestReplica(t *testing.T, redisURL, prefix string, history historyv1.HistoryServiceClient) (*wsEndpoint, *redisBroker, string) {
	t.Helper()
	cfg := testConfig(t)
	var ready atomic.Bool
	ready.Store(true)
	logger := newLogger(io.Discard, "chat", cfg.LogLevel)
	ws := newWSEndpoint(cfg, &ready, defaultWSTiming(), history, logger)
	broker, err := newRedisBroker(redisBrokerConfig{URL: redisURL, Prefix: prefix}, ws.hub, logger)
	if err != nil {
		t.Fatal(err)
	}
	ws.setRedisBroker(broker)
	server := httptest.NewServer(newServiceHandler(&ready, logger, ws, nil))
	t.Cleanup(func() {
		ws.stopAccepting()
		ws.hub.forceClose()
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := ws.wait(ctx); err != nil {
			t.Error(err)
		}
		if err := broker.Close(); err != nil {
			t.Error(err)
		}
	})
	waitRedisTest(t, "replica ready", func() bool { return redisTestHTTP(t, server.URL+"/readyz") == http.StatusOK })
	return ws, broker, server.URL
}

func redisTestHTTP(t *testing.T, endpoint string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func waitRedisTest(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		if ok() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func waitRedisTestSubscribers(t *testing.T, client *redis.Client, channel string, count int64) {
	t.Helper()
	description := fmt.Sprintf("%d Redis subscribers on %s", count, channel)
	waitRedisTest(t, description, func() bool {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		values, err := client.PubSubNumSub(ctx, channel).Result()
		return err == nil && values[channel] == count
	})
}

type redisTestHistory struct {
	mu       sync.Mutex
	messages map[string]*historyv1.SaveMessageResponse
}

func setupRedisTestHistory(t *testing.T) (historyv1.HistoryServiceClient, *redisTestHistory) {
	t.Helper()
	state := &redisTestHistory{messages: make(map[string]*historyv1.SaveMessageResponse)}
	history := startTestHistoryRPC(t, receiptTestServer{
		membershipTestServer: membershipTestServer{members: func(_ context.Context, req *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			if req.GetChatId() != fanoutChat || (req.GetRequesterId() != fanoutAlice && req.GetRequesterId() != fanoutBob) {
				t.Errorf("unexpected recipients request: %v", req)
				return nil, status.Error(codes.PermissionDenied, "not a member")
			}
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		save: func(_ context.Context, req *historyv1.SaveMessageRequest) (*historyv1.SaveMessageResponse, error) {
			if req.GetChatId() != fanoutChat || req.GetSenderId() != fanoutAlice {
				t.Errorf("unexpected save request: %v", req)
				return nil, status.Error(codes.PermissionDenied, "not a member")
			}
			state.mu.Lock()
			defer state.mu.Unlock()
			if prior := state.messages[req.GetClientMsgId()]; prior != nil {
				return &historyv1.SaveMessageResponse{
					MessageId: prior.GetMessageId(), Seq: prior.GetSeq(), CreatedAt: prior.GetCreatedAt(), Duplicate: true,
				}, nil
			}
			saved := &historyv1.SaveMessageResponse{
				MessageId: newWSEventID(), Seq: int64(len(state.messages)) + 1, CreatedAt: timestamppb.Now(),
			}
			state.messages[req.GetClientMsgId()] = saved
			return saved, nil
		},
		advance: func(_ context.Context, request *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
			if request.GetKind() != testReceiptRead || request.GetActorId() != fanoutBob || request.GetSeq() != 1 {
				t.Errorf("unexpected receipt request: %v", request)
			}
			return &historyv1.AdvanceReceiptResponse{LastReadSeq: 1, LastDeliveredSeq: 1, DeliveredAdvanced: true}, nil
		},
	})
	return history, state
}

func (s *redisTestHistory) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.messages)
}

type redisTestWSFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	TS      time.Time       `json:"ts"`
	Payload json.RawMessage `json:"payload"`
}

func readRedisTestFrame(t *testing.T, conn *websocket.Conn, timeout time.Duration) redisTestWSFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	var frame redisTestWSFrame
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if !validWSUUID(frame.ID) || frame.TS.IsZero() {
		t.Fatalf("invalid server frame: %+v", frame)
	}
	return frame
}

func sendRedisTestMessage(t *testing.T, conn *websocket.Conn, clientID string, seq int64, timeout time.Duration) wsAckPayload {
	t.Helper()
	requestID := newWSEventID()
	sendTestMessage(t, conn, requestID, clientID, "Тест межрепличной доставки")
	frame := readRedisTestFrame(t, conn, timeout)
	var payload wsAckPayload
	err := json.Unmarshal(frame.Payload, &payload)
	if frame.Type != "message.ack" || frame.ID != requestID || err != nil ||
		payload.Seq != seq || payload.ChatID != fanoutChat || payload.ClientMsgID != clientID || !validWSUUID(payload.MessageID) {
		t.Fatalf("unexpected ACK: %s (%s), payload=%+v, decode=%v", frame.Type, frame.ID, payload, err)
	}
	return payload
}

func assertRedisTestMessage(t *testing.T, ack wsAckPayload, tabs ...*websocket.Conn) {
	t.Helper()
	var fanoutID string
	for _, tab := range tabs {
		var got wsNewPayload
		id := readTestEvent(t, tab, "message.new", &got)
		if fanoutID == "" {
			fanoutID = id
		}
		if got.MessageID != ack.MessageID || got.ChatID != ack.ChatID || got.Seq != ack.Seq ||
			got.SenderID != fanoutAlice || id != fanoutID {
			t.Fatalf("unexpected message.new: %+v, id=%s, expected ACK=%+v", got, id, ack)
		}
	}
}

// Publishing a valid probe through the same transport fences earlier events
// for the given user without consuming a read timeout on the WebSocket.
func assertRedisTestFence(t *testing.T, ws *wsEndpoint, userID string, tabs ...*websocket.Conn) {
	t.Helper()
	id := newWSEventID()
	envelope := newWSEnvelope(wsDeliveredType, id, wsReceiptPayload{ChatID: fanoutChat, UserID: fanoutAlice, Seq: 1})
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.broker.Publish(t.Context(), []string{userID}, data); err != nil {
		t.Fatal(err)
	}
	for _, tab := range tabs {
		var got wsReceiptPayload
		if observed := readTestEvent(t, tab, wsDeliveredType, &got); observed != id {
			t.Fatalf("unexpected extra event before fence: id=%s payload=%+v", observed, got)
		}
	}
}

func TestRedisBrokerTwoReplicas(t *testing.T) {
	redisURL, client := redisIntegrationClient(t)
	proxy := startRedisTestProxy(t, client.Options().Addr)
	prefix := "chat141-tests-" + newWSEventID()
	history, saved := setupRedisTestHistory(t)
	wsA, brokerA, urlA := startRedisTestReplica(t, redisURL, prefix, history)
	wsB, _, urlB := startRedisTestReplica(t, proxy.redisURL(t, redisURL), prefix, history)

	alice, _ := dialTestUser(t, urlA, fanoutAlice)
	aliceOther, _ := dialTestUser(t, urlB, fanoutAlice)
	bob, _ := dialTestUser(t, urlB, fanoutBob)
	bobOther, _ := dialTestUser(t, urlB, fanoutBob)
	carol, _ := dialTestUser(t, urlB, fanoutCarol)
	waitForConnections(t, wsA, 1)
	waitForConnections(t, wsB, 4)
	bobChannel := brokerA.userChannel(fanoutBob)
	waitRedisTestSubscribers(t, client, brokerA.userChannel(fanoutAlice), 2)
	waitRedisTestSubscribers(t, client, bobChannel, 1)
	waitRedisTestSubscribers(t, client, brokerA.userChannel(fanoutCarol), 1)

	ack := sendRedisTestMessage(t, alice, sendTestClientID, 1, 5*time.Second)
	tabs := []*websocket.Conn{alice, aliceOther, bob, bobOther}
	assertRedisTestMessage(t, ack, tabs...)
	assertRedisTestFence(t, wsA, fanoutAlice, alice, aliceOther)
	assertRedisTestFence(t, wsA, fanoutBob, bob, bobOther)
	assertRedisTestFence(t, wsA, fanoutCarol, carol)

	receiptID := sendTestReceipt(t, bob, wsReadType, map[string]any{"chat_id": fanoutChat, "seq": 1})
	for _, conn := range tabs {
		seen := map[string]bool{}
		for range 2 {
			f := readRedisTestFrame(t, conn, 5*time.Second)
			var payload wsReceiptPayload
			if err := json.Unmarshal(f.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if f.ID == receiptID || seen[f.Type] || (f.Type != wsDeliveredType && f.Type != wsReadType) ||
				payload.ChatID != fanoutChat || payload.UserID != fanoutBob || payload.Seq != 1 {
				t.Fatalf("unexpected receipt event: %+v %+v", f, payload)
			}
			seen[f.Type] = true
		}
	}
	assertRedisTestFence(t, wsB, fanoutCarol, carol)
	writeTestTyping(t, alice, true)
	readWSTyping(t, bob, true)
	readWSTyping(t, bobOther, true)
	writeTestTyping(t, alice, false)
	readWSTyping(t, bob, false)
	readWSTyping(t, bobOther, false)
	assertRedisTestFence(t, wsA, fanoutAlice, alice, aliceOther)
	assertRedisTestFence(t, wsA, fanoutCarol, carol)

	// Replicas lose their Redis subscriptions while their WS connections stay open.
	proxy.setOnline(false)
	waitRedisTest(t, "disconnected replica readiness", func() bool {
		return redisTestHTTP(t, urlB+"/readyz") == http.StatusServiceUnavailable
	})
	if got := redisTestHTTP(t, urlB+"/healthz"); got != http.StatusOK {
		t.Fatalf("Redis outage changed liveness to %d", got)
	}
	if got := redisTestMetric(t, urlB, "chat_redis_broker_ready"); got != 0 {
		t.Fatalf("Redis readiness gauge during outage = %v, want 0", got)
	}
	waitRedisTest(t, "reported subscriber failure", func() bool {
		return redisTestMetric(t, urlB, "chat_redis_broker_errors_total{operation=\"subscribe\"}") > 0
	})
	waitRedisTestSubscribers(t, client, bobChannel, 0)

	lostClientID := newWSEventID()
	lost := sendRedisTestMessage(t, alice, lostClientID, 2, 5*time.Second)
	assertRedisTestMessage(t, lost, alice)
	assertRedisTestFence(t, wsA, fanoutAlice, alice)
	assertNextWSFrameIsInvalidJSON(t, bob)
	assertNextWSFrameIsInvalidJSON(t, bobOther)
	replay := sendRedisTestMessage(t, alice, lostClientID, 2, 5*time.Second)
	if replay.MessageID != lost.MessageID || !replay.CreatedAt.Equal(lost.CreatedAt) || saved.count() != 2 {
		t.Fatalf("retry changed the saved message: first=%+v retry=%+v, saved=%d", lost, replay, saved.count())
	}
	assertRedisTestFence(t, wsA, fanoutAlice, alice)

	proxy.setOnline(true)
	waitRedisTest(t, "restored replica readiness", func() bool { return redisTestHTTP(t, urlB+"/readyz") == http.StatusOK })
	waitRedisTestSubscribers(t, client, bobChannel, 1)
	if got := redisTestMetric(t, urlB, "chat_redis_broker_ready"); got != 1 {
		t.Fatalf("Redis readiness gauge after recovery = %v, want 1", got)
	}
	waitRedisTest(t, "reported subscriber recovery", func() bool {
		return redisTestMetric(t, urlB, "chat_redis_broker_reconnects_total") > 0
	})
	assertRedisTestFence(t, wsA, fanoutBob, bob, bobOther)
	next := sendRedisTestMessage(t, alice, newWSEventID(), 3, 5*time.Second)
	assertRedisTestMessage(t, next, tabs...)

	if err := bobOther.Close(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, wsB, 3)
	waitRedisTestSubscribers(t, client, bobChannel, 1)
	assertRedisTestFence(t, wsA, fanoutBob, bob)
	if err := bob.Close(); err != nil {
		t.Fatal(err)
	}
	waitForConnections(t, wsB, 2)
	waitRedisTestSubscribers(t, client, bobChannel, 0)
	bob, _ = dialTestUser(t, urlB, fanoutBob)
	waitRedisTestSubscribers(t, client, bobChannel, 1)
	assertRedisTestFence(t, wsA, fanoutBob, bob)

	// Complete an old unsubscribe after a new first socket registered.
	unsubscribe := proxy.holdCommand(t, "UNSUBSCRIBE", bobChannel)
	if err := bob.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-unsubscribe.started:
	case <-time.After(5 * time.Second):
		t.Fatal("last-tab unsubscribe did not reach the Redis proxy")
	}
	reopened, _ := dialTestUser(t, urlB, fanoutBob)
	waitForConnections(t, wsB, 3)
	resubscribe := proxy.holdCommand(t, "SUBSCRIBE", bobChannel)
	unsubscribe.unblock()
	select {
	case <-resubscribe.started:
	case <-time.After(5 * time.Second):
		t.Fatal("replacement-tab subscribe did not follow the old unsubscribe")
	}
	waitRedisTestSubscribers(t, client, bobChannel, 0)
	resubscribe.unblock()
	waitRedisTestSubscribers(t, client, bobChannel, 1)
	assertRedisTestFence(t, wsA, fanoutBob, reopened)
}

func redisTestMetric(t *testing.T, server, name string) float64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server+"/metrics", nil)
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
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metrics response status = %d", resp.StatusCode)
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		if raw, ok := strings.CutPrefix(line, name+" "); ok {
			value, err := strconv.ParseFloat(raw, 64)
			if err != nil {
				t.Fatalf("invalid metric %q: %v", name, err)
			}
			return value
		}
	}
	return -1
}

func TestRedisBrokerSlowPublishDoesNotDelayFollowingMessageAck(t *testing.T) {
	redisURL, client := redisIntegrationClient(t)
	proxy := startRedisTestProxy(t, client.Options().Addr)
	prefix := "chat141-tests-" + newWSEventID()
	history, saved := setupRedisTestHistory(t)
	_, brokerA, urlA := startRedisTestReplica(t, proxy.redisURL(t, redisURL), prefix, history)
	_, _, urlB := startRedisTestReplica(t, redisURL, prefix, history)
	alice, _ := dialTestUser(t, urlA, fanoutAlice)
	_, _ = dialTestUser(t, urlB, fanoutBob)
	waitRedisTestSubscribers(t, client, brokerA.userChannel(fanoutBob), 1)
	waitRedisTestSubscribers(t, client, brokerA.userChannel(fanoutAlice), 1)
	gate := proxy.holdCommand(t, "PUBLISH", brokerA.userChannel(fanoutAlice))
	start := time.Now()
	sendRedisTestMessage(t, alice, sendTestClientID, 1, 5*time.Second)
	select {
	case <-gate.started:
	case <-time.After(5 * time.Second):
		t.Fatal("first PUBLISH did not reach the Redis proxy")
	}

	// Keep PUBLISH held until cleanup. This deadline is shorter than the
	// broker's Redis operation timeout, so a serial worker would miss it.
	sendRedisTestMessage(t, alice, newWSEventID(), 2, 550*time.Millisecond)
	if elapsed := time.Since(start); elapsed >= redisOperationTimeout {
		t.Fatalf("ACK arrived after the Redis operation could have timed out: %s", elapsed)
	}
	if saved.count() != 2 {
		t.Fatalf("second SaveMessage did not complete while PUBLISH was held: %d saved", saved.count())
	}
}

func TestRedisBrokerRemainsUnreadyWhileRecipientPublicationIsDenied(t *testing.T) {
	raw, admin := redisIntegrationClient(t)
	prefix := "chat141-acl-" + newWSEventID()
	name, password := "chat141-user-"+newWSEventID(), newWSEventID()
	senderChannel := prefix + ":user:" + fanoutAlice
	recipientChannel := prefix + ":user:" + fanoutBob
	if err := admin.Do(t.Context(), "ACL", "SETUSER", name, "on", ">"+password, "+@all", "&"+prefix+":*").Err(); err != nil {
		t.Fatalf("create test Redis user: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = admin.Do(ctx, "ACL", "DELUSER", name).Err()
	})
	restricted, err := url.Parse(raw)
	if err != nil {
		t.Fatal("invalid test Redis URL")
	}
	restricted.User = url.UserPassword(name, password)
	history, _ := setupRedisTestHistory(t)
	wsA, _, urlA := startRedisTestReplica(t, restricted.String(), prefix, history)
	_, _, urlB := startRedisTestReplica(t, raw, prefix, history)
	a, _ := dialTestUser(t, urlA, fanoutAlice)
	b, _ := dialTestUser(t, urlB, fanoutBob)
	waitRedisTestSubscribers(t, admin, senderChannel, 1)
	waitRedisTestSubscribers(t, admin, recipientChannel, 1)

	// Both probes and Alice's working channel remain writable. Only Bob's
	// actual channel loses permission.
	if err := admin.Do(t.Context(), "ACL", "SETUSER", name, "resetchannels", "&"+prefix+":health",
		"&"+prefix+":user:probe", "&"+senderChannel).Err(); err != nil {
		t.Fatalf("restrict test Redis user: %v", err)
	}
	ack := sendRedisTestMessage(t, a, sendTestClientID, 1, time.Second)
	assertRedisTestMessage(t, ack, a)
	waitRedisTest(t, "recipient publish error", func() bool {
		const metric = "chat_redis_broker_errors_total{operation=\"publish\"}"
		return redisTestMetric(t, urlA, metric) >= 1
	})
	assertNextWSFrameIsInvalidJSON(t, b)
	assertRedisTestFence(t, wsA, fanoutAlice, a)

	until := time.Now().Add(3 * redisProbeInterval)
	for time.Now().Before(until) {
		if got := redisTestHTTP(t, urlA+"/readyz"); got != http.StatusServiceUnavailable {
			t.Fatalf("readiness = %d while publication to recipient is still denied", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := redisTestHTTP(t, urlA+"/healthz"); got != http.StatusOK {
		t.Fatalf("Redis ACL failure changed liveness to %d", got)
	}
	if err := admin.Do(t.Context(), "ACL", "SETUSER", name, "&"+recipientChannel).Err(); err != nil {
		t.Fatalf("restore test Redis user's permission: %v", err)
	}
	waitRedisTest(t, "readiness after recipient permission returns", func() bool {
		return redisTestHTTP(t, urlA+"/readyz") == http.StatusOK
	})
	next := sendRedisTestMessage(t, a, newWSEventID(), 2, time.Second)
	assertRedisTestMessage(t, next, a, b)
}

func TestRedisBrokerFullQueueReturnsRetryableReceiptError(t *testing.T) {
	raw, client := redisIntegrationClient(t)
	proxy := startRedisTestProxy(t, client.Options().Addr)
	prefix := "chat141-full-" + newWSEventID()
	var advances atomic.Int32
	history := startTestHistoryRPC(t, receiptTestServer{
		membershipTestServer: membershipTestServer{members: func(context.Context, *historyv1.GetChatMembersRequest) (*historyv1.GetChatMembersResponse, error) {
			return &historyv1.GetChatMembersResponse{UserIds: []string{fanoutAlice, fanoutBob}}, nil
		}},
		advance: func(_ context.Context, request *historyv1.AdvanceReceiptRequest) (*historyv1.AdvanceReceiptResponse, error) {
			if request.GetActorId() != fanoutBob || request.GetSeq() != 1 || request.GetKind() != testReceiptRead {
				t.Errorf("unexpected receipt request: %v", request)
			}
			return &historyv1.AdvanceReceiptResponse{LastReadSeq: 1, LastDeliveredSeq: 1, DeliveredAdvanced: advances.Add(1) == 1}, nil
		},
	})
	_, broker, wsURL := startRedisTestReplica(t, proxy.redisURL(t, raw), prefix, history)
	bob, _ := dialTestUser(t, wsURL, fanoutBob)
	waitRedisTestSubscribers(t, client, broker.userChannel(fanoutBob), 1)
	gate := proxy.holdCommand(t, "PUBLISH", broker.userChannel(fanoutAlice))
	data, err := json.Marshal(newWSEnvelope(wsDeliveredType, newWSEventID(), wsReceiptPayload{ChatID: fanoutChat, UserID: fanoutAlice, Seq: 1}))
	if err != nil {
		t.Fatal(err)
	}
	enqueue := func() {
		t.Helper()
		if err := broker.Publish(t.Context(), []string{fanoutAlice}, data); err != nil {
			t.Fatal(err)
		}
	}
	enqueue()
	select {
	case <-gate.started:
	case <-time.After(time.Second):
		t.Fatal("publication did not reach the gate")
	}
	for range cap(broker.publications) {
		enqueue()
	}
	payload := map[string]any{"chat_id": fanoutChat, "seq": 1}
	id := sendTestReceipt(t, bob, wsReadType, payload)
	readTestReceiptError(t, bob, id, "temporarily_unavailable", true)
	if advances.Load() != 1 {
		t.Fatalf("first receipt did not reach History: %d requests", advances.Load())
	}

	gate.unblock()
	waitRedisTest(t, "available publication capacity", func() bool { return len(broker.publications) == 0 })
	retryID := sendTestReceipt(t, bob, wsReadType, payload)
	readTestReceipt(t, bob, receiptTestUpdate{wsReadType, 1}, fanoutBob, retryID)
	if advances.Load() != 2 {
		t.Fatalf("receipt retry did not reach History: %d requests", advances.Load())
	}
}
