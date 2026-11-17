package chats

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

var (
	ErrInvalid     = errors.New("invalid request")
	ErrNotFound    = errors.New("resource not found")
	ErrForbidden   = errors.New("not a chat member")
	ErrUnavailable = errors.New("dependency unavailable")
	ErrIdentity    = errors.New("user identity unavailable")
)
var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func NormalizeID(s string) (string, error) {
	if !uuid.MatchString(s) {
		return "", ErrInvalid
	}
	return strings.ToLower(s), nil
}
func ValidRPCID(s string) bool {
	id, err := NormalizeID(s)
	return err == nil && id == s && s != "00000000-0000-0000-0000-000000000000"
}

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}
type Chat struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"created_at"`
	Members   []User    `json:"members"`
	LastSeq   int64     `json:"last_seq"`
}
type Repository interface {
	Personal(context.Context, string, string) (Chat, bool, error)
	Members(context.Context, string, string) ([]string, error)
	Membership(context.Context, string, string) (bool, error)
}
type Users interface {
	Lookup(context.Context, string) (User, error)
}
type Service struct {
	Repo  Repository
	Users Users
}

func (s *Service) Create(ctx context.Context, owner, peer string) (Chat, bool, error) {
	owner, err := NormalizeID(owner)
	if err != nil {
		return Chat{}, false, ErrIdentity
	}
	peer, err = NormalizeID(peer)
	if err != nil || owner == peer {
		return Chat{}, false, ErrInvalid
	}
	a, err := s.Users.Lookup(ctx, owner)
	if errors.Is(err, ErrNotFound) {
		err = ErrIdentity
	}
	if err != nil {
		return Chat{}, false, err
	}
	b, err := s.Users.Lookup(ctx, peer)
	if err != nil {
		return Chat{}, false, err
	}
	chat, created, err := s.Repo.Personal(ctx, owner, peer)
	if err != nil {
		return Chat{}, false, err
	}
	chat.Members = []User{a, b}
	if a.ID > b.ID {
		chat.Members = []User{b, a}
	}
	return chat, created, nil
}
