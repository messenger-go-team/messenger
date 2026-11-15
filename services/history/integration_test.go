package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
	"github.com/messenger-go-team/messenger/services/history/internal/authclient"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

const userA = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
const userB = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
const userC = "cc6ac191-7856-4a41-8a1f-59c49af76ec0"
const missing = "11111111-1111-4111-8111-111111111111"
const testSecret = "history-test-jwt-secret-at-least-32-bytes"
const serviceSecret = "history-test-internal-credential-32-bytes"

func historyDatabase(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("HISTORY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set HISTORY_TEST_DATABASE_URL for isolated PostgreSQL tests")
	}
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		t.Fatal("invalid HISTORY_TEST_DATABASE_URL")
	}
	admin := stdlib.OpenDB(*cfg)
	name := "history_test_" + strings.ToLower(rand.Text()[:16])
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err = admin.ExecContext(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		_ = admin.Close()
		t.Fatal(err)
	}
	own := cfg.Copy()
	own.Database = name
	db := stdlib.OpenDB(*own)
	t.Cleanup(func() {
		_ = db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := admin.ExecContext(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`)
		if err != nil {
			t.Error(err)
		}
		_ = admin.Close()
	})
	migration, err := os.ReadFile("migrations/000001_initial_schema.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	return db
}
func historyJWT(t *testing.T, user string) string {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": user, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()}).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return token
}
func TestPersonalChatsIntegration(t *testing.T) {
	db := historyDatabase(t)
	repo := &postgres.Repository{DB: db}
	var authDown atomic.Bool
	users := map[string]string{userA: "Alice_1", userB: "Bob_2", userC: "Carol_3"}
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+serviceSecret {
			w.WriteHeader(401)
			return
		}
		if authDown.Load() {
			w.WriteHeader(503)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/internal/users/")
		name, ok := users[id]
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(chats.User{ID: id, Username: name})
	}))
	defer auth.Close()
	verifier, err := jwtauth.New(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	service := &chats.Service{Repo: repo, Users: authclient.New(auth.URL, serviceSecret)}
	var ready atomic.Bool
	ready.Store(true)
	logger := newLogger(io.Discard, "history", 0)
	web := httptest.NewServer(newServiceHandlerWithReadiness(&ready, logger, chatRoutes(service, verifier), repo.Ready))
	defer web.Close()
	call := func(owner, body string) (int, []byte, error) {
		req, err := http.NewRequestWithContext(t.Context(), "POST", web.URL+"/chats/personal", strings.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if owner != "" {
			req.Header.Set("Authorization", "Bearer "+owner)
		}
		res, err := web.Client().Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer func() { _ = res.Body.Close() }()
		data, err := io.ReadAll(res.Body)
		return res.StatusCode, data, err
	}
	create := func(token, body string, want int) chats.Chat {
		t.Helper()
		code, data, err := call(token, body)
		if err != nil || code != want {
			t.Fatalf("create: code=%d want=%d err=%v", code, want, err)
		}
		if strings.Contains(string(data), serviceSecret) || strings.Contains(string(data), "password_hash") {
			t.Fatal("private data disclosed")
		}
		var chat chats.Chat
		if want == 200 || want == 201 {
			if err = json.Unmarshal(data, &chat); err != nil {
				t.Fatal(err)
			}
		}
		return chat
	}
	tokenA, tokenB := historyJWT(t, userA), historyJWT(t, userB)
	create("", `{"user_id":"`+userB+`"}`, 401)
	for _, body := range []string{`{}`, `null`, `{"user_id":null}`, `{"user_id":"bad"}`, `{"user_id":"` + userA + `"}`, `{"user_id":"` + strings.ToUpper(userA) + `"}`, `{"user_id":"` + userB + `","owner_id":"` + userC + `"}`, `{"user_id":"` + userB + `","user_id":"` + userC + `"}`, `{"user_id":"` + userB + `"} {}`} {
		create(tokenA, body, 422)
	}
	create(tokenA, `{"user_id":"`+missing+`"}`, 404)
	chat := create(tokenA, `{"user_id":"`+strings.ToUpper(userB)+`"}`, 201)
	if !chats.ValidRPCID(chat.ID) || chat.Type != "personal" || chat.CreatedAt.IsZero() || chat.LastSeq != 0 || len(chat.Members) != 2 || chat.Members[0].ID != userA || chat.Members[1].Username != "Bob_2" {
		t.Fatal("incorrect chat response", chat)
	}
	repeated := create(tokenB, `{"user_id":"`+userA+`"}`, 200)
	if repeated.ID != chat.ID {
		t.Fatal("reverse pair created another chat")
	}
	t.Run("concurrent reversed pair has no orphan chats", func(t *testing.T) {
		type result struct {
			code int
			body []byte
			err  error
		}
		results := make(chan result, 24)
		start := make(chan struct{})
		tokenC := historyJWT(t, userC)
		for i := range 24 {
			go func() {
				<-start
				token, peer := tokenA, userC
				if i%2 == 1 {
					token, peer = tokenC, userA
				}
				code, data, err := call(token, `{"user_id":"`+peer+`"}`)
				results <- result{code, data, err}
			}()
		}
		close(start)
		created := 0
		id := ""
		for range 24 {
			r := <-results
			if r.err != nil || (r.code != 200 && r.code != 201) {
				t.Fatalf("concurrent create: %d %v", r.code, r.err)
			}
			if r.code == 201 {
				created++
			}
			var c chats.Chat
			if json.Unmarshal(r.body, &c) != nil {
				t.Fatal("invalid JSON")
			}
			if id == "" {
				id = c.ID
			}
			if c.ID != id {
				t.Fatal("different chats")
			}
		}
		if created != 1 {
			t.Fatalf("created=%d", created)
		}
		var count, members, pairs int
		if err := db.QueryRow(`SELECT (SELECT count(*) FROM history.chats),(SELECT count(*) FROM history.chat_members),(SELECT count(*) FROM history.personal_chat_pairs)`).Scan(&count, &members, &pairs); err != nil || count != 2 || members != 4 || pairs != 2 {
			t.Fatal("orphan or duplicate rows", count, members, pairs, err)
		}
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rpc := grpc.NewServer(grpc.UnaryInterceptor(rpcLogging(logger)))
	historyv1.RegisterHistoryServiceServer(rpc, &historyGRPC{repo: repo})
	defer rpc.Stop()
	go func() { _ = rpc.Serve(listener) }()
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	client := historyv1.NewHistoryServiceClient(conn)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	t.Run("membership snapshot and authorization", func(t *testing.T) {
		got, err := client.GetChatMembers(ctx, &historyv1.GetChatMembersRequest{ChatId: chat.ID, RequesterId: userA})
		if err != nil || !slices.Equal(got.GetUserIds(), []string{userA, userB}) {
			t.Fatal(got, err)
		}
		_, err = client.GetChatMembers(ctx, &historyv1.GetChatMembersRequest{ChatId: chat.ID, RequesterId: userC})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatal(err)
		}
		gotMember, err := client.CheckMembership(ctx, &historyv1.CheckMembershipRequest{ChatId: chat.ID, UserId: userC})
		if err != nil || gotMember.IsMember {
			t.Fatal(gotMember, err)
		}
		_, err = client.CheckMembership(ctx, &historyv1.CheckMembershipRequest{ChatId: missing, UserId: userA})
		if status.Code(err) != codes.NotFound {
			t.Fatal(err)
		}
		_, err = client.GetChatMembers(ctx, &historyv1.GetChatMembersRequest{ChatId: missing, RequesterId: userA})
		if status.Code(err) != codes.NotFound {
			t.Fatal(err)
		}
		for _, bad := range []string{"", strings.ToUpper(chat.ID), "00000000-0000-0000-0000-000000000000"} {
			_, err = client.CheckMembership(ctx, &historyv1.CheckMembershipRequest{ChatId: bad, UserId: userA})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatal(bad, err)
			}
		}
		if _, err = db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat.ID, userB); err != nil {
			t.Fatal(err)
		}
		_, err = client.GetChatMembers(ctx, &historyv1.GetChatMembersRequest{ChatId: chat.ID, RequesterId: userB})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatal("stale membership", err)
		}
		create(tokenA, `{"user_id":"`+userB+`"}`, 503) // Do not fabricate or restore revoked members.
	})
	t.Run("dependency failures are not absence", func(t *testing.T) {
		authDown.Store(true)
		create(tokenA, `{"user_id":"`+userB+`"}`, 503)
		authDown.Store(false)
		if _, err = db.Exec(`ALTER TABLE history.chat_members RENAME TO members_unavailable`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := db.Exec(`ALTER TABLE history.members_unavailable RENAME TO chat_members`); err != nil {
				t.Error(err)
			}
		}()
		_, err = client.CheckMembership(ctx, &historyv1.CheckMembershipRequest{ChatId: chat.ID, UserId: userA})
		if status.Code(err) != codes.Unavailable {
			t.Fatal(err)
		}
		res, err := web.Client().Get(web.URL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != 503 {
			t.Fatal("readiness ignored missing schema")
		}
	})
	t.Run("database lock obeys RPC deadline", func(t *testing.T) {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback() }()
		if _, err = tx.ExecContext(ctx, `LOCK history.chat_members IN ACCESS EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		defer cancel()
		_, err = client.CheckMembership(short, &historyv1.CheckMembershipRequest{ChatId: chat.ID, UserId: userA})
		if status.Code(err) != codes.DeadlineExceeded {
			t.Fatal(err)
		}
	})
	t.Run("failed member insert rolls back pair and chat", func(t *testing.T) {
		if _, err := db.Exec(`CREATE FUNCTION history.reject_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-storage-error'; END $$; CREATE TRIGGER reject_member BEFORE INSERT ON history.chat_members FOR EACH ROW EXECUTE FUNCTION history.reject_member()`); err != nil {
			t.Fatal(err)
		}
		create(tokenB, `{"user_id":"`+userC+`"}`, 503)
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM history.chats`).Scan(&count); err != nil || count != 2 {
			t.Fatal("transaction left an orphan", count, err)
		}
	})
}
