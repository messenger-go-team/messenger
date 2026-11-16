package messages

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

const MaxSeq int64 = 9007199254740991

var (
	ErrInvalid      = errors.New("invalid message")
	ErrChatNotFound = errors.New("chat not found")
	ErrNotMember    = errors.New("sender is not a member")
	ErrConflict     = errors.New("idempotency conflict")
	ErrSeqExhausted = errors.New("sequence exhausted")
)

type Input struct{ ChatID, SenderID, ClientID, Body string }
type Saved struct {
	ID        string
	Seq       int64
	CreatedAt time.Time
	Duplicate bool
}
type Repository interface {
	Save(context.Context, Input) (Saved, error)
}
type Service struct{ repo Repository }

func New(repo Repository) *Service { return &Service{repo: repo} }
func Validate(in Input) error {
	if !chats.ValidRPCID(in.ChatID) || !chats.ValidRPCID(in.SenderID) || !chats.ValidRPCID(in.ClientID) {
		return ErrInvalid
	}
	if in.ClientID[14] != '4' || !strings.ContainsRune("89ab", rune(in.ClientID[19])) {
		return ErrInvalid
	}
	if !utf8.ValidString(in.Body) || strings.IndexByte(in.Body, 0) >= 0 {
		return ErrInvalid
	}
	n := utf8.RuneCountInString(in.Body)
	if n < 1 || n > 4096 {
		return ErrInvalid
	}
	for _, r := range in.Body {
		if !unicode.IsSpace(r) {
			return nil
		}
	}
	return ErrInvalid
}
func (s *Service) Save(ctx context.Context, in Input) (Saved, error) {
	if err := Validate(in); err != nil {
		return Saved{}, err
	}
	return s.repo.Save(ctx, in)
}
