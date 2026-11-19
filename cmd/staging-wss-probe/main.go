// staging-wss-probe verifies the public Auth -> Nginx -> Chat handshake.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func probe(ctx context.Context, origin string, account credentials) error {
	base, err := url.Parse(origin)
	if err != nil || base.Scheme != "https" || base.Host == "" ||
		base.User != nil || base.Path != "" || base.RawQuery != "" || base.Fragment != "" {
		return errors.New("expected an HTTPS origin")
	}
	login := *base
	login.Path = "/auth/login"
	payload, err := json.Marshal(account)
	if err != nil {
		return errors.New("cannot encode probe credentials")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, login.String(), bytes.NewReader(payload))
	if err != nil {
		return errors.New("cannot construct login request")
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("test account login request failed")
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("test account login returned HTTP %d", res.StatusCode)
	}
	var session struct {
		Token string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&session); err != nil || session.Token == "" {
		return errors.New("test account login yielded no token")
	}

	socket := *base
	socket.Scheme = "wss"
	socket.Path = "/ws"
	dialer := websocket.Dialer{Subprotocols: []string{"messenger.v1", "bearer." + session.Token}}
	conn, reply, err := dialer.DialContext(ctx, socket.String(), http.Header{"Origin": []string{origin}})
	if err != nil {
		if reply != nil {
			_ = reply.Body.Close()
			return fmt.Errorf("public WSS returned HTTP %d, expected 101", reply.StatusCode)
		}
		return errors.New("public WSS handshake failed")
	}
	defer func() { _ = conn.Close() }()
	if conn.Subprotocol() != "messenger.v1" {
		return errors.New("public WSS did not select messenger.v1")
	}
	return conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
}

func run(args []string) error {
	if len(args) != 2 {
		return errors.New("usage: staging-wss-probe HTTPS_ORIGIN CREDENTIALS_FILE")
	}
	file, err := os.Open(args[1])
	if err != nil {
		return errors.New("cannot open staging probe credentials")
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("probe credentials must be a regular file with mode 0600 or 0400")
	}
	var account credentials
	if err := json.NewDecoder(io.LimitReader(file, 4096)).Decode(&account); err != nil ||
		account.Username == "" || account.Password == "" {
		return errors.New("invalid staging probe credentials")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return probe(ctx, args[0], account)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "staging WSS:", err)
		os.Exit(1)
	}
	fmt.Println("staging WSS: HTTP 101 and messenger.v1")
}
