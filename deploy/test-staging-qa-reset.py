"""Run the staging QA reset against a disposable PostgreSQL with no network."""
import json
from pathlib import Path
import secrets
import subprocess
import time

RUN = "testqa"
ALICE = "00000000-0000-0000-0000-000000000001"
BOB = "00000000-0000-0000-0000-000000000002"
CAROL = "00000000-0000-0000-0000-000000000003"
TARGET = "00000000-0000-0000-0000-000000000010"
CONTROL = "00000000-0000-0000-0000-000000000020"
TARGET_MESSAGE = "00000000-0000-0000-0000-000000000101"
MIGRATIONS_V2 = (
    "services/auth/migrations/000001_initial_schema.up.sql",
    "services/history/migrations/000001_initial_schema.up.sql",
    "services/history/migrations/000002_later_entries.up.sql",
)
MIGRATIONS_V4 = (
    *MIGRATIONS_V2,
    "services/history/migrations/000003_public_receipts.up.sql",
    "services/history/migrations/000004_presence_delivery.up.sql",
)
PRESENCE_TABLE = "history.presence_deliveries"
TABLES = (
    "auth.users", "history.chats", "history.chat_members",
    "history.personal_chat_pairs", "history.messages", "history.later_entries",
)

# Only Docker metadata and transport are stubbed. exec runs the original psql command
# against the isolated server via its Unix socket. The host Docker socket is absent.
DOCKER_SHIM = """#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --host && $2 == "unix:///run/user/$(id -u)/docker.sock" ]]
shift 2
case "$1" in
  info) printf '%s\\n' '["name=rootless"]' ;;
  inspect) printf '%s\\n' 'messenger36-stage/postgres' ;;
  compose)
    [[ $2 == --project-name && $3 == messenger36-stage ]]
    shift 9
    case "$1 $2 $3" in
      'ps -q postgres') printf '%s\\n' 'test-postgres' ;;
      'exec -T postgres') shift 3; exec "$@" ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
"""

OPERATOR_SETUP = """set -eu
adduser -D messenger-stage
root=/home/messenger-stage/messenger36-stage
socket_dir="/run/user/$(id -u messenger-stage)"
mkdir -p "$root/.release-state" "$socket_dir" /opt/messenger-rootless/bin
touch "$root/.release-state/lock"
chown -R messenger-stage "$root"
ln -s /var/run/postgresql/.s.PGSQL.5432 "$socket_dir/docker.sock"
cat > /opt/messenger-rootless/bin/docker
chmod 755 /opt/messenger-rootless/bin/docker
"""


def wait_for_postgres(container):
    for _ in range(60):
        probe = subprocess.run(
            ["docker", "exec", container, "pg_isready", "-h", "127.0.0.1",
             "-U", "postgres", "-d", "messenger_stage"],
            capture_output=True,
        )
        if probe.returncode == 0:
            return
        time.sleep(0.25)
    raise RuntimeError("Disposable PostgreSQL did not become ready")


def seed(sql):
    sql(f"""
        INSERT INTO auth.users (id, username, username_normalized, password_hash) VALUES
          ('{ALICE}', 'qa38_{RUN}_a', 'qa38_{RUN}_a', 'unused'),
          ('{BOB}', 'qa38_{RUN}_b', 'qa38_{RUN}_b', 'unused'),
          ('{CAROL}', 'qa38_{RUN}_c', 'qa38_{RUN}_c', 'unused');
        INSERT INTO history.chats (id, type, last_seq) VALUES
          ('{TARGET}', 'personal', 2), ('{CONTROL}', 'personal', 1);
        INSERT INTO history.chat_members (chat_id, user_id, role) VALUES
          ('{TARGET}', '{ALICE}', 'member'), ('{TARGET}', '{BOB}', 'member'),
          ('{CONTROL}', '{ALICE}', 'member'), ('{CONTROL}', '{CAROL}', 'member');
        INSERT INTO history.personal_chat_pairs (chat_id, user_low_id, user_high_id) VALUES
          ('{TARGET}', '{ALICE}', '{BOB}'), ('{CONTROL}', '{ALICE}', '{CAROL}');
        INSERT INTO history.messages (id, chat_id, seq, sender_id, client_msg_id, body) VALUES
          ('{TARGET_MESSAGE}', '{TARGET}', 1, '{ALICE}', gen_random_uuid(), 'QA first'),
          (gen_random_uuid(), '{TARGET}', 2, '{BOB}', gen_random_uuid(), 'QA second'),
          (gen_random_uuid(), '{CONTROL}', 1, '{ALICE}', gen_random_uuid(), 'keep this');
        INSERT INTO history.later_entries (user_id, message_id)
          SELECT '{ALICE}', id FROM history.messages
          WHERE id = '{TARGET_MESSAGE}' OR chat_id = '{CONTROL}';
    """)


def snapshot(sql, tables):
    return {
        table: json.loads(sql(f"""
            SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)), '[]'::jsonb)
            FROM {table} AS t;
        """))
        for table in tables
    }


def verify_reset(sql, reset, *, with_presence):
    tables = TABLES
    if with_presence:
        tables = (*tables, PRESENCE_TABLE)
        # No release or cleanup worker runs here. The DELETE must wait for
        # the v4 fallback, and the grant for the unrelated chat must survive.
        sql(f"""
            INSERT INTO {PRESENCE_TABLE} (chat_id, grant_id) VALUES
              ('{TARGET}', gen_random_uuid()), ('{CONTROL}', gen_random_uuid());
        """)

    before = snapshot(sql, tables)
    preview = reset("--preview")
    assert preview.stdout.splitlines()[-1] == "ROLLBACK", preview.stdout
    assert any([column.strip() for column in line.split("|")] == [TARGET, "2", "1"]
               for line in preview.stdout.splitlines()), preview.stdout
    assert snapshot(sql, tables) == before, "Preview changed database rows"
    print("PASS: preview reports target and counts and preserves all rows")

    sql(f"INSERT INTO history.later_entries (user_id, message_id)"
        f" VALUES ('{CAROL}', '{TARGET_MESSAGE}');")
    before_rejection = snapshot(sql, tables)
    rejected = reset("--apply", check=False)
    assert rejected.returncode != 0, rejected.stdout
    assert "refusing reset: found a Later entry owned by another user" in rejected.stderr, rejected.stderr
    assert snapshot(sql, tables) == before_rejection, "Rejected reset changed database rows"
    print("PASS: apply refuses a foreign Later entry and preserves all rows")

    sql(f"DELETE FROM history.later_entries WHERE user_id = '{CAROL}'"
        f" AND message_id = '{TARGET_MESSAGE}';")
    applied = reset("--apply")
    assert applied.stdout.splitlines()[-1] == "COMMIT", applied.stdout
    target_messages = {m["id"] for m in before["history.messages"] if m["chat_id"] == TARGET}
    expected = {
        "auth.users": before["auth.users"],
        "history.chats": [row for row in before["history.chats"] if row["id"] != TARGET],
        "history.chat_members": [row for row in before["history.chat_members"] if row["chat_id"] != TARGET],
        "history.personal_chat_pairs": [
            row for row in before["history.personal_chat_pairs"] if row["chat_id"] != TARGET
        ],
        "history.messages": [row for row in before["history.messages"] if row["chat_id"] != TARGET],
        "history.later_entries": [
            row for row in before["history.later_entries"] if row["message_id"] not in target_messages
        ],
    }
    if with_presence:
        expected[PRESENCE_TABLE] = [
            row for row in before[PRESENCE_TABLE] if row["chat_id"] != TARGET
        ]
    assert snapshot(sql, tables) == expected, "Apply must delete only the QA chat and its dependencies"
    print("PASS: apply removes only the QA chat, messages, membership, pair and Later entry")
    if with_presence:
        print("PASS: v4 apply removes only the target presence reservation without a release")


def test_reset(migrations, *, with_presence):
    print(f"Testing QA reset on History {'v4' if with_presence else 'v2'}", flush=True)
    container = "messenger-qa-reset-test-" + secrets.token_hex(6)
    subprocess.run([
        "docker", "run", "--rm", "--detach", "--network", "none", "--name", container,
        "-e", "POSTGRES_DB=messenger_stage", "-e", "POSTGRES_USER=postgres",
        "-e", "POSTGRES_PASSWORD=local-test-only",
        "postgres:18-alpine",
    ], check=True, stdout=subprocess.DEVNULL)
    try:
        wait_for_postgres(container)

        def sql(source):
            return subprocess.run([
                "docker", "exec", "-i", container, "psql", "-XqAt", "-U", "postgres",
                "-d", "messenger_stage", "-v", "ON_ERROR_STOP=1",
            ], input=source, text=True, check=True, stdout=subprocess.PIPE).stdout.strip()

        for migration in migrations:
            sql(Path(migration).read_text(encoding="utf-8"))
        seed(sql)
        subprocess.run(["docker", "exec", "-i", container, "sh", "-ec", OPERATOR_SETUP],
                       input=DOCKER_SHIM, text=True, check=True)
        subprocess.run(["docker", "cp", "deploy/staging-qa-reset.sh",
                        f"{container}:/tmp/staging-qa-reset.sh"], check=True)

        def reset(mode, check=True):
            result = subprocess.run([
                "docker", "exec", "--user", "messenger-stage", container,
                "bash", "/tmp/staging-qa-reset.sh", mode, RUN, ALICE, BOB, TARGET,
            ], text=True, capture_output=True, timeout=30)
            if check and result.returncode != 0:
                raise AssertionError(f"{mode} failed ({result.returncode}):\n{result.stdout}{result.stderr}")
            return result

        verify_reset(sql, reset, with_presence=with_presence)
    finally:
        subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    test_reset(MIGRATIONS_V2, with_presence=False)
    test_reset(MIGRATIONS_V4, with_presence=True)
