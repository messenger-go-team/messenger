package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
)

const (
	presenceOperationsPerRPC = 32
	presenceReleasesPerRPC   = 128
	presenceBatchDelay       = 5 * time.Millisecond
	presenceStartWindow      = time.Second
	presenceGrantWindow      = 11 * time.Second
)

type presenceBatcher struct {
	once     sync.Once
	requests chan presenceRPCRequest
	releases chan string
	gate     presenceRPCGate
}

type presenceRPCRequest struct {
	ctx context.Context
	op  *historyv1.PresenceOperation
	out chan presenceRPCResult
}

type presenceRPCResult struct {
	data    *historyv1.PresenceResult
	started time.Time
	version uint64
}

type presenceGrant struct {
	id      string
	startBy time.Time
	writeBy time.Time
	batcher *presenceBatcher
	pending atomic.Int32
}

func newPresenceBatcher() *presenceBatcher {
	return &presenceBatcher{
		requests: make(chan presenceRPCRequest),
		releases: make(chan string, 1024),
	}
}

func (grant *presenceGrant) finish() {
	if grant != nil && grant.pending.Add(-1) == 0 {
		grant.batcher.release(grant.id)
	}
}

func (batch *presenceBatcher) release(id string) {
	select {
	case batch.releases <- id:
	default:
		// A durable grant without an acknowledgment expires at History.
	}
}

func (ws *wsEndpoint) callPresence(ctx context.Context, op *historyv1.PresenceOperation) presenceRPCResult {
	batch := ws.presenceRPC
	batch.once.Do(func() {
		for range presenceRPCConcurrency {
			ws.active.Go(ws.runPresenceBatches)
		}
	})
	req := presenceRPCRequest{ctx: ctx, op: op, out: make(chan presenceRPCResult, 1)}
	select {
	case <-ctx.Done():
		return presenceRPCResult{}
	case <-ws.fanoutCtx.Done():
		return presenceRPCResult{}
	case batch.requests <- req:
	}
	// An admitted caller takes ownership of any returned grant even if its
	// last tab disconnected during the batch. It will release it unused.
	select {
	case <-ws.fanoutCtx.Done():
		return presenceRPCResult{}
	case result := <-req.out:
		return result
	}
}

func (ws *wsEndpoint) runPresenceBatches() {
	batch := ws.presenceRPC
	for ws.fanoutCtx.Err() == nil {
		requests := make([]presenceRPCRequest, 0, presenceOperationsPerRPC)
		releases := make([]string, 0, presenceReleasesPerRPC)
		select {
		case <-ws.fanoutCtx.Done():
			return
		case request := <-batch.requests:
			requests = append(requests, request)
		case id := <-batch.releases:
			releases = append(releases, id)
		}

		timer := time.NewTimer(presenceBatchDelay)
	collect:
		for len(requests) < presenceOperationsPerRPC && len(releases) < presenceReleasesPerRPC {
			select {
			case <-ws.fanoutCtx.Done():
				timer.Stop()
				return
			case request := <-batch.requests:
				requests = append(requests, request)
			case id := <-batch.releases:
				releases = append(releases, id)
			case <-timer.C:
				break collect
			}
		}
		timer.Stop()
		ws.sendPresenceBatch(requests, releases)
	}
}

func (ws *wsEndpoint) sendPresenceBatch(requests []presenceRPCRequest, releases []string) {
	if !ws.presenceRPC.gate.wait(ws.fanoutCtx) {
		return
	}
	active := requests[:0]
	ops := make([]*historyv1.PresenceOperation, 0, len(requests))
	for _, request := range requests {
		if request.ctx.Err() != nil {
			request.out <- presenceRPCResult{}
			continue
		}
		active = append(active, request)
		ops = append(ops, request.op)
	}
	if len(ops) == 0 && len(releases) == 0 {
		return
	}

	ws.hub.mu.Lock()
	version := ws.hub.presenceVersion
	ws.hub.mu.Unlock()
	started := time.Now()
	ctx, cancel := context.WithTimeout(ws.fanoutCtx, ws.historyTimeout)
	defer cancel()
	response, err := ws.history.BatchPresence(ctx, &historyv1.BatchPresenceRequest{
		Operations: ops, ReleasedGrantIds: releases,
	})
	results := response.GetResults()
	for i, request := range active {
		result := presenceRPCResult{started: started, version: version}
		if err == nil && len(results) == len(active) {
			result.data = results[i]
		}
		request.out <- result
	}
}
