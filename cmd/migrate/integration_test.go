package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
)

func captureMigrationOutput(t *testing.T, call func() error) (string, error) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = original; _ = reader.Close(); _ = writer.Close() }()
	callErr := call()
	_ = writer.Close()
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(output), callErr
}

// These tests create and remove their own databases, never application tables in
// the database named by MIGRATE_TEST_DATABASE_URL. The connecting role needs CREATEDB.
func newMigrationTestDatabase(t *testing.T) (databaseConfig, *sql.DB) {
	t.Helper()
	u, err := url.Parse(os.Getenv("MIGRATE_TEST_DATABASE_URL"))
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.User == nil || u.Hostname() == "" {
		t.Fatal("MIGRATE_TEST_DATABASE_URL must be a postgres URL with a host and user")
	}
	admin, err := sql.Open("postgres", u.String())
	if err != nil {
		t.Fatal("open migration test admin connection:", err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		t.Fatal("connect to migration test PostgreSQL:", err)
	}
	name := fmt.Sprintf("messenger_migrate_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+pq.QuoteIdentifier(name)); err != nil {
		t.Fatal("create isolated test database:", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP DATABASE " + pq.QuoteIdentifier(name) + " WITH (FORCE)"); err != nil {
			t.Error("remove isolated test database:", err)
		}
	})
	u.Path = "/" + name
	db, err := sql.Open("postgres", u.String())
	if err != nil {
		t.Fatal("open isolated test database:", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	sslMode := u.Query().Get("sslmode")
	if sslMode == "" {
		sslMode = "disable"
	}
	password, _ := u.User.Password()
	return databaseConfig{
		host: u.Hostname(), port: port, name: name,
		user: u.User.Username(), password: password, sslMode: sslMode,
	}, db
}

func execMigrationTestSQL(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal("execute test SQL:", err)
	}
}

func assertMigrationTestInt(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatal("query test state:", err)
	}
	if got != want {
		t.Fatalf("query %q = %d, want %d", query, got, want)
	}
}

func TestMigrationsIntegration(t *testing.T) {
	if os.Getenv("MIGRATE_TEST_DATABASE_URL") == "" {
		t.Skip("set MIGRATE_TEST_DATABASE_URL to run PostgreSQL migration tests")
	}
	t.Chdir("../..")

	t.Run("round trip and constraints", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		apply := func(service, direction string) {
			t.Helper()
			if err := migrateService(service, direction, 1, config); err != nil {
				t.Fatal(err)
			}
		}
		apply("auth", directionUp)
		apply("auth", directionUp)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_class WHERE relname = 'history_schema_migrations'", 0)
		apply("history", directionUp)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('auth', 'history')", 7)
		for _, service := range services {
			assertMigrationTestInt(t, db, "SELECT count(*) FROM "+service+"_schema_migrations WHERE version = 1 AND NOT dirty", 1)
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation WHERE a.attrelid = 'auth.users'::regclass AND a.attname = 'username_normalized' AND c.collname = 'C'", 1)
		for _, index := range []string{"messages_chat_seq_uq", "messages_idempotency_uq", "chat_members_user_chat_idx"} {
			var definition string
			if err := db.QueryRow("SELECT indexdef FROM pg_indexes WHERE schemaname = 'history' AND indexname = $1", index).Scan(&definition); err != nil {
				t.Fatal("missing index", index, err)
			}
			if index == "messages_chat_seq_uq" && !strings.Contains(definition, "seq DESC") {
				t.Fatal("history index must order seq DESC:", definition)
			}
		}

		execMigrationTestSQL(t, db, `
INSERT INTO auth.users (id, username, username_normalized, password_hash) VALUES
 ('00000000-0000-4000-8000-000000000001', 'Alice_1', 'alice_1', 'test-hash'),
 ('00000000-0000-4000-8000-000000000002', 'bob_2', 'bob_2', 'test-hash'),
 ('00000000-0000-4000-8000-000000000003', 'Zed_1', 'zed_1', 'test-hash');
INSERT INTO auth.contacts (user_id, contact_id) VALUES
 ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003'),
 ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
INSERT INTO history.chats (id, type, last_seq) VALUES
 ('10000000-0000-4000-8000-000000000001', 'personal', 2);
INSERT INTO history.chat_members (chat_id, user_id, role)
 SELECT '10000000-0000-4000-8000-000000000001', id, 'member' FROM auth.users WHERE username <> 'Zed_1';
INSERT INTO history.personal_chat_pairs (user_low_id, user_high_id, chat_id) VALUES
 ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');
INSERT INTO history.messages (id, chat_id, seq, sender_id, client_msg_id, body) VALUES
 ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 1,
  '00000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Привет');`)
		var usernames string
		if err := db.QueryRow(`SELECT string_agg(u.username, ',' ORDER BY u.username_normalized COLLATE "C")
FROM auth.contacts c JOIN auth.users u ON u.id = c.contact_id
WHERE c.user_id = '00000000-0000-4000-8000-000000000001'`).Scan(&usernames); err != nil {
			t.Fatal(err)
		}
		if usernames != "bob_2,Zed_1" {
			t.Fatal("unexpected contact order or username spelling:", usernames)
		}

		messageInsert := `INSERT INTO history.messages (chat_id, seq, sender_id, client_msg_id, body) VALUES
('10000000-0000-4000-8000-000000000001', %s, '%s', %s, %s)`
		alice := "00000000-0000-4000-8000-000000000001"
		for _, tc := range []struct {
			name, query, code string
		}{
			{"case insensitive username", `INSERT INTO auth.users (username, username_normalized, password_hash) VALUES ('ALICE_1', 'alice_1', 'hash')`, "23505"},
			{"normalization mismatch", `INSERT INTO auth.users (username, username_normalized, password_hash) VALUES ('Other_1', 'wrong', 'hash')`, "23514"},
			{"non ASCII username", `INSERT INTO auth.users (username, username_normalized, password_hash) VALUES ('Алиса', 'алиса', 'hash')`, "23514"},
			{"duplicate contact", `INSERT INTO auth.contacts SELECT user_id, contact_id, now() FROM auth.contacts LIMIT 1`, "23505"},
			{"self contact", `INSERT INTO auth.contacts (user_id, contact_id) VALUES ('` + alice + `', '` + alice + `')`, "23514"},
			{"duplicate personal pair", `INSERT INTO history.personal_chat_pairs SELECT * FROM history.personal_chat_pairs`, "23505"},
			{"duplicate seq", fmt.Sprintf(messageInsert, "1", alice, "gen_random_uuid()", "'text'"), "23505"},
			{"duplicate client_msg_id", fmt.Sprintf(messageInsert, "2", alice, "'30000000-0000-4000-8000-000000000001'", "'text'"), "23505"},
			{"non member sender", fmt.Sprintf(messageInsert, "2", "00000000-0000-4000-8000-000000000003", "gen_random_uuid()", "'text'"), "23503"},
			{"seq above safe integer", fmt.Sprintf(messageInsert, "9007199254740992", alice, "gen_random_uuid()", "'text'"), "23514"},
			{"zero message seq", fmt.Sprintf(messageInsert, "0", alice, "gen_random_uuid()", "'text'"), "23514"},
			{"last_seq above safe integer", `UPDATE history.chats SET last_seq = 9007199254740992`, "23514"},
			{"delivery above safe integer", `UPDATE history.chat_members SET last_delivered_seq = 9007199254740992`, "23514"},
			{"read above safe integer", `UPDATE history.chat_members SET last_read_seq = 9007199254740992`, "23514"},
			{"read exceeds delivered", `UPDATE history.chat_members SET last_read_seq = 1`, "23514"},
			{"empty message", fmt.Sprintf(messageInsert, "2", alice, "gen_random_uuid()", "''"), "23514"},
			{"4097 code points", fmt.Sprintf(messageInsert, "2", alice, "gen_random_uuid()", "repeat('😀', 4097)"), "23514"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, err := db.Exec(tc.query)
				var pgErr *pq.Error
				if !errors.As(err, &pgErr) || string(pgErr.Code) != tc.code {
					t.Fatalf("SQL error = %v, want SQLSTATE %s", err, tc.code)
				}
			})
		}
		_, err := db.Exec(fmt.Sprintf(messageInsert, "2", alice, "gen_random_uuid()", "$1"), "a\x00b")
		var pgErr *pq.Error
		if !errors.As(err, &pgErr) || pgErr.Code != "22021" {
			t.Fatalf("U+0000 error = %v, want invalid encoding SQLSTATE 22021", err)
		}
		execMigrationTestSQL(t, db, fmt.Sprintf(messageInsert, "2", alice, "gen_random_uuid()", "repeat('😀', 4096)"))
		execMigrationTestSQL(t, db, `UPDATE history.chat_members SET last_read_seq = GREATEST(last_read_seq, 2), last_delivered_seq = GREATEST(last_delivered_seq, 2)`)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history.chat_members WHERE last_read_seq = 2 AND last_delivered_seq = 2", 2)
		execMigrationTestSQL(t, db, `DELETE FROM auth.contacts`)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history.messages", 2)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history.chat_members", 2)

		apply("auth", directionDown)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history.messages", 2)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history_schema_migrations WHERE version = 1 AND NOT dirty", 1)
		apply("history", directionDown)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('auth', 'history')", 0)
		for _, service := range services {
			apply(service, directionUp)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM "+service+"_schema_migrations WHERE version = 1 AND NOT dirty", 1)
		}
	})

	t.Run("rollback preserves unexpected objects", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		if err := migrateService("history", directionUp, 1, config); err != nil {
			t.Fatal(err)
		}
		execMigrationTestSQL(t, db, "CREATE TABLE history.unrelated (id integer)")
		if err := migrateService("history", directionDown, 1, config); err == nil {
			t.Fatal("down must fail rather than cascade to an unexpected object")
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'history'", 5)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM history_schema_migrations WHERE dirty", 1)
		output, err := captureMigrationOutput(t, func() error { return migrateService("history", directionVersion, 1, config) })
		if err != nil || !strings.Contains(output, "version=-1 dirty=true") {
			t.Fatalf("version after failed rollback = %q, %v", output, err)
		}
	})

	t.Run("search path does not change migration journal", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		execMigrationTestSQL(t, db, "CREATE SCHEMA alternate")
		for _, service := range services {
			execMigrationTestSQL(t, db, "ALTER DATABASE "+pq.QuoteIdentifier(config.name)+" SET search_path TO public")
			if err := migrateService(service, directionUp, 1, config); err != nil {
				t.Fatal(err)
			}
			execMigrationTestSQL(t, db, "ALTER DATABASE "+pq.QuoteIdentifier(config.name)+" SET search_path TO alternate, public")
			output, err := captureMigrationOutput(t, func() error { return migrateService(service, directionVersion, 1, config) })
			if err != nil || !strings.Contains(output, "version=1 dirty=false") {
				t.Fatalf("version = %q, %v", output, err)
			}
			output, err = captureMigrationOutput(t, func() error { return migrateService(service, directionUp, 1, config) })
			if err != nil || !strings.Contains(output, "no changes") {
				t.Fatalf("repeat up = %q, %v", output, err)
			}
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema='alternate'", 0)
	})

	t.Run("too many rollback steps preserve data and version", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		for _, service := range services {
			if err := migrateService(service, directionUp, 1, config); err != nil {
				t.Fatal(err)
			}
		}
		execMigrationTestSQL(t, db, "INSERT INTO auth.users(username, username_normalized, password_hash) VALUES ('alice', 'alice', 'hash')")
		for _, service := range services {
			if err := migrateService(service, directionDown, 2, config); err == nil {
				t.Fatal("too many steps must fail")
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM public."+service+"_schema_migrations WHERE version=1 AND NOT dirty", 1)
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM auth.users", 1)
		// all must preflight history before deleting the valid auth target.
		execMigrationTestSQL(t, db, "UPDATE public.history_schema_migrations SET dirty=true")
		t.Setenv("POSTGRES_HOST", config.host)
		t.Setenv("POSTGRES_PORT", config.port)
		t.Setenv("POSTGRES_DB", config.name)
		t.Setenv("POSTGRES_USER", config.user)
		t.Setenv("POSTGRES_PASSWORD", config.password)
		t.Setenv("POSTGRES_SSLMODE", config.sslMode)
		if err := run("all", directionDown, 1); err == nil {
			t.Fatal("all must reject dirty history in preflight")
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM auth.users", 1)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM public.auth_schema_migrations WHERE version=1 AND NOT dirty", 1)
	})

	t.Run("concurrent rollback serializes validation and execution", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		if err := migrateService("auth", directionUp, 1, config); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		for range 2 {
			go func() { <-start; results <- migrateService("auth", directionDown, 1, config) }()
		}
		close(start)
		first, second := <-results, <-results
		if (first == nil) == (second == nil) {
			t.Fatalf("want one successful down and one preflight rejection: %v, %v", first, second)
		}
		assertMigrationTestInt(t, db, "SELECT count(*) FROM public.auth_schema_migrations", 0)
		assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_namespace WHERE nspname='auth'", 0)
	})

	t.Run("existing schemas remain owned by their creator", func(t *testing.T) {
		config, db := newMigrationTestDatabase(t)
		for _, service := range services {
			execMigrationTestSQL(t, db, "CREATE SCHEMA "+service+"; COMMENT ON SCHEMA "+service+" IS 'pre-existing-marker'")
			if err := migrateService(service, directionUp, 1, config); err == nil {
				t.Fatal("up must reject existing schema")
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_namespace WHERE nspname='"+service+"' AND obj_description(oid,'pg_namespace')='pre-existing-marker'", 1)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema='"+service+"'", 0)
			if err := migrateService(service, directionDown, 1, config); err == nil {
				t.Fatal("dirty schema cannot be rolled back")
			}
		}
	})

	t.Run("migration path contains URL metacharacters", func(t *testing.T) {
		config, _ := newMigrationTestDatabase(t)
		root, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(t.TempDir(), "project # review % space")
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(root, "services"), filepath.Join(dir, "services")); err != nil {
			t.Fatal(err)
		}
		t.Chdir(dir)
		for _, service := range services {
			for _, direction := range []string{directionUp, directionVersion, directionDown} {
				if err := migrateService(service, direction, 1, config); err != nil {
					t.Fatal(err)
				}
			}
		}
	})
}
