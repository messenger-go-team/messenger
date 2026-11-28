package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func burst(args []string) error {
	if len(args) != 3 || !uuid.MatchString(args[0]) {
		return fmt.Errorf("usage: burst CHAT USERNAME ORIGIN, password on stdin")
	}
	in := bufio.NewScanner(os.Stdin)
	if !in.Scan() {
		return fmt.Errorf("expected disposable test password on stdin")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	session, err := seedRequest(ctx, "http://auth:8080/auth/login", "", map[string]string{
		"username": args[1], "password": in.Text(),
	}, http.StatusOK)
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		Subprotocols:     []string{"messenger.v1", "bearer." + session["access_token"]},
	}
	conn, _, err := dialer.DialContext(ctx, "ws://chat:8080/ws", http.Header{"Origin": []string{args[2]}})
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	body := strings.Repeat("q", 3500)
	for i := 0; i < 800; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		id := newClientID()
		_ = conn.SetWriteDeadline(time.Now().Add(4 * time.Second))
		err := conn.WriteJSON(map[string]any{
			"type": "message.send", "id": id, "ts": time.Now().UTC(),
			"payload": map[string]string{"chat_id": args[0], "client_msg_id": id, "body": body},
		})
		if err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(4 * time.Second))
		for {
			var event struct {
				Type    string          `json:"type"`
				ID      string          `json:"id"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := conn.ReadJSON(&event); err != nil {
				return err
			}
			if event.ID != id {
				continue
			}
			if event.Type == "message.ack" {
				break
			}
			if event.Type == "error" {
				var problem struct {
					Code string `json:"code"`
				}
				_ = json.Unmarshal(event.Payload, &problem)
				return fmt.Errorf("burst message %d failed: %s", i+1, problem.Code)
			}
		}
		time.Sleep(7 * time.Millisecond)
	}
	fmt.Println("Burst completed: 800 acknowledged test messages")
	return nil
}
