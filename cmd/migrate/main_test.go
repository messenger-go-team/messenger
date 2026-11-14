package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lib/pq"
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

func TestCLIConnectionParametersDoNotLeakPassword(t *testing.T) {
	for _, tc := range []struct{ name, variable, value string }{
		{"invalid port", "POSTGRES_PORT", "not-a-port"},
		{"port too high", "POSTGRES_PORT", "65536"},
		{"zero port", "POSTGRES_PORT", "0"},
		{"negative port", "POSTGRES_PORT", "-1"},
		{"host contains space", "POSTGRES_HOST", "bad host"},
		{"host contains tab", "POSTGRES_HOST", "bad\thost"},
		{"host contains URL delimiter", "POSTGRES_HOST", "bad#host"},
		{"invalid IPv6", "POSTGRES_HOST", "bad:host"},
		{"invalid sslmode", "POSTGRES_SSLMODE", "unsupported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(dir, "services", "auth", "migrations"), 0700); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestCLIProcess$")
			command.Dir = dir
			command.Env = append(os.Environ(), "MIGRATE_CLI_TEST_HELPER=1", "MIGRATE_CLI_TEST_ARGS=-service=auth -direction=version", "POSTGRES_HOST=127.0.0.1", "POSTGRES_PORT=1", "POSTGRES_DB=postgres", "POSTGRES_USER=postgres", "POSTGRES_PASSWORD=fake-secret-marker", "POSTGRES_SSLMODE=disable", tc.variable+"="+tc.value)
			output, err := command.CombinedOutput()
			if err == nil || !strings.Contains(string(output), tc.variable) || strings.Contains(string(output), "fake-secret-marker") || strings.Contains(string(output), "postgres://") {
				t.Fatalf("unsafe or missing diagnostic: output=%q error=%v", output, err)
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

func TestValidConnectionParameters(t *testing.T) {
	for _, host := range []string{"localhost", "postgres-service", "postgres_service", "127.0.0.1", "::1", "2001:db8::1", "fe80::1%eth0"} {
		for _, port := range []string{"1", "5432", "65535"} {
			for _, mode := range []string{"disable", "require", "verify-ca", "verify-full"} {
				config := databaseConfig{host: host, port: port, name: "messenger", user: "user@example", password: "pa:ss/@word", sslMode: mode}
				if err := config.validate(); err != nil {
					t.Fatalf("valid host=%s port=%s mode=%s: %v", host, port, mode, err)
				}
				if _, err := pq.NewConnector(config.url()); err != nil {
					t.Fatalf("valid connection URL for host=%s: %v", host, err)
				}
			}
		}
	}
}
