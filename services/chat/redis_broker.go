package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

const (
	redisQueueSize = 256
	// Bound the Redis pipeline even if History returns an oversized recipient list.
	redisMaxRecipients    = 256
	redisOperationTimeout = time.Second
	redisPublicationAge   = 2 * time.Second
	redisProbeInterval    = 500 * time.Millisecond
)

type redisBrokerConfig struct {
	URL    string
	Prefix string
}

type redisPublication struct {
	users     []string
	event     []byte
	expiresAt time.Time
}

type redisBroker struct {
	client    *redis.Client
	prefix    string
	hub       *connectionHub
	logger    *slog.Logger
	ctx       context.Context
	cancel    context.CancelFunc
	workers   sync.WaitGroup
	closeOnce sync.Once
	closeErr  error

	publications chan redisPublication
	wake         chan struct{}

	// The hub updates desired under its own lock. No code holds this mutex
	// during socket delivery or while talking to Redis.
	desiredMu          sync.Mutex
	desired            map[string]struct{}
	generation         uint64
	subscriptionsReady bool
	publisherReady     atomic.Bool

	errors              *prometheus.CounterVec
	dropped             *prometheus.CounterVec
	reconnects          prometheus.Counter
	activeSubscriptions prometheus.Gauge
}

func newRedisBroker(cfg redisBrokerConfig, hub *connectionHub, logger *slog.Logger) (*redisBroker, error) {
	opts, err := redis.ParseURL(cfg.URL)
	if err != nil {
		// A malformed URL may contain credentials.
		return nil, errors.New("invalid Redis URL")
	}
	if cfg.Prefix == "" {
		return nil, errors.New("missing Redis channel prefix")
	}
	opts.Protocol = 2
	opts.DisableIdentity = true
	// A lost PUBLISH reply is ambiguous. Retrying could duplicate delivery.
	opts.MaxRetries = -1
	opts.DialTimeout = redisOperationTimeout
	opts.ReadTimeout = redisOperationTimeout
	opts.WriteTimeout = redisOperationTimeout
	opts.PoolTimeout = redisOperationTimeout
	opts.ContextTimeoutEnabled = true

	ctx, cancel := context.WithCancel(context.Background())
	b := &redisBroker{
		client:       redis.NewClient(opts),
		prefix:       cfg.Prefix,
		hub:          hub,
		logger:       logger,
		ctx:          ctx,
		cancel:       cancel,
		publications: make(chan redisPublication, redisQueueSize),
		wake:         make(chan struct{}, 1),
		desired:      make(map[string]struct{}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chat_redis_broker_errors_total",
			Help: "Redis broker operation failures.",
		}, []string{"operation"}),
		dropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chat_redis_broker_dropped_events_total",
			Help: "Redis broker events skipped or lost during live delivery.",
		}, []string{"reason"}),
		reconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "chat_redis_broker_reconnects_total",
			Help: "Redis subscriber sessions restored after a failure.",
		}),
		activeSubscriptions: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "chat_redis_broker_active_subscriptions",
			Help: "Acknowledged Redis user subscriptions on this Chat replica.",
		}),
	}
	b.workers.Go(b.runPublisher)
	b.workers.Go(b.runSubscriber)
	return b, nil
}

func (b *redisBroker) userChannel(user string) string { return b.prefix + ":user:" + user }
func (b *redisBroker) healthChannel() string          { return b.prefix + ":health" }

func (b *redisBroker) Collectors() []prometheus.Collector {
	ready := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "chat_redis_broker_ready",
		Help: "Whether Redis publishing and subscriptions are ready.",
	}, func() float64 {
		if b.Ready() {
			return 1
		}
		return 0
	})
	return []prometheus.Collector{ready, b.errors, b.dropped, b.reconnects, b.activeSubscriptions}
}

func (b *redisBroker) SetLocalUser(userID string, present bool) {
	b.desiredMu.Lock()
	_, exists := b.desired[userID]
	if exists != present {
		if present {
			b.desired[userID] = struct{}{}
		} else {
			delete(b.desired, userID)
		}
		b.generation++
	}
	b.desiredMu.Unlock()
	if exists != present {
		select {
		case b.wake <- struct{}{}:
		default: // The next reconciliation reads current desired state.
		}
	}
}

func (b *redisBroker) Ready() bool {
	b.desiredMu.Lock()
	defer b.desiredMu.Unlock()
	return b.ctx.Err() == nil && b.publisherReady.Load() && b.subscriptionsReady
}

func (b *redisBroker) Close() error {
	b.closeOnce.Do(func() {
		b.cancel()
		b.workers.Wait()
		b.closeErr = b.client.Close()
	})
	return b.closeErr
}

// Publish admits a live event to a bounded queue. The caller may cancel its
// RPC context after admission. Redis work uses a separate deadline and age bound.
func (b *redisBroker) Publish(ctx context.Context, users []string, event []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := b.ctx.Err(); err != nil {
		return err
	}
	if len(users) == 0 {
		return nil
	}
	if len(event) == 0 || len(event) > wsMaxMessageBytes || len(users) > redisMaxRecipients {
		b.dropped.WithLabelValues("invalid").Inc()
		return errors.New("invalid Redis publication size")
	}
	for _, user := range users {
		if !validWSUUID(user) || strings.ToLower(user) != user {
			b.dropped.WithLabelValues("invalid").Inc()
			return errors.New("invalid Redis recipient")
		}
	}

	if len(b.publications) < cap(b.publications) {
		item := redisPublication{
			users:     slices.Clone(users),
			event:     bytes.Clone(event),
			expiresAt: time.Now().Add(redisPublicationAge),
		}
		select {
		case <-b.ctx.Done():
			return b.ctx.Err()
		case b.publications <- item:
			return nil
		default:
		}
	}
	b.dropped.WithLabelValues("queue_full").Inc()
	return errors.New("full Redis publication queue")
}

func (b *redisBroker) runPublisher() {
	ticker := time.NewTicker(redisProbeInterval)
	defer ticker.Stop()
	b.probePublisher()
	for b.ctx.Err() == nil {
		select {
		case <-b.ctx.Done():
			return
		case <-ticker.C:
			b.probePublisher()
		case item := <-b.publications:
			b.publishItem(item)
		}
	}
}

// Probe the same command used by real publications, including scoped ACLs.
// The health channel is internal to the broker and never reaches a WebSocket.
func (b *redisBroker) probePublisher() {
	ctx, cancel := context.WithTimeout(b.ctx, redisOperationTimeout)
	defer cancel()
	err := b.client.Publish(ctx, b.healthChannel(), "").Err()
	b.publisherReady.Store(err == nil)
	if err != nil && b.ctx.Err() == nil {
		b.errors.WithLabelValues("probe").Inc()
	}
}

func (b *redisBroker) publishItem(item redisPublication) {
	now := time.Now()
	valid, expired := inspectRedisEvent(item.event, now)
	if !valid {
		b.dropped.WithLabelValues("invalid").Inc()
		return
	}
	if !now.Before(item.expiresAt) || expired {
		b.dropped.WithLabelValues("expired").Inc()
		return
	}
	ctx, cancel := context.WithDeadline(b.ctx, minTime(item.expiresAt, now.Add(redisOperationTimeout)))
	defer cancel()
	seen := make(map[string]struct{}, len(item.users))
	_, err := b.client.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, user := range item.users {
			if _, ok := seen[user]; !ok {
				seen[user] = struct{}{}
				pipe.Publish(ctx, b.userChannel(user), item.event)
			}
		}
		return nil
	})
	wasReady := b.publisherReady.Swap(err == nil)
	if err != nil && b.ctx.Err() == nil {
		b.errors.WithLabelValues("publish").Inc()
		b.dropped.WithLabelValues("publish_failed").Inc()
		if wasReady {
			b.logger.Warn("Redis event publication failed")
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// Read exact wire keys to keep redis routing and the browser's JSON decoder
// in agreement. Go struct decoding accepts case-insensitive key aliases.
func inspectRedisEvent(data []byte, now time.Time) (valid, expired bool) {
	if len(data) == 0 || len(data) > wsMaxMessageBytes || !utf8.Valid(data) {
		return false, false
	}
	event, duplicate := decodeWSObject(data)
	if duplicate || !validWSUUID(wsString(event["id"])) || !validWSTime(wsString(event["ts"])) {
		return false, false
	}
	payload, duplicate := decodeWSObject(event["payload"])
	if duplicate || !validWSUUID(wsString(payload["chat_id"])) {
		return false, false
	}

	switch wsString(event["type"]) {
	case "message.new":
		return validRedisSequence(payload["seq"], 1) && validWSUUID(wsString(payload["sender_id"])) &&
			validWSUUID(wsString(payload["message_id"])) && validWSClientID(wsString(payload["client_msg_id"])) &&
			validWSTime(wsString(payload["created_at"])) && validWSBody(wsString(payload["body"])), false
	case wsReadType, wsDeliveredType:
		return validRedisSequence(payload["seq"], 0) && validWSUUID(wsString(payload["user_id"])), false
	case wsTypingType:
		var active *bool
		var expiresAt time.Time
		if json.Unmarshal(payload["is_typing"], &active) != nil || active == nil ||
			json.Unmarshal(payload["expires_at"], &expiresAt) != nil || expiresAt.IsZero() ||
			!validWSUUID(wsString(payload["user_id"])) {
			return false, false
		}
		return true, *active && !now.Before(expiresAt)
	default:
		return false, false
	}
}

func validRedisSequence(raw json.RawMessage, minSeq int64) bool {
	var seq *int64
	return json.Unmarshal(raw, &seq) == nil && seq != nil && *seq >= minSeq && *seq <= wsMaxMessageSeq
}
