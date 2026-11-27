package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func checkInternalAuth(args []string) error {
	if len(args) != 1 || !uuid.MatchString(args[0]) {
		return fmt.Errorf("usage: auth-check USER")
	}
	secret := os.Getenv("AUTH_INTERNAL_TOKEN")
	if secret == "" {
		return fmt.Errorf("missing isolated QA service token")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	tests := []struct {
		label, host, user, bearer string
		status                    int
	}{
		{"public gateway", "gateway:8080", args[0], "", 404},
		{"internal without token", "auth:8080", args[0], "", 401},
		{"internal wrong token", "auth:8080", args[0], "qa-invalid-token", 401},
		{"internal valid token", "auth:8080", args[0], secret, 200},
		{"internal unknown user", "auth:8080", "00000000-0000-0000-0000-000000000000", secret, 404},
		{"internal invalid user", "auth:8080", "not-a-uuid", secret, 404},
	}
	for _, tc := range tests {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+tc.host+"/internal/users/"+tc.user, nil)
		if err != nil {
			return err
		}
		if tc.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+tc.bearer)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, 16*1024))
		_ = res.Body.Close()
		if err != nil {
			return err
		}
		if res.StatusCode != tc.status {
			return fmt.Errorf("%s: expected HTTP %d, got %d", tc.label, tc.status, res.StatusCode)
		}
		if tc.status == http.StatusOK {
			var user map[string]string
			if json.Unmarshal(data, &user) != nil || len(user) != 2 || user["id"] != args[0] || user["username"] == "" {
				return fmt.Errorf("internal response differs from UserSummary")
			}
		}
		fmt.Printf("%s: HTTP %d\n", tc.label, res.StatusCode)
	}
	return nil
}
