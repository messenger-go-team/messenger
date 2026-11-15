package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

func messageKey(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
func messageChat(t *testing.T, db *sql.DB, initial int64, a, b string) string {
	t.Helper()
	var id string
	if err := db.QueryRowContext(t.Context(), `INSERT INTO history.chats(type,last_seq) VALUES('personal',$1) RETURNING id`, initial).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO history.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')`, id, a, b); err != nil {
		t.Fatal(err)
	}
	return id
}
func assertMessageCounts(t *testing.T, db *sql.DB, chat string, last, count int64) {
	t.Helper()
	var gotLast, gotCount int64
	if err := db.QueryRowContext(t.Context(), `SELECT last_seq,(SELECT count(*) FROM history.messages WHERE chat_id=$1) FROM history.chats WHERE id=$1`, chat).Scan(&gotLast, &gotCount); err != nil {
		t.Fatal(err)
	}
	if gotLast != last || gotCount != count {
		t.Fatalf("last_seq=%d/messages=%d, want %d/%d", gotLast, gotCount, last, count)
	}
}
func waitMessageQuery(t *testing.T, db *sql.DB, prefix string, want bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := db.QueryRowContext(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)`, prefix+"%").Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("database did not reach expected lock-wait state")
}
func TestSaveMessageIntegration(t *testing.T) {
	db := historyDatabase(t)
	db.SetMaxOpenConns(16)
	repo := &postgres.Repository{DB: db}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var loseReply atomic.Bool
	lost := make(chan *historyv1.SaveMessageResponse, 1)
	rpc := grpc.NewServer(grpc.ChainUnaryInterceptor(rpcLogging(newLogger(io.Discard, "history", 0)), func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		response, err := handler(ctx, req)
		if err == nil && strings.HasSuffix(info.FullMethod, "/SaveMessage") && loseReply.CompareAndSwap(true, false) {
			lost <- response.(*historyv1.SaveMessageResponse)
			return nil, status.Error(codes.Unavailable, "simulated lost response after commit")
		}
		return response, err
	}))
	historyv1.RegisterHistoryServiceServer(rpc, &historyGRPC{repo: repo, messages: messages.New(repo)})
	go func() { _ = rpc.Serve(listener) }()
	defer rpc.Stop()
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	client := historyv1.NewHistoryServiceClient(conn)
	request := func(chat, sender, key, body string) *historyv1.SaveMessageRequest {
		return &historyv1.SaveMessageRequest{ChatId: chat, SenderId: sender, ClientMsgId: key, Body: body}
	}
	call := func(t *testing.T, r *historyv1.SaveMessageRequest, want codes.Code) *historyv1.SaveMessageResponse {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		out, err := client.SaveMessage(ctx, r)
		if status.Code(err) != want {
			t.Fatalf("SaveMessage code=%s want=%s: %v", status.Code(err), want, err)
		}
		if want != codes.OK {
			if out != nil {
				t.Fatal("error returned message data")
			}
			return nil
		}
		if out == nil || !chats.ValidRPCID(out.MessageId) || out.Seq < 1 || out.Seq > messages.MaxSeq || out.CreatedAt.CheckValid() != nil {
			t.Fatal("invalid committed metadata", out)
		}
		return out
	}
	same := func(t *testing.T, a, b *historyv1.SaveMessageResponse) {
		t.Helper()
		if a.MessageId != b.MessageId || a.Seq != b.Seq || !proto.Equal(a.CreatedAt, b.CreatedAt) {
			t.Fatal("duplicate changed original metadata")
		}
	}
	t.Run("first save exact body retry conflict", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		key := messageKey(t)
		body := " \te\u0301\n🙂 "
		first := call(t, request(chat, userA, key, body), codes.OK)
		if first.Duplicate || first.Seq != 1 {
			t.Fatal(first)
		}
		var stored string
		var created time.Time
		if err := db.QueryRow(`SELECT body,created_at FROM history.messages WHERE id=$1`, first.MessageId).Scan(&stored, &created); err != nil || stored != body || !created.Equal(first.CreatedAt.AsTime()) {
			t.Fatal("stored body/time changed", err)
		}
		repeat := call(t, request(chat, userA, key, body), codes.OK)
		same(t, first, repeat)
		if !repeat.Duplicate {
			t.Fatal("retry not marked duplicate")
		}
		call(t, request(chat, userA, key, "e\u0301"), codes.AlreadyExists)
		assertMessageCounts(t, db, chat, 1, 1)
	})
	t.Run("100 concurrent unique messages from both senders", func(t *testing.T) {
		const n = 100
		chat := messageChat(t, db, 7, userA, userB)
		type result struct {
			out *historyv1.SaveMessageResponse
			err error
		}
		results := make(chan result, n)
		start := make(chan struct{})
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		for i := range n {
			key := messageKey(t)
			sender := userA
			if i%2 == 1 {
				sender = userB
			}
			go func() {
				<-start
				out, err := client.SaveMessage(ctx, request(chat, sender, key, "hello"))
				results <- result{out, err}
			}()
		}
		close(start)
		seqs := make([]int, 0, n)
		ids := map[string]bool{}
		for range n {
			r := <-results
			if r.err != nil || r.out == nil {
				t.Fatal(r.err)
			}
			if r.out.Duplicate || ids[r.out.MessageId] {
				t.Fatal("duplicate new message")
			}
			ids[r.out.MessageId] = true
			seqs = append(seqs, int(r.out.Seq))
		}
		sort.Ints(seqs)
		for i, s := range seqs {
			if s != 8+i {
				t.Fatalf("seq=%d at %d", s, i)
			}
		}
		assertMessageCounts(t, db, chat, 7+n, n)
	})
	t.Run("concurrent same key creates exactly one message", func(t *testing.T) {
		const n = 40
		chat := messageChat(t, db, 0, userA, userB)
		key := messageKey(t)
		type result struct {
			out *historyv1.SaveMessageResponse
			err error
		}
		results := make(chan result, n)
		start := make(chan struct{})
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		for range n {
			go func() {
				<-start
				out, err := client.SaveMessage(ctx, request(chat, userA, key, "same"))
				results <- result{out, err}
			}()
		}
		close(start)
		var original *historyv1.SaveMessageResponse
		created := 0
		for range n {
			r := <-results
			if r.err != nil || r.out == nil {
				t.Fatal(r.err)
			}
			if original == nil {
				original = r.out
			}
			same(t, original, r.out)
			if !r.out.Duplicate {
				created++
			}
		}
		if created != 1 {
			t.Fatal("expected exactly one first save", created)
		}
		assertMessageCounts(t, db, chat, 1, 1)
	})
	t.Run("concurrent conflicting bodies leave winner unchanged", func(t *testing.T) {
		const n = 32
		chat := messageChat(t, db, 0, userA, userB)
		key := messageKey(t)
		type result struct {
			body string
			out  *historyv1.SaveMessageResponse
			err  error
		}
		results := make(chan result, n)
		start := make(chan struct{})
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		for i := range n {
			body := "first"
			if i%2 == 1 {
				body = "second"
			}
			go func() {
				<-start
				out, err := client.SaveMessage(ctx, request(chat, userA, key, body))
				results <- result{body, out, err}
			}()
		}
		close(start)
		got := make([]result, 0, n)
		for range n {
			got = append(got, <-results)
		}
		var winner string
		if err := db.QueryRow(`SELECT body FROM history.messages WHERE chat_id=$1`, chat).Scan(&winner); err != nil {
			t.Fatal(err)
		}
		initial := 0
		for _, r := range got {
			if r.body == winner {
				if r.err != nil || r.out == nil {
					t.Fatal(r.err)
				}
				if !r.out.Duplicate {
					initial++
				}
			} else if status.Code(r.err) != codes.AlreadyExists || r.out != nil {
				t.Fatal("conflict leaked success", r.err)
			}
		}
		if initial != 1 {
			t.Fatal("multiple winning inserts")
		}
		assertMessageCounts(t, db, chat, 1, 1)
	})
	t.Run("key scoped to sender and chat", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		other := messageChat(t, db, 0, userA, userC)
		key := messageKey(t)
		a := call(t, request(chat, userA, key, "a"), codes.OK)
		b := call(t, request(chat, userB, key, "b"), codes.OK)
		c := call(t, request(other, userA, key, "c"), codes.OK)
		if a.MessageId == b.MessageId || a.MessageId == c.MessageId || b.MessageId == c.MessageId || b.Seq != 2 || c.Seq != 1 {
			t.Fatal("keys merged across sender/chat")
		}
	})
	t.Run("validation before storage and current membership", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		for _, body := range []string{"", " \n\u00a0\u3000", "a\x00b", strings.Repeat("🙂", 4097)} {
			call(t, request(chat, userA, messageKey(t), body), codes.InvalidArgument)
		}
		for _, r := range []*historyv1.SaveMessageRequest{request(strings.ToUpper(chat), userA, messageKey(t), "x"), request(chat, userA, "23968cc7-c30c-17b0-a741-6b81249aa5e7", "x"), request(chat, "00000000-0000-0000-0000-000000000000", messageKey(t), "x")} {
			call(t, r, codes.InvalidArgument)
		}
		call(t, request(missing, userA, messageKey(t), "x"), codes.NotFound)
		call(t, request(chat, userC, messageKey(t), "x"), codes.PermissionDenied)
		assertMessageCounts(t, db, chat, 0, 0)
		body := strings.Repeat("🙂", 4096)
		out := call(t, request(chat, userA, messageKey(t), body), codes.OK)
		var stored string
		if err := db.QueryRow(`SELECT body FROM history.messages WHERE id=$1`, out.MessageId).Scan(&stored); err != nil || stored != body {
			t.Fatal("Unicode length/storage mismatch", err)
		}
		call(t, request(chat, userA, messageKey(t), `literal \u0000`), codes.OK)
	})
	t.Run("limit allows duplicate and conflict but not new sequence", func(t *testing.T) {
		chat := messageChat(t, db, messages.MaxSeq-1, userA, userB)
		key := messageKey(t)
		original := call(t, request(chat, userA, key, "last"), codes.OK)
		if original.Seq != messages.MaxSeq {
			t.Fatal(original)
		}
		duplicate := call(t, request(chat, userA, key, "last"), codes.OK)
		same(t, original, duplicate)
		if !duplicate.Duplicate {
			t.Fatal("retry at max rejected")
		}
		call(t, request(chat, userA, key, "different"), codes.AlreadyExists)
		call(t, request(chat, userA, messageKey(t), "overflow"), codes.OutOfRange)
		assertMessageCounts(t, db, chat, messages.MaxSeq, 1)
	})
	t.Run("lost response after commit is recovered by identical retry", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		key := messageKey(t)
		loseReply.Store(true)
		call(t, request(chat, userA, key, "committed"), codes.Unavailable)
		original := <-lost
		assertMessageCounts(t, db, chat, 1, 1)
		retry := call(t, request(chat, userA, key, "committed"), codes.OK)
		same(t, original, retry)
		if !retry.Duplicate {
			t.Fatal("lost reply produced a second insert")
		}
	})

	t.Run("insert and deferred commit failure roll back counter", func(t *testing.T) {
		if _, err := db.Exec(`CREATE FUNCTION history.fail_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='fail-insert' THEN RAISE EXCEPTION 'private-insert-detail'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_message_insert BEFORE INSERT ON history.messages FOR EACH ROW EXECUTE FUNCTION history.fail_message_insert()`); err != nil {
			t.Fatal(err)
		}
		chat := messageChat(t, db, 9, userA, userB)
		key := messageKey(t)
		call(t, request(chat, userA, key, "fail-insert"), codes.Unavailable)
		assertMessageCounts(t, db, chat, 9, 0)
		if _, err := db.Exec(`DROP TRIGGER fail_message_insert ON history.messages`); err != nil {
			t.Fatal(err)
		}
		saved := call(t, request(chat, userA, key, "after rollback"), codes.OK)
		if saved.Seq != 10 || saved.Duplicate {
			t.Fatal(saved)
		}
		if _, err := db.Exec(`CREATE FUNCTION history.fail_message_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='fail-commit' THEN RAISE EXCEPTION 'private-commit-detail'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER fail_message_commit AFTER INSERT ON history.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION history.fail_message_commit()`); err != nil {
			t.Fatal(err)
		}
		key = messageKey(t)
		call(t, request(chat, userA, key, "fail-commit"), codes.Unavailable)
		assertMessageCounts(t, db, chat, 10, 1)
		if _, err := db.Exec(`DROP TRIGGER fail_message_commit ON history.messages`); err != nil {
			t.Fatal(err)
		}
		saved = call(t, request(chat, userA, key, "fail-commit"), codes.OK)
		if saved.Seq != 11 || saved.Duplicate {
			t.Fatal("commit failure reserved a seq/key", saved)
		}
	})
	t.Run("membership removed while save waits is checked again", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		before, err := client.CheckMembership(t.Context(), &historyv1.CheckMembershipRequest{ChatId: chat, UserId: userA})
		if err != nil || !before.IsMember {
			t.Fatal(before, err)
		}
		tx, err := db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback() }()
		if _, err = tx.ExecContext(t.Context(), `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userA); err != nil {
			t.Fatal(err)
		}
		results := make(chan error, 1)
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		key := messageKey(t)
		go func() { _, err := client.SaveMessage(ctx, request(chat, userA, key, "blocked sender")); results <- err }()
		waitMessageQuery(t, db, "SELECT 1 FROM history.chat_members", true)
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if err = <-results; status.Code(err) != codes.PermissionDenied {
			t.Fatal("stale membership authorized a write", err)
		}
		assertMessageCounts(t, db, chat, 0, 0)
	})
	t.Run("membership cannot disappear during insert", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		if _, err := db.Exec(`CREATE FUNCTION history.pause_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='lock-membership' THEN PERFORM pg_advisory_xact_lock(290029); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_message BEFORE INSERT ON history.messages FOR EACH ROW EXECUTE FUNCTION history.pause_message()`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := db.Exec(`DROP TRIGGER pause_message ON history.messages`); err != nil {
				t.Error(err)
			}
		}()
		gate, err := db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Rollback() }()
		if _, err = gate.ExecContext(t.Context(), `SELECT pg_advisory_xact_lock(290029)`); err != nil {
			t.Fatal(err)
		}
		results := make(chan error, 1)
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		key := messageKey(t)
		go func() {
			_, err := client.SaveMessage(ctx, request(chat, userA, key, "lock-membership"))
			results <- err
		}()
		waitMessageQuery(t, db, "INSERT INTO history.messages", true)
		short, stop := context.WithTimeout(t.Context(), 100*time.Millisecond)
		_, err = db.ExecContext(short, `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userA)
		stop()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("membership deletion was not blocked by the save", err)
		}
		if err = gate.Rollback(); err != nil {
			t.Fatal(err)
		}
		if err = <-results; err != nil {
			t.Fatal(err)
		}
		assertMessageCounts(t, db, chat, 1, 1)
	})
	t.Run("deadline cancels SQL while waiting for the chat", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		gate, err := db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Rollback() }()
		var last int64
		if err = gate.QueryRowContext(t.Context(), `SELECT last_seq FROM history.chats WHERE id=$1 FOR UPDATE`, chat).Scan(&last); err != nil {
			t.Fatal(err)
		}
		results := make(chan error, 1)
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		key := messageKey(t)
		go func() { _, err := client.SaveMessage(ctx, request(chat, userA, key, "deadline")); results <- err }()
		waitMessageQuery(t, db, "SELECT last_seq FROM history.chats", true)
		if err = <-results; status.Code(err) != codes.DeadlineExceeded {
			t.Fatal(err)
		}
		// Observe DB cancellation before releasing the lock; cancellation alone
		// is not proof of rollback once a transaction could have reached commit.
		waitMessageQuery(t, db, "SELECT last_seq FROM history.chats", false)
		assertMessageCounts(t, db, chat, 0, 0)
		if err = gate.Rollback(); err != nil {
			t.Fatal(err)
		}
		out := call(t, request(chat, userA, key, "deadline"), codes.OK)
		if out.Duplicate || out.Seq != 1 {
			t.Fatal(out)
		}
	})
	t.Run("storage failure is unavailable with no message data", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		if _, err := db.Exec(`ALTER TABLE history.messages RENAME TO unavailable_messages`); err != nil {
			t.Fatal(err)
		}
		call(t, request(chat, userA, messageKey(t), "storage outage"), codes.Unavailable)
		if err := repo.Ready(t.Context()); err == nil {
			t.Fatal("readiness ignored missing messages")
		}
		if _, err := db.Exec(`ALTER TABLE history.unavailable_messages RENAME TO messages`); err != nil {
			t.Fatal(err)
		}
		if err := repo.Ready(t.Context()); err != nil {
			t.Fatal("readiness did not recover", err)
		}
		assertMessageCounts(t, db, chat, 0, 0)
	})
	t.Run("duplicate rechecks revoked membership before reading original", func(t *testing.T) {
		chat := messageChat(t, db, 0, userA, userB)
		key := messageKey(t)
		call(t, request(chat, userA, key, "original private body"), codes.OK)
		// The MVP FK prevents normal removal of a sender with stored messages.
		// Relax it only in this disposable DB to test the contract's revoked
		// membership state while retaining the original idempotency record.
		if _, err := db.Exec(`ALTER TABLE history.messages DROP CONSTRAINT messages_sender_membership_fk`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, chat, userA); err != nil {
			t.Fatal(err)
		}
		call(t, request(chat, userA, key, "original private body"), codes.PermissionDenied)
		call(t, request(chat, userA, key, "changed private body"), codes.PermissionDenied)
		assertMessageCounts(t, db, chat, 1, 1)
	})
}
