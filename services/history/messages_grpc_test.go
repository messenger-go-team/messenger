package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"github.com/messenger-go-team/messenger/services/history/internal/messages"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type savedFixture struct {
	result messages.Saved
	err    error
}

func (s savedFixture) Save(context.Context, messages.Input) (messages.Saved, error) {
	return s.result, s.err
}
func TestSaveMessageErrorContract(t *testing.T) {
	req := &historyv1.SaveMessageRequest{ChatId: userA, SenderId: userB, ClientMsgId: userC, Body: "hello"}
	for _, tc := range []struct {
		err  error
		code codes.Code
	}{
		{messages.ErrInvalid, codes.InvalidArgument}, {messages.ErrChatNotFound, codes.NotFound}, {messages.ErrNotMember, codes.PermissionDenied}, {messages.ErrConflict, codes.AlreadyExists}, {messages.ErrSeqExhausted, codes.OutOfRange}, {context.Canceled, codes.Canceled}, {context.DeadlineExceeded, codes.DeadlineExceeded}, {errors.New("private SQL/DSN credential detail"), codes.Unavailable},
	} {
		server := &historyGRPC{messages: savedFixture{err: tc.err}}
		out, err := server.SaveMessage(t.Context(), req)
		if out != nil || status.Code(err) != tc.code {
			t.Fatal(out, err)
		}
		if strings.Contains(status.Convert(err).Message(), "private") && tc.code == codes.Unavailable {
			t.Fatal("storage diagnostic leaked")
		}
	}
	for _, saved := range []messages.Saved{{ID: userA, Seq: 0, CreatedAt: time.Now()}, {ID: userA, Seq: messages.MaxSeq + 1, CreatedAt: time.Now()}, {ID: "invalid", Seq: 1, CreatedAt: time.Now()}, {ID: userA, Seq: 1, CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}} {
		out, err := (&historyGRPC{messages: savedFixture{result: saved}}).SaveMessage(t.Context(), req)
		if out != nil || status.Code(err) != codes.DataLoss {
			t.Fatal("invalid stored metadata accepted", err)
		}
	}
	out, err := (&historyGRPC{}).SaveMessage(t.Context(), nil)
	if out != nil || status.Code(err) != codes.InvalidArgument {
		t.Fatal("nil request accepted")
	}
	invalid := &historyv1.SaveMessageRequest{ChatId: req.ChatId, SenderId: req.SenderId, ClientMsgId: req.ClientMsgId, Body: string([]byte{0xff})}
	out, err = (&historyGRPC{}).SaveMessage(t.Context(), invalid)
	if out != nil || status.Code(err) != codes.InvalidArgument {
		t.Fatal("invalid UTF-8 accepted")
	}
}
