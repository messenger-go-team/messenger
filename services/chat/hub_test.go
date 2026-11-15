package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

func TestWSSlowSocketDoesNotDelayAnotherTab(t *testing.T) {
	ws, url := startTestWSEndpoint(t, defaultWSTiming(), nil)
	healthy, _ := dialTestUser(t, url, fanoutAlice)

	// Leave one connection's writer paused so overflow is independent of TCP buffers.
	startWriter := make(chan struct{})
	releaseWriter := sync.OnceFunc(func() { close(startWriter) })
	slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := ws.upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = conn.Close() }()
		socket := newSocketSession(conn, jwtauth.Identity{UserID: fanoutAlice, ExpiresAt: time.Now().Add(time.Minute)})
		if !ws.hub.register(socket) {
			t.Error("slow socket was refused by the hub")
			return
		}
		defer ws.hub.unregister(socket)
		<-startWriter
		ws.serveSocket(socket)
	}))
	defer slowServer.Close()
	defer releaseWriter()
	slow, _ := dialTestUser(t, slowServer.URL, fanoutAlice)
	waitForConnections(t, ws, 2)

	for index := range wsQueueSize + 2 {
		want := fmt.Sprintf(`{"index":%d}`, index)
		payload := []byte(want)
		if err := ws.broker.Publish(t.Context(), []string{fanoutAlice}, payload); err != nil {
			t.Fatal(err)
		}
		// A publication owns its data even when the original buffer is reused.
		clear(payload)
		assertTextFrame(t, healthy, want)
	}
	releaseWriter()
	assertSocketClose(t, slow, websocket.CloseTryAgainLater)
	waitForConnections(t, ws, 1)
	assertNoBroadcast(t, ws, fanoutAlice, healthy)
}
