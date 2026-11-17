package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLaterMigrationUpgrade(t *testing.T) {
	if os.Getenv("MIGRATE_TEST_DATABASE_URL") == "" {
		t.Skip("set MIGRATE_TEST_DATABASE_URL for migration integration")
	}
	t.Chdir("../..")
	files := map[string][]byte{}
	for _, name := range []string{"000001_initial_schema.up.sql", "000001_initial_schema.down.sql", "000002_later_entries.up.sql", "000002_later_entries.down.sql"} {
		data, err := os.ReadFile(filepath.Join("services/history/migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = data
	}
	for _, fail := range []bool{false, true} {
		name := "v1 data survives upgrade and one-step rollback"
		if fail {
			name = "DDL failure rolls back owned objects"
		}
		t.Run(name, func(t *testing.T) {
			config, db := newMigrationTestDatabase(t)
			root := t.TempDir()
			dir := filepath.Join(root, "services/history/migrations")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"000001_initial_schema.up.sql", "000001_initial_schema.down.sql"} {
				if err := os.WriteFile(filepath.Join(dir, name), files[name], 0600); err != nil {
					t.Fatal(err)
				}
			}
			t.Chdir(root)
			if err := migrateService("history", directionUp, 1, config); err != nil {
				t.Fatal(err)
			}
			execMigrationTestSQL(t, db, `INSERT INTO history.chats(id,type,last_seq)VALUES('10000000-0000-4000-8000-000000000001','personal',1);
    INSERT INTO history.chat_members(chat_id,user_id,role)VALUES('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member');
    INSERT INTO history.messages(id,chat_id,sender_id,client_msg_id,seq,body)VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',gen_random_uuid(),1,'keep existing history')`)
			if fail {
				execMigrationTestSQL(t, db, `CREATE TABLE history.later_entries_active_uq(marker integer); INSERT INTO history.later_entries_active_uq VALUES(42)`)
			}
			for _, name := range []string{"000002_later_entries.up.sql", "000002_later_entries.down.sql"} {
				if err := os.WriteFile(filepath.Join(dir, name), files[name], 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := migrateService("history", directionUp, 1, config)
			if fail {
				if err == nil {
					t.Fatal("expected index-name collision to abort migration")
				}
				assertMigrationTestInt(t, db, "SELECT count(*) FROM history.messages", 1)
				assertMigrationTestInt(t, db, "SELECT count(*) FROM history.later_entries_active_uq WHERE marker=42", 1)
				assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema='history' AND table_name='later_entries'", 0)
				assertMigrationTestInt(t, db, "SELECT count(*) FROM public.history_schema_migrations WHERE version=2 AND dirty", 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = migrateService("history", directionUp, 1, config); err != nil {
				t.Fatal("repeat up", err)
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM public.history_schema_migrations WHERE version=2 AND NOT dirty", 1)
			// No auth schema exists: owner UUIDs cannot introduce cross-service FK.
			execMigrationTestSQL(t, db, `INSERT INTO history.later_entries(user_id,message_id)VALUES('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001')`)
			if err = migrateService("history", directionDown, 1, config); err != nil {
				t.Fatal(err)
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM public.history_schema_migrations WHERE version=1 AND NOT dirty", 1)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM history.messages WHERE body='keep existing history'", 1)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM history.chats WHERE last_seq=1", 1)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM information_schema.tables WHERE table_schema='history' AND table_name='later_entries'", 0)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_indexes WHERE schemaname='history' AND indexname LIKE 'later_entries_%'", 0)
			if err = migrateService("history", directionUp, 1, config); err != nil {
				t.Fatal(err)
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM history.later_entries", 0)
			assertMigrationTestInt(t, db, "SELECT count(*) FROM history.messages", 1)
			if err = migrateService("history", directionDown, 2, config); err != nil {
				t.Fatal(err)
			}
			assertMigrationTestInt(t, db, "SELECT count(*) FROM pg_namespace WHERE nspname='history'", 0)
		})
	}
}
