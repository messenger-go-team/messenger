package auth

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

var ErrInvalidIdentity = errors.New("user identity no longer exists")

type UserSummary struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

// DirectoryRepository accesses public profiles and directed contacts only.
// Session/password operations stay in Repository.
type DirectoryRepository interface {
	GetUser(context.Context, string) (User, error)
	SearchUsers(context.Context, string) ([]UserSummary, error)
	ListContacts(context.Context, string) ([]UserSummary, error)
	AddContact(context.Context, string, string) error
	RemoveContact(context.Context, string, string) error
}

type Directory struct{ repo DirectoryRepository }

func NewDirectory(repo DirectoryRepository) *Directory { return &Directory{repo: repo} }

var userUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func NormalizeUserID(raw string) (string, error) {
	if !userUUID.MatchString(raw) {
		return "", &ValidationError{Details: []FieldError{{Field: "contact_id", Reason: "Ожидается UUID пользователя."}}}
	}
	return strings.ToLower(raw), nil
}

func (d *Directory) Me(ctx context.Context, owner string) (User, error) {
	user, err := d.repo.GetUser(ctx, owner)
	if errors.Is(err, ErrUserNotFound) {
		return User{}, ErrInvalidIdentity
	}
	return user, err
}

func (d *Directory) Search(ctx context.Context, owner, prefix string) ([]UserSummary, error) {
	if len(prefix) < 1 || len(prefix) > 32 {
		return nil, invalidPrefix()
	}
	for _, b := range []byte(prefix) {
		switch {
		case b >= 'A' && b <= 'Z', b >= 'a' && b <= 'z', b >= '0' && b <= '9', b == '_':
		default:
			return nil, invalidPrefix()
		}
	}
	if _, err := d.Me(ctx, owner); err != nil {
		return nil, err
	}
	return d.repo.SearchUsers(ctx, strings.ToLower(prefix))
}
func invalidPrefix() error {
	return &ValidationError{Details: []FieldError{{Field: "prefix", Reason: "Длина 1-32 символа; допустимы латинские буквы, цифры и подчёркивание."}}}
}

func (d *Directory) Contacts(ctx context.Context, owner string) ([]UserSummary, error) {
	if _, err := d.Me(ctx, owner); err != nil {
		return nil, err
	}
	return d.repo.ListContacts(ctx, owner)
}
func (d *Directory) AddContact(ctx context.Context, owner, raw string) error {
	contact, err := NormalizeUserID(raw)
	if err != nil {
		return err
	}
	if strings.EqualFold(owner, contact) {
		return &ValidationError{Details: []FieldError{{Field: "contact_id", Reason: "Нельзя добавить себя в контакты."}}}
	}
	if _, err := d.Me(ctx, owner); err != nil {
		return err
	}
	return d.repo.AddContact(ctx, owner, contact)
}
func (d *Directory) RemoveContact(ctx context.Context, owner, raw string) error {
	contact, err := NormalizeUserID(raw)
	if err != nil {
		return err
	}
	if _, err := d.Me(ctx, owner); err != nil {
		return err
	}
	return d.repo.RemoveContact(ctx, owner, contact)
}

// Lookup exposes only the fields required by another service. Invalid IDs are
// not found, matching the internal operation's documented 404 response.
func (d *Directory) Lookup(ctx context.Context, raw string) (UserSummary, error) {
	id, err := NormalizeUserID(raw)
	if err != nil {
		return UserSummary{}, ErrUserNotFound
	}
	user, err := d.repo.GetUser(ctx, id)
	if err != nil {
		return UserSummary{}, err
	}
	return UserSummary{ID: user.ID, Username: user.Username}, nil
}
