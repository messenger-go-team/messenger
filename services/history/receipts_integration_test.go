package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"github.com/messenger-go-team/messenger/services/history/internal/postgres"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

const (
	receiptDelivered = historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED
	receiptRead      = historyv1.ReceiptKind_RECEIPT_KIND_READ
)

func startHistoryTestRPC(t *testing.T, repo *postgres.Repository) historyv1.HistoryServiceClient {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	historyv1.RegisterHistoryServiceServer(server, &historyGRPC{repo: repo, presence: repo, receipts: repo, messages: messages.New(repo)})
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return historyv1.NewHistoryServiceClient(conn)
}

func receiptRequest(chat, actor string, seq int64, kind historyv1.ReceiptKind) *historyv1.AdvanceReceiptRequest {
	return &historyv1.AdvanceReceiptRequest{ChatId: chat, ActorId: actor, Seq: &seq, Kind: kind}
}

func receiptCall(t *testing.T, client historyv1.HistoryServiceClient, req *historyv1.AdvanceReceiptRequest, want codes.Code) *historyv1.AdvanceReceiptResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	out, err := client.AdvanceReceipt(ctx, req)
	if status.Code(err) != want || (out != nil) != (want == codes.OK) {
		t.Fatalf("AdvanceReceipt(%v) = %v, %v, want %s", req, out, err, want)
	}
	return out
}

func checkReceiptSnapshot(t *testing.T, f *readingFixture, chat, user string, a, b reading.PublicCursors) {
	t.Helper()
	data := f.request(t, http.MethodGet, "/chats/"+strings.ToUpper(chat)+"/receipts", user, "", http.StatusOK)
	var got reading.ChatReceipts
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&got); err != nil {
		t.Fatalf("invalid snapshot: %v: %s", err, data)
	}
	want := []reading.MemberReceipt{{UserID: userA, PublicCursors: a}, {UserID: userB, PublicCursors: b}}
	if got.ChatID != chat || !slices.Equal(got.Members, want) {
		t.Fatalf("snapshot = %+v, want %s %+v", got, chat, want)
	}
}

func checkPrivateReceipt(t *testing.T, db *sql.DB, chat, user string, wantRead, wantDelivered int64) {
	t.Helper()
	read, delivered := cursorState(t, db, chat, user)
	if read != wantRead || delivered != wantDelivered {
		t.Fatalf("private read/delivered = %d/%d, want %d/%d", read, delivered, wantRead, wantDelivered)
	}
}

func TestReceiptsPreserveMVPReadAndUnread(t *testing.T) {
	f := newReadingFixture(t)
	applyHistoryMigration(t, f.db, "000002_later_entries")
	chat := messageChat(t, f.db, 8, userA, userB)
	for _, entry := range []struct {
		seq    int64
		sender string
	}{{1, userB}, {2, userA}, {3, userB}, {5, userA}, {6, userB}, {8, userB}} {
		f.seed(t, chat, entry.sender, entry.seq, "2026-11-15T12:00:00Z")
	}

	expectUnread := func(want int64) {
		t.Helper()
		var list struct{ Chats []reading.ChatItem }
		if err := json.Unmarshal(f.request(t, "GET", "/chats", userA, "", 200), &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Chats) != 1 || list.Chats[0].ID != chat || list.Chats[0].Unread != want {
			t.Fatalf("chat list = %+v, want unread %d", list, want)
		}
	}
	restRead := func(body string) {
		t.Helper()
		f.request(t, "POST", "/chats/"+chat+"/read", userA, body, 204)
	}
	if _, err := f.db.ExecContext(t.Context(), `UPDATE history.chat_members SET last_delivered_seq=5 WHERE chat_id=$1 AND user_id=$2`, chat, userA); err != nil {
		t.Fatal(err)
	}
	restRead(`{"seq":2}`)
	checkPrivateReceipt(t, f.db, chat, userA, 2, 5)
	expectUnread(3)
	applyHistoryMigration(t, f.db, "000003_public_receipts")
	checkPrivateReceipt(t, f.db, chat, userA, 2, 5)
	expectUnread(3)
	zero := reading.PublicCursors{}
	checkReceiptSnapshot(t, f, chat, userA, zero, zero)
	restRead(`{"seq":3}`)
	checkPrivateReceipt(t, f.db, chat, userA, 3, 5)
	expectUnread(2)
	checkReceiptSnapshot(t, f, chat, userB, zero, zero)

	client := startHistoryTestRPC(t, f.repo)
	advance := func(seq int64, kind historyv1.ReceiptKind, delivered, read int64, advanced bool) {
		t.Helper()
		res := receiptCall(t, client, receiptRequest(chat, userA, seq, kind), codes.OK)
		if res.LastDeliveredSeq != delivered || res.LastReadSeq != read || res.DeliveredAdvanced != advanced {
			t.Fatalf("AdvanceReceipt = %v, want %d/%d advanced=%t", res, delivered, read, advanced)
		}
	}
	advance(0, receiptRead, 0, 0, false)
	advance(4, receiptRead, 4, 4, true) // An allowed cursor in a gap.
	checkPrivateReceipt(t, f.db, chat, userA, 4, 5)
	expectUnread(2)
	advance(8, receiptDelivered, 8, 4, true)
	advance(7, receiptDelivered, 8, 4, false)
	checkPrivateReceipt(t, f.db, chat, userA, 4, 5)
	expectUnread(2)
	advance(6, receiptRead, 8, 6, false)
	advance(6, receiptRead, 8, 6, false)
	advance(1, receiptRead, 8, 6, false)
	checkPrivateReceipt(t, f.db, chat, userA, 6, 6)
	expectUnread(1)

	checkReceiptSnapshot(t, f, chat, userB, reading.PublicCursors{Delivered: 8, Read: 6}, zero)
	checkPrivateReceipt(t, f.db, chat, userA, 6, 6)
	checkPrivateReceipt(t, f.db, chat, userB, 0, 0)
	expectUnread(1)
}

func TestReceiptsAuthorizationBoundsAndFailedWrite(t *testing.T) {
	f := newReadingFixture(t)
	applyHistoryMigration(t, f.db, "000002_later_entries")
	applyHistoryMigration(t, f.db, "000003_public_receipts")
	client := startHistoryTestRPC(t, f.repo)
	chat := messageChat(t, f.db, 2, userA, userB)
	group := messageChat(t, f.db, 2, userA, userB)
	if _, err := f.db.ExecContext(t.Context(), `UPDATE history.chats SET type='group' WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		req  *historyv1.AdvanceReceiptRequest
		code codes.Code
	}{
		{&historyv1.AdvanceReceiptRequest{ChatId: chat, ActorId: userA, Kind: receiptRead}, codes.InvalidArgument},
		{receiptRequest(chat, userA, 0, 42), codes.InvalidArgument},
		{receiptRequest(strings.ToUpper(chat), userA, 0, receiptRead), codes.InvalidArgument},
		{receiptRequest(chat, "00000000-0000-0000-0000-000000000000", 0, receiptRead), codes.InvalidArgument},
		{receiptRequest(missing, userA, 3, receiptRead), codes.NotFound},
		{receiptRequest(chat, userC, 3, receiptRead), codes.PermissionDenied},
		{receiptRequest(group, userC, -1, receiptRead), codes.PermissionDenied},
		{receiptRequest(group, userA, -1, receiptRead), codes.FailedPrecondition},
		{receiptRequest(chat, userA, -1, receiptRead), codes.OutOfRange},
		{receiptRequest(chat, userA, 3, receiptDelivered), codes.OutOfRange},
		{receiptRequest(chat, userA, messages.MaxSeq+1, receiptRead), codes.OutOfRange},
	} {
		receiptCall(t, client, tc.req, tc.code)
	}

	path := "/chats/" + chat + "/receipts"
	f.request(t, "GET", "/chats/bad/receipts?x=%ZZ", "", "", 401)
	for _, query := range []string{"?x=1", "?&", "?x=%ZZ"} {
		f.request(t, "GET", path+query, userA, "", 422)
	}
	f.request(t, "GET", "/chats/bad/receipts", userA, "", 422)
	f.request(t, "GET", "/chats/00000000-0000-0000-0000-000000000000/receipts", userA, "", 422)
	f.request(t, "GET", "/chats/"+missing+"/receipts", userA, "", 404)
	f.request(t, "GET", path, userC, "", 403)
	f.request(t, "GET", "/chats/"+group+"/receipts", userA, "", 422)
	f.request(t, "GET", "/chats/"+group+"/receipts", userC, "", 403)

	if _, err := f.db.ExecContext(t.Context(), `ALTER TABLE history.chat_members ADD CHECK(public_last_read_seq=0)`); err != nil {
		t.Fatal(err)
	}
	receiptCall(t, client, receiptRequest(chat, userA, 1, receiptRead), codes.Unavailable)
	checkReceiptSnapshot(t, f, chat, userA, reading.PublicCursors{}, reading.PublicCursors{})
	checkPrivateReceipt(t, f.db, chat, userA, 0, 0)
}

func TestReceiptsConcurrentWithRESTReadAndSave(t *testing.T) {
	db := laterDatabase(t)
	applyHistoryMigration(t, db, "000003_public_receipts")
	repo := &postgres.Repository{DB: db}
	client := startHistoryTestRPC(t, repo)
	chat := messageChat(t, db, 100, userA, userB)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	start := make(chan struct{})
	var writers sync.WaitGroup
	for seq := int64(1); seq <= 100; seq++ {
		kind := receiptDelivered
		if seq <= 80 {
			kind = receiptRead
		}
		writers.Go(func() {
			<-start
			out, err := client.AdvanceReceipt(ctx, receiptRequest(chat, userA, seq, kind))
			if err != nil {
				t.Error(err)
				return
			}
			if out.LastDeliveredSeq < seq || out.LastDeliveredSeq > 100 ||
				out.LastReadSeq > 80 || out.LastReadSeq > out.LastDeliveredSeq ||
				(kind == receiptRead && out.LastReadSeq < seq) {
				t.Errorf("seq %d kind %s: inconsistent response %v", seq, kind, out)
			}
		})
	}
	writers.Go(func() {
		<-start
		if err := repo.MarkRead(ctx, chat, userA, 90); err != nil {
			t.Error(err)
		}
	})
	key := messageKey(t)
	writers.Go(func() {
		<-start
		out, err := client.SaveMessage(ctx, &historyv1.SaveMessageRequest{
			ChatId: chat, SenderId: userA, ClientMsgId: key, Body: "concurrent save",
		})
		if err != nil || out.Seq != 101 {
			t.Errorf("save = %v, %v", out, err)
		}
	})
	close(start)
	writers.Wait()

	for _, kind := range []historyv1.ReceiptKind{receiptDelivered, receiptRead} {
		out := receiptCall(t, client, receiptRequest(chat, userA, 79, kind), codes.OK)
		if out.LastDeliveredSeq != 100 || out.LastReadSeq != 80 || out.DeliveredAdvanced {
			t.Fatalf("after concurrent writes: %v", out)
		}
	}
	checkPrivateReceipt(t, db, chat, userA, 90, 90)
	members, err := repo.Receipts(t.Context(), chat, userB)
	want := []reading.MemberReceipt{{UserID: userA, PublicCursors: reading.PublicCursors{Delivered: 100, Read: 80}}, {UserID: userB}}
	if err != nil || !slices.Equal(members, want) {
		t.Fatalf("snapshot after concurrent writes: %+v, %v", members, err)
	}
	checkPrivateReceipt(t, db, chat, userB, 0, 0)
}
