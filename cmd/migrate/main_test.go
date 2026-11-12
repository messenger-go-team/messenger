package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIProcess(t *testing.T) {
	if os.Getenv("MIGRATE_CLI_TEST_HELPER") != "1" {
		return
	}
	os.Args = append([]string{"migrate"}, strings.Fields(os.Getenv("MIGRATE_CLI_TEST_ARGS"))...)
	main()
}

func TestCLIRejectsUnsafeInput(t *testing.T) {
	for _, tc := range []struct{ name, dotenv, args, want string }{
		{"broken dotenv", "BROKEN!VAR=x\nPOSTGRES_PASSWORD=fake-secret-marker\n", "", "could not load .env"},
		{"implicit down", "", "-direction=down", "down requires explicit service"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(tc.dotenv), 0600); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestCLIProcess$")
			command.Dir = dir
			command.Env = append(os.Environ(), "MIGRATE_CLI_TEST_HELPER=1", "MIGRATE_CLI_TEST_ARGS="+tc.args)
			output, err := command.CombinedOutput()
			if err == nil || !strings.Contains(string(output), tc.want) || strings.Contains(string(output), "fake-secret-marker") {
				t.Fatalf("CLI output = %q, error = %v", output, err)
			}
		})
	}
}

func TestSelectedServices(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		service string
		want    []string
		wantErr string
	}{
		{name: "all", service: "all", want: []string{"auth", "history"}},
		{name: "auth", service: "auth", want: []string{"auth"}},
		{name: "unknown", service: "chat", wantErr: "unknown service"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := selectedServices(tt.service)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("selectedServices(%q) error = %v, want error containing %q", tt.service, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("selectedServices(%q) unexpected error: %v", tt.service, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("selectedServices(%q) = %v, want %v", tt.service, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("selectedServices(%q) = %v, want %v", tt.service, got, tt.want)
				}
			}
		})
	}
}

func TestDatabaseURL(t *testing.T) {
	t.Parallel()

	config := databaseConfig{
		host:     "localhost",
		port:     "15432",
		name:     "messenger",
		user:     "user@example",
		password: "pa:ss/@word",
		sslMode:  "disable",
	}

	got := config.url()
	if !strings.Contains(got, "user%40example:pa%3Ass%2F%40word@localhost:15432") {
		t.Fatalf("url() = %q, credentials must be escaped", got)
	}
	if !strings.Contains(got, "sslmode=disable") {
		t.Fatalf("url() = %q, missing sslmode", got)
	}
}
