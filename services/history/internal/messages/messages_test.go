package messages

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

const chat = "23968cc7-c30c-47b0-a741-6b81249aa5e7"
const user = "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0"
const client = "cc6ac191-7856-4a41-8a1f-59c49af76ec0"

func TestValidateMessage(t *testing.T) {
	in := Input{chat, user, client, "hello"}
	for _, body := range []string{"hello", " \nhello\t ", "🙂", strings.Repeat("🙂", 4096), `literal \u0000`, "e\u0301", "\u200b"} {
		v := in
		v.Body = body
		if Validate(v) != nil {
			t.Errorf("valid body rejected: %q", body[:min(40, len(body))])
		}
	}
	for _, body := range []string{"", " \t\n\r\u0085\u00a0\u2000\u2028\u2029\u3000", "a\x00b", string([]byte{0xff}), strings.Repeat("🙂", 4097)} {
		v := in
		v.Body = body
		if Validate(v) == nil {
			t.Error("invalid body accepted")
		}
	}
	for _, id := range []string{"", "bad", strings.ToUpper(chat), "00000000-0000-0000-0000-000000000000"} {
		v := in
		v.ChatID = id
		if Validate(v) == nil {
			t.Error("invalid chat UUID accepted")
		}
		v = in
		v.SenderID = id
		if Validate(v) == nil {
			t.Error("invalid sender UUID accepted")
		}
	}
	for _, id := range []string{"", strings.ToUpper(client), "cc6ac191-7856-1a41-8a1f-59c49af76ec0", "cc6ac191-7856-4a41-7a1f-59c49af76ec0"} {
		v := in
		v.ClientID = id
		if Validate(v) == nil {
			t.Error("non-v4/canonical client ID accepted")
		}
	}
}

type captureRepository struct {
	got   Input
	calls int
}

func (r *captureRepository) Save(_ context.Context, in Input) (Saved, error) {
	r.calls++
	r.got = in
	return Saved{}, nil
}
func TestServicePreservesExactBody(t *testing.T) {
	r := &captureRepository{}
	service := New(r)
	in := Input{chat, user, client, " \te\u0301\n🙂 "}
	if _, err := service.Save(t.Context(), in); err != nil || r.got != in {
		t.Fatal("service changed the original message", err)
	}
	in.Body = "\x00"
	if _, err := service.Save(t.Context(), in); err != ErrInvalid || r.calls != 1 {
		t.Fatal("invalid message reached storage")
	}
}

// The service must preserve repository error identity for the gRPC mapping.
// SQL idempotency/authorization is verified separately against PostgreSQL.
type saveFunc func(context.Context, Input) (Saved, error)

func (f saveFunc) Save(ctx context.Context, in Input) (Saved, error) { return f(ctx, in) }

func TestSaveRepositoryBoundary(t *testing.T) {
	for _, failure := range []error{nil, ErrChatNotFound, ErrNotMember, ErrConflict, ErrSeqExhausted, context.Canceled, context.DeadlineExceeded} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			in := Input{chat, user, client, "  exact original 🙂  "}
			want := Saved{ID: client, Seq: MaxSeq, CreatedAt: time.Date(2026, 11, 17, 0, 0, 0, 123456000, time.UTC), Duplicate: true}
			if failure != nil {
				want = Saved{}
			}
			calls := 0
			s := New(saveFunc(func(got context.Context, input Input) (Saved, error) {
				calls++
				if got != ctx || input != in {
					t.Fatal("save changed context or input")
				}
				return want, failure
			}))
			out, err := s.Save(ctx, in)
			if !errors.Is(err, failure) || out != want || calls != 1 {
				t.Fatal(out, err, calls)
			}
		})
	}
}
