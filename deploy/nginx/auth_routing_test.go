package nginx_test

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Run against an isolated Auth database: this test creates two accounts.
func TestAuthRouting(t *testing.T) {
	edge := strings.TrimRight(os.Getenv("AUTH_NGINX_TEST_URL"), "/")
	if edge == "" {
		t.Skip("set AUTH_NGINX_TEST_URL to run the real Nginx/Auth routing test")
	}
	direct := strings.TrimRight(os.Getenv("AUTH_DIRECT_TEST_URL"), "/")
	secret := os.Getenv("AUTH_INTERNAL_TOKEN")
	if direct == "" || secret == "" {
		t.Fatal("AUTH_DIRECT_TEST_URL and AUTH_INTERNAL_TOKEN are required")
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request := func(method, base, path, token string, body any, want int) []byte {
		t.Helper()
		var encoded []byte
		if body != nil {
			var err error
			encoded, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		req, err := http.NewRequestWithContext(t.Context(), method, base+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s failed: %v", method, path, err)
		}
		defer func() { _ = resp.Body.Close() }()
		data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			t.Errorf("%s %s: status %d, want %d", method, path, resp.StatusCode, want)
		}
		// Never print response bodies or credentials, including on failure.
		if strings.Contains(string(data), secret) {
			t.Errorf("%s %s disclosed a service credential", method, path)
		}
		return data
	}
	decode := func(data []byte, dst any) {
		t.Helper()
		if err := json.Unmarshal(data, dst); err != nil {
			t.Fatal("response is not the expected JSON")
		}
	}
	suffix := strings.ToLower(rand.Text()[:12])
	password := rand.Text()
	ownerName := "route_" + suffix + "_a"
	contactName := "route_" + suffix + "_b"
	register := func(name string) string {
		t.Helper()
		data := request(http.MethodPost, edge, "/auth/register", "",
			map[string]string{"username": name, "password": password}, http.StatusCreated)
		var user struct {
			ID string `json:"id"`
		}
		decode(data, &user)
		if user.ID == "" {
			t.Fatal("register returned no user ID")
		}
		return user.ID
	}
	ownerID := register(ownerName)
	contactID := register(contactName)
	data := request(http.MethodPost, edge, "/auth/login", "",
		map[string]string{"username": ownerName, "password": password}, http.StatusOK)
	var session struct {
		Token string `json:"access_token"`
	}
	decode(data, &session)
	if session.Token == "" {
		t.Fatal("login returned no access token")
	}
	contacts := func(wantContact bool) {
		t.Helper()
		var list struct {
			Contacts []struct {
				ID string `json:"id"`
			} `json:"contacts"`
		}
		decode(request(http.MethodGet, edge, "/contacts", session.Token, nil, http.StatusOK), &list)
		if wantContact {
			if len(list.Contacts) != 1 || list.Contacts[0].ID != contactID {
				t.Error("contact must remain present after the request")
			}
		} else if list.Contacts == nil || len(list.Contacts) != 0 {
			t.Error("contact list must remain empty after the request")
		}
	}
	valid := "/contacts/" + contactID
	malformed := []string{
		"/contacts/x%2F..%2F" + contactID,
		"/contacts/x%2f..%2f" + contactID,
		"/contacts/x%252F..%252F" + contactID,
		"/contacts/x%2F..%2F..%2Fme",
		"/contacts/x%2F..%2F..%2Fusers%2Fsearch",
		"/contacts/x%2F..%2F..%2Fcontacts",
	}
	contacts(false)
	for _, path := range malformed {
		request(http.MethodPut, direct, path, session.Token, nil, http.StatusUnprocessableEntity)
		contacts(false)
		request(http.MethodPut, edge, path, session.Token, nil, http.StatusUnprocessableEntity)
		contacts(false)
		request(http.MethodPut, edge, valid, session.Token, nil, http.StatusNoContent)
		contacts(true)
		request(http.MethodDelete, direct, path, session.Token, nil, http.StatusUnprocessableEntity)
		contacts(true)
		request(http.MethodDelete, edge, path, session.Token, nil, http.StatusUnprocessableEntity)
		contacts(true)
		request(http.MethodDelete, edge, valid, session.Token, nil, http.StatusNoContent)
		contacts(false)
	}
	// A normalized /auth/login must not accept an originally different path.
	for _, base := range []string{direct, edge} {
		request(http.MethodPost, base, "/auth/x%2F..%2Flogin", "",
			map[string]string{"username": ownerName, "password": password}, http.StatusNotFound)
	}
	var me struct {
		ID string `json:"id"`
	}
	decode(request(http.MethodGet, edge, "/me", session.Token, nil, http.StatusOK), &me)
	if me.ID != ownerID {
		t.Error("proxy changed the authenticated user")
	}
	request(http.MethodGet, edge, "/users/search?prefix="+contactName, session.Token, nil, http.StatusOK)
	internal := "/internal/users/" + contactID
	var user map[string]any
	decode(request(http.MethodGet, direct, internal, secret, nil, http.StatusOK), &user)
	if len(user) != 2 || user["id"] != contactID || user["username"] != contactName {
		t.Error("internal lookup must return only public id and username")
	}
	request(http.MethodGet, direct, internal, session.Token, nil, http.StatusUnauthorized)
	request(http.MethodGet, edge, "/me", secret, nil, http.StatusUnauthorized)
	for _, path := range []string{
		"/internal", internal, "/internal%2Fusers%2F" + contactID,
		"/contacts/x%2F..%2F..%2Finternal%2Fusers%2F" + contactID,
		"/auth/%2e%2e/internal/users/" + contactID,
		"/contacts/%2e%2e/internal/users/" + contactID,
	} {
		request(http.MethodGet, edge, path, secret, nil, http.StatusNotFound)
	}
}
