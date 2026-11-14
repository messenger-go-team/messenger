package auth

import (
	"context"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messenger-go-team/messenger/pkg/jwtauth"
)

// Service issues access JWTs and owns authentication rules, not SQL or cookies.
type Service struct {
	repo      Repository
	key       []byte
	passwords passwords
	dummyHash string
}

type AccessToken struct {
	TokenType   string `json:"token_type"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

// Session's refresh credential must be sent only via the HttpOnly cookie.
type Session struct {
	Access  AccessToken
	Refresh string `json:"-"`
}

func NewService(repo Repository, secret string) (*Service, error) {
	if _, err := jwtauth.New(secret); err != nil {
		return nil, err
	}
	s := &Service{repo: repo, key: []byte(secret), passwords: passwords{slots: make(chan struct{}, 4)}}
	var err error
	// A dummy hash hides the cheap unknown-username path from login requests.
	s.dummyHash, err = s.passwords.hash(context.Background(), "dummy password never used to authenticate")
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) Register(ctx context.Context, username, password string) (User, error) {
	if _, err := ValidateCredentials(username, password); err != nil {
		return User{}, err
	}
	hash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return User{}, err
	}
	return s.repo.CreateUser(ctx, username, hash)
}

func (s *Service) Login(ctx context.Context, username, password string) (Session, error) {
	normalized, err := ValidateCredentials(username, password)
	if err != nil {
		return Session{}, err
	}
	account, err := s.repo.FindAccount(ctx, normalized)
	missing := errors.Is(err, ErrUserNotFound)
	if err != nil && !missing {
		return Session{}, err
	}
	hash := account.PasswordHash
	if missing {
		hash = s.dummyHash
	}
	match, err := s.passwords.compare(ctx, hash, password)
	if err != nil {
		return Session{}, err
	}
	if missing || !match {
		return Session{}, ErrInvalidCredentials
	}
	raw, digest, err := GenerateRefresh()
	if err != nil {
		return Session{}, err
	}
	access, err := s.issue(account.ID)
	if err != nil {
		return Session{}, err
	}
	if err := s.repo.CreateRefresh(ctx, account.ID, digest, RefreshLifetime); err != nil {
		return Session{}, err
	}
	return Session{Access: access, Refresh: raw}, nil
}

func (s *Service) Refresh(ctx context.Context, raw string) (Session, error) {
	previous, err := HashRefresh(raw)
	if err != nil {
		return Session{}, err
	}
	next, digest, err := GenerateRefresh()
	if err != nil {
		return Session{}, err
	}
	user, err := s.repo.RotateRefresh(ctx, previous, digest, RefreshLifetime)
	if err != nil {
		return Session{}, err
	}
	access, err := s.issue(user.ID)
	if err != nil {
		return Session{}, err
	}
	return Session{Access: access, Refresh: next}, nil
}

func (s *Service) Logout(ctx context.Context, raw string) error {
	digest, err := HashRefresh(raw)
	if err != nil {
		return err
	}
	return s.repo.RevokeRefresh(ctx, digest)
}

func (s *Service) issue(userID string) (AccessToken, error) {
	now := time.Now().UTC().Truncate(time.Second)
	claims := jwt.RegisteredClaims{Subject: userID, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(AccessLifetime))}
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.key)
	if err != nil {
		return AccessToken{}, err
	}
	return AccessToken{TokenType: "Bearer", AccessToken: raw, ExpiresIn: 900}, nil
}
