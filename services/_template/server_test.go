package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestServeShutdown(t *testing.T) {
	for _, force := range []bool{false, true} {
		name := "drains active request"
		if force {
			name = "deadline closes active request"
		}
		t.Run(name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			var ready atomic.Bool
			started := make(chan struct{})
			shutdownStarted := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-release:
					w.WriteHeader(http.StatusNoContent)
				case <-r.Context().Done():
				}
			})
			logger := newLogger(io.Discard, "test", slog.LevelInfo)
			server := newHTTPServer(config{}, handler, logger)
			t.Cleanup(func() {
				if err := server.Close(); err != nil {
					t.Error(err)
				}
			})
			server.RegisterOnShutdown(func() { close(shutdownStarted) })
			timeout := 3 * time.Second
			if force {
				timeout = 25 * time.Millisecond
			}
			done := make(chan error, 1)
			go func() { done <- serve(ctx, server, listener, &ready, timeout, logger) }()

			client := &http.Client{Timeout: 5 * time.Second}
			t.Cleanup(client.CloseIdleConnections)
			type result struct {
				status int
				err    error
			}
			requestDone := make(chan result, 1)
			go func() {
				response, err := client.Get("http://" + listener.Addr().String() + "/slow")
				if err != nil {
					requestDone <- result{err: err}
					return
				}
				err = response.Body.Close()
				requestDone <- result{status: response.StatusCode, err: err}
			}()
			await(t, started)
			if !ready.Load() {
				t.Fatal("server did not become ready")
			}
			cancel()
			await(t, shutdownStarted)
			if ready.Load() {
				t.Fatal("readiness must be cleared before shutdown")
			}
			if !force {
				select {
				case err := <-done:
					t.Fatalf("shutdown returned before the active request finished: %v", err)
				default:
				}
				unblock()
			}
			select {
			case err := <-done:
				if force && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("got %v, want shutdown deadline error", err)
				}
				if !force && err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("server did not stop")
			}
			select {
			case result := <-requestDone:
				if force && result.err == nil {
					t.Fatal("expected the active request to be interrupted")
				}
				if !force && (result.err != nil || result.status != http.StatusNoContent) {
					t.Fatalf("active request did not drain: %+v", result)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("active request did not finish")
			}
		})
	}
}

func TestRunReportsListenFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	})
	err = run(context.Background(), config{HTTPAddr: listener.Addr().String()},
		newLogger(io.Discard, "test", slog.LevelInfo))
	if err == nil {
		t.Fatal("expected an occupied port error")
	}
}

func await(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for server event")
	}
}
