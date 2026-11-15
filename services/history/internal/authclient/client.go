package authclient

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

type Client struct {
	base, secret string
	http         *http.Client
}

func New(base, secret string) *Client {
	// Internal credentials must never pass through HTTP_PROXY/HTTPS_PROXY.
	// Do not inherit the mutable process-wide DefaultTransport.
	transport := &http.Transport{
		Proxy:             nil,
		DialContext:       (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2: true, MaxIdleConns: 16, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 3 * time.Second,
	}
	return &Client{base: strings.TrimRight(base, "/"), secret: secret, http: &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

var username = regexp.MustCompile(`^[A-Za-z0-9_]{3,32}$`)

type apiError struct {
	Code      string  `json:"code"`
	Message   *string `json:"message"`
	RequestID string  `json:"request_id"`
	Details   []struct {
		Field  *string `json:"field"`
		Reason *string `json:"reason"`
	} `json:"details"`
}

func decodeJSON(data []byte, v any) bool {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(v) == nil && dec.Decode(new(any)) == io.EOF
}
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
	if res.StatusCode != 200 && res.StatusCode != 404 {
		return chats.User{}, chats.ErrUnavailable
	}
	media, _, err := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return chats.User{}, chats.ErrUnavailable
	}
	const limit = 64 << 10
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || len(data) > limit || !utf8.Valid(data) {
		return chats.User{}, chats.ErrUnavailable
	}
	if res.StatusCode == 404 {
		var response apiError
		if !decodeJSON(data, &response) || response.Code != "user_not_found" || response.Message == nil {
			return chats.User{}, chats.ErrUnavailable
		}
		for _, detail := range response.Details {
			if detail.Field == nil || detail.Reason == nil {
				return chats.User{}, chats.ErrUnavailable
			}
		}
		return chats.User{}, chats.ErrNotFound
	}
	var user chats.User
	if !decodeJSON(data, &user) || user.ID != id || !username.MatchString(user.Username) {
		return chats.User{}, chats.ErrUnavailable
	}
	return user, nil
}
