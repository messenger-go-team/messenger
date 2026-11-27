package main

import (
	"context"
	"errors"
	"maps"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type redisSubscriptionState struct {
	// Each reconciliation gets all acknowledgements before issuing another.
	// This keeps a late unsubscribe acknowledgement from satisfying a subscribe.
	pending        map[string]string
	requested      map[string]struct{}
	generation     uint64
	waitingForPong time.Time
	waitingForAck  time.Time
	heartbeatSeen  bool
	readyOnce      bool
	restoring      bool
}

func (b *redisBroker) runSubscriber() {
	wasReady := false
	for b.ctx.Err() == nil {
		session := redisSubscriptionState{
			pending:   map[string]string{b.healthChannel(): "subscribe"},
			requested: make(map[string]struct{}),
			restoring: wasReady,
		}
		err := b.subscribe(&session)
		wasReady = wasReady || session.readyOnce
		if b.ctx.Err() != nil {
			return
		}
		if err != nil {
			b.errors.WithLabelValues("subscribe").Inc()
			if session.readyOnce {
				b.logger.Warn("Redis subscription disconnected")
			}
		}
		timer := time.NewTimer(redisProbeInterval)
		select {
		case <-b.ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

type redisReceiveResult struct {
	value any
	err   error
}

func (b *redisBroker) subscribe(session *redisSubscriptionState) error {
	ctx, cancel := context.WithCancel(b.ctx)
	ps := b.client.Subscribe(ctx)
	readDone := make(chan struct{})
	defer func() {
		b.desiredMu.Lock()
		b.subscriptionsReady = false
		b.desiredMu.Unlock()
		b.publisherReady.Store(false)
		b.activeSubscriptions.Set(0)
		cancel()
		_ = ps.Close()
		<-readDone
	}()

	setup, stopSetup := context.WithTimeout(ctx, redisOperationTimeout)
	session.waitingForAck = time.Now()
	err := ps.Subscribe(setup, b.healthChannel())
	stopSetup()
	if err != nil {
		close(readDone)
		return err
	}
	receive := make(chan redisReceiveResult)
	go func() {
		defer close(readDone)
		for ctx.Err() == nil {
			// Bound internal reconnection even when Redis stopped replying.
			read, stopRead := context.WithTimeout(ctx, 2*redisOperationTimeout)
			value, err := ps.Receive(read)
			stopRead()
			select {
			case <-ctx.Done():
				return
			case receive <- redisReceiveResult{value: value, err: err}:
			}
			if err != nil {
				return
			}
		}
	}()

	ticker := time.NewTicker(redisProbeInterval)
	defer ticker.Stop()
	if err := session.ping(ctx, ps); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-b.wake:
			if err := b.reconcile(ctx, ps, session); err != nil {
				return err
			}
			b.confirmSubscriptionState(session)
		case <-ticker.C:
			if !session.waitingForAck.IsZero() && time.Since(session.waitingForAck) >= redisOperationTimeout {
				return errors.New("expired Redis subscription acknowledgement")
			}
			if err := session.ping(ctx, ps); err != nil {
				return err
			}
		case r := <-receive:
			if r.err != nil {
				return r.err
			}
			switch v := r.value.(type) {
			case *redis.Subscription:
				if session.pending[v.Channel] != v.Kind {
					return errors.New("unexpected Redis subscription acknowledgement")
				}
				delete(session.pending, v.Channel)
				if len(session.pending) == 0 {
					session.waitingForAck = time.Time{}
				}
				b.activeSubscriptions.Set(float64(max(v.Count-1, 0)))
				if err := b.reconcile(ctx, ps, session); err != nil {
					return err
				}
				b.confirmSubscriptionState(session)
			case *redis.Pong:
				if v.Payload != redisSubscriberProbe || session.waitingForPong.IsZero() {
					return errors.New("unexpected Redis heartbeat reply")
				}
				session.waitingForPong = time.Time{}
				session.heartbeatSeen = true
				b.confirmSubscriptionState(session)
			case *redis.Message:
				b.deliverRedisMessage(ctx, v)
			}
		}
	}
}

const redisSubscriberProbe = "messenger-chat-probe"

func (s *redisSubscriptionState) ping(ctx context.Context, ps *redis.PubSub) error {
	if !s.waitingForPong.IsZero() {
		if time.Since(s.waitingForPong) >= redisOperationTimeout {
			return errors.New("expired Redis heartbeat")
		}
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, redisOperationTimeout)
	defer cancel()
	s.waitingForPong = time.Now()
	return ps.Ping(ctx, redisSubscriberProbe)
}

func (b *redisBroker) reconcile(ctx context.Context, ps *redis.PubSub, session *redisSubscriptionState) error {
	if len(session.pending) != 0 {
		return nil
	}

	b.desiredMu.Lock()
	generation := b.generation
	if session.generation == generation {
		b.desiredMu.Unlock()
		return nil
	}
	desired := maps.Clone(b.desired)
	b.desiredMu.Unlock()

	var add, remove []string
	for user := range desired {
		if _, exists := session.requested[user]; !exists {
			channel := b.userChannel(user)
			add = append(add, channel)
			session.pending[channel] = "subscribe"
		}
	}
	for user := range session.requested {
		if _, keep := desired[user]; !keep {
			channel := b.userChannel(user)
			remove = append(remove, channel)
			session.pending[channel] = "unsubscribe"
		}
	}
	session.generation, session.requested = generation, desired
	if len(session.pending) != 0 {
		session.waitingForAck = time.Now()
	}

	ctx, cancel := context.WithTimeout(ctx, redisOperationTimeout)
	defer cancel()
	if len(add) != 0 {
		if err := ps.Subscribe(ctx, add...); err != nil {
			return err
		}
	}
	if len(remove) != 0 {
		return ps.Unsubscribe(ctx, remove...)
	}
	return nil
}

func (b *redisBroker) confirmSubscriptionState(session *redisSubscriptionState) {
	// An established session remains ready while routine changes converge.
	if session.readyOnce {
		return
	}
	b.desiredMu.Lock()
	ready := session.heartbeatSeen && len(session.pending) == 0 && b.generation == session.generation
	b.subscriptionsReady = ready
	b.desiredMu.Unlock()
	if ready {
		session.readyOnce = true
		if session.restoring {
			b.reconnects.Inc()
		}
	}
}

func (b *redisBroker) deliverRedisMessage(ctx context.Context, message *redis.Message) {
	// Empty payloads on user channels recheck a previous ACL denial.
	if message.Channel == b.healthChannel() || message.Payload == "" {
		return
	}
	user, ok := strings.CutPrefix(message.Channel, b.prefix+":user:")
	if !ok || !validWSUUID(user) || len(message.Payload) > wsMaxMessageBytes {
		b.dropped.WithLabelValues("invalid").Inc()
		return
	}
	data := []byte(message.Payload)
	valid, expired := inspectRedisEvent(data, time.Now())
	if !valid {
		b.dropped.WithLabelValues("invalid").Inc()
		return
	}
	if expired {
		b.dropped.WithLabelValues("expired").Inc()
		return
	}
	_ = b.hub.publish(ctx, []string{user}, data)
}
