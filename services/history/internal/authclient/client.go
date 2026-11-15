package authclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

type Client struct {
	base, secret string
	http         *http.Client
}

func New(base, secret string) *Client {
	return &Client{base: strings.TrimRight(base, "/"), secret: secret, http: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

var username = regexp.MustCompile(`^[A-Za-z0-9_]{3,32}$`)

func (c *Client) Lookup(ctx context.Context, id string) (chats.User, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/internal/users/"+url.PathEscape(id), nil)
	if err != nil {
		return chats.User{}, chats.ErrUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+c.secret)
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return chats.User{}, ctx.Err()
		}
		return chats.User{}, chats.ErrUnavailable
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == 404 {
		return chats.User{}, chats.ErrNotFound
	}
	if res.StatusCode != 200 {
		return chats.User{}, chats.ErrUnavailable
	}
	var user chats.User
	dec := json.NewDecoder(io.LimitReader(res.Body, 65537))
	dec.DisallowUnknownFields()
	if dec.Decode(&user) != nil || user.ID != id || !username.MatchString(user.Username) {
		return chats.User{}, chats.ErrUnavailable
	}
	if dec.Decode(new(any)) != io.EOF {
		return chats.User{}, chats.ErrUnavailable
	}
	return user, nil
}
