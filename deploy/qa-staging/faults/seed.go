package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	history "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

var seedCode = regexp.MustCompile(`^[a-z0-9]{4,14}$`)

type seedAccount struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type seedResult struct {
	A        seedAccount `json:"a"`
	B        seedAccount `json:"b"`
	C        seedAccount `json:"c"`
	Chat     string      `json:"chat_id"`
	Messages []string    `json:"message_ids"`
}

func seedRequest(ctx context.Context, endpoint, token string, payload map[string]string, status int) (map[string]string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != status {
		return nil, fmt.Errorf("seed %s returned HTTP %d", req.URL.Path, res.StatusCode)
	}
	var parsed map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&parsed); err != nil {
		return nil, err
	}
	values := make(map[string]string)
	for _, k := range []string{"id", "access_token"} {
		if field := parsed[k]; field != nil {
			var value string
			if err := json.Unmarshal(field, &value); err != nil {
				return nil, err
			}
			values[k] = value
		}
	}
	return values, nil
}

func randomBytes(size int) []byte {
	out := make([]byte, size)
	_, _ = rand.Read(out)
	return out
}

func newClientID() string {
	b := randomBytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func seedRun(args []string) error {
	if len(args) < 1 || len(args) > 2 || !seedCode.MatchString(args[0]) {
		return fmt.Errorf("usage: seed RUN_CODE [MESSAGES], code: 4–14 lowercase letters/digits")
	}
	count := 2
	if len(args) == 2 {
		var err error
		count, err = strconv.Atoi(args[1])
		if err != nil || count < 0 || count > 250 {
			return fmt.Errorf("message count must be 0–250")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result := seedResult{Messages: make([]string, 0, count)}
	for label, account := range map[string]*seedAccount{"a": &result.A, "b": &result.B, "c": &result.C} {
		account.Username = "qa50_" + args[0] + "_" + label
		account.Password = hex.EncodeToString(randomBytes(16))
		profile, err := seedRequest(ctx, "http://auth:8080/auth/register", "", map[string]string{
			"username": account.Username, "password": account.Password,
		}, 201)
		if err != nil {
			return err
		}
		account.ID = profile["id"]
	}
	session, err := seedRequest(ctx, "http://auth:8080/auth/login", "", map[string]string{
		"username": result.A.Username, "password": result.A.Password,
	}, 200)
	if err != nil {
		return err
	}
	chat, err := seedRequest(ctx, "http://history:8080/chats/personal", session["access_token"], map[string]string{
		"user_id": result.B.ID,
	}, 201)
	if err != nil {
		return err
	}
	result.Chat = chat["id"]

	conn, err := grpc.NewClient("history:9090", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	rpc := history.NewHistoryServiceClient(conn)
	for i := 1; i <= count; i++ {
		msg, err := rpc.SaveMessage(ctx, &history.SaveMessageRequest{
			ChatId: result.Chat, SenderId: result.B.ID, ClientMsgId: newClientID(),
			Body: fmt.Sprintf("QA %s message %03d", args[0], i),
		})
		if err != nil {
			return fmt.Errorf("seed message %d: %w", i, err)
		}
		result.Messages = append(result.Messages, msg.MessageId)
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
