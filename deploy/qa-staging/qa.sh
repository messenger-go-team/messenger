#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

here=$(cd -- "$(dirname -- "$0")" && pwd -P)
root=$(cd -- "$here/../.." && pwd -P)
env_file=${QA_ENV_FILE:-$here/.env}
project=${QA_COMPOSE_PROJECT:-messenger-qa-staging}

die() { printf 'QA-staging: %s\n' "$*" >&2; exit 1; }
[[ $project =~ ^messenger-qa-staging(-[a-z0-9]+)?$ ]] || die 'expected a QA-only Compose project'
[[ $# -gt 0 ]] || die 'see deploy/qa-staging/README.md'
action=$1
shift

get() { sed -n "s/^$1=//p" "$env_file"; }

if [[ $action == configure ]]; then
    [[ $# -ge 1 && $# -le 2 ]] || die 'usage: configure https://qa.example.org [loopback-port]'
    [[ ! -e $env_file ]] || die 'settings file already exists'
    [[ $1 =~ ^https://[a-zA-Z0-9.-]+$ ]] || die 'use the dedicated QA HTTPS origin without a path'
    port=${2:-19080}
    [[ $port =~ ^[0-9]{4,5}$ ]] && (( 10#$port >= 1024 && 10#$port <= 65535 )) || die 'invalid loopback port'
    revision=$(git -C "$root" rev-parse HEAD)
    install -m 0600 /dev/null "$env_file"
    {
        printf 'QA_REVISION=%s\nQA_ORIGIN=%s\nQA_HTTP_PORT=%s\n' "$revision" "$1" "$port"
        for key in QA_DB_PASSWORD QA_AUTH_DB_PASSWORD QA_HISTORY_DB_PASSWORD QA_JWT_SECRET QA_INTERNAL_TOKEN; do
            printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
        done
    } >"$env_file"
    printf 'Configured %s on loopback port %s\n' "$1" "$port"
    exit
fi

[[ -r $env_file ]] || die 'run configure first'
for key in QA_REVISION QA_ORIGIN QA_HTTP_PORT QA_DB_PASSWORD QA_AUTH_DB_PASSWORD QA_HISTORY_DB_PASSWORD QA_JWT_SECRET QA_INTERNAL_TOKEN; do
    unset "$key"
done

revision=$(get QA_REVISION)
origin=$(get QA_ORIGIN)
[[ $revision =~ ^[0-9a-f]{40}$ ]] || die 'invalid QA SHA'
if [[ $origin != http://127.0.0.1:* && $origin != https://127.0.0.1:* ]]; then
    [[ $(id -un) == messenger-qa ]] || die 'use the dedicated messenger-qa operator account'
    socket="/run/user/$(id -u)/docker.sock"
    [[ -S $socket ]] || die 'QA rootless socket is unavailable'
    unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
    export DOCKER_HOST="unix://$socket"
    security=$(docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}') \
        || die 'unable to query the QA Docker daemon'
    grep -Fxq 'name=rootless' <<<"$security" \
        || die 'the VPS project requires its dedicated rootless Docker daemon'
fi

compose() {
    docker compose --env-file "$env_file" --project-name "$project" --file "$here/compose.yaml" "$@"
}

sql() {
    compose exec -T postgres sh -ec '
        test "$POSTGRES_DB" = messenger_qa
        export PGPASSWORD="$POSTGRES_PASSWORD"
        exec psql -X -q -U postgres -d messenger_qa --set ON_ERROR_STOP=1 "$@"
    ' sh "$@"
}

ctl() {
    if [[ $# == 1 ]]; then
        compose exec -T gateway wget -qO- "http://faults:8081/$1"
    else
        compose exec -T gateway wget -qO- --post-data='' "http://faults:8081/$1"
    fi
}

is_uuid() {
    [[ $1 =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || die 'expected lowercase UUID'
}

ready() {
    local service attempt
    for service in auth history chat; do
        for ((attempt=1; attempt<=30; attempt++)); do
            if compose exec -T gateway wget -T 2 -qO /dev/null "http://$service:8080/readyz"; then
                break
            fi
            sleep 1
        done
        (( attempt <= 30 )) || die "$service is not ready"
    done
    for service in auth history chat gateway; do
        local container sha
        container=$(compose ps --status running -q "$service")
        [[ -n $container ]] || die "$service is not running"
        sha=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
        [[ $sha == "$revision" ]] || die "$service has an unexpected SHA"
    done
    printf 'READY %s %s\n' "$revision" "$origin"
}

clear() {
    ctl 'release?kind=all' post
    sql <<'SQL'
DELETE FROM qa_control.gates;
SQL
}

# Serialize changes to this project. Release can run while a browser request is held.
case $action in
    status|inspect-chat|inspect-auth|auth-check|auth-log-check|gate-log|wait-locks|burst) ;;
    *)
        lock_dir=${QA_LOCK_DIR:-$(dirname -- "$env_file")}
        lock_dir=$(cd -- "$lock_dir" && pwd -P)
        exec 9>"$lock_dir/.$project.lock"
        flock -n 9 || die 'another QA control command is running'
        ;;
esac

case $action in
    up)
        [[ $# == 0 ]] || die 'usage: up'
        [[ $(git -C "$root" rev-parse HEAD) == "$revision" ]] || die 'checkout differs from QA_REVISION'
        [[ -z $(git -C "$root" status --porcelain --untracked-files=all) ]] || die 'QA checkout contains unreleased files'
        compose build auth history chat init gateway
        compose up -d --no-build
        ready
        ;;
    start)
        [[ $# == 0 ]] || die 'usage: start'
        compose up -d --no-build --pull never
        ready
        ;;
    stop)
        [[ $# == 0 ]] || die 'usage: stop'
        compose stop
        printf 'STOPPED %s %s\n' "$revision" "$origin"
        ;;
    status)
        [[ $# == 0 ]] || die 'usage: status'
        compose ps --all
        running=$(compose ps --status running -q)
        if [[ -z $running ]]; then
            printf 'STOPPED %s %s\n' "$revision" "$origin"
            exit 0
        fi
        ctl state
        sql <<'SQL'
SELECT operation, chat_id, mode, until_at, until_at > clock_timestamp() AS active
FROM qa_control.gates ORDER BY operation, chat_id;
SQL
        ready
        ;;
    restart-chat)
        [[ $# == 0 ]] || die 'usage: restart-chat'
        ready
        compose restart --timeout 25 chat
        ready
        ;;
    reset)
        [[ $# == 1 && $1 == --confirm ]] || die 'reset --confirm recreates the QA database and invalidates its sessions'
        compose down --volumes
        compose up -d --no-build
        ready
        ;;
    seed)
        [[ $# -ge 1 && $# -le 2 ]] || die 'usage: seed RUN_CODE [MESSAGES]'
        compose exec -T faults /usr/local/bin/qa-faults seed "$@"
        ;;
    slow-profile)
        [[ $# == 1 && $1 =~ ^(on|off)$ ]] || die 'usage: slow-profile on|off'
        if [[ $1 == on ]]; then
            compose --file "$here/slow-profile.yaml" up -d --no-deps --no-build chat
        else
            compose up -d --no-deps --no-build chat
        fi
        ready
        ;;
    burst)
        [[ $# == 2 ]] || die 'usage: burst CHAT USERNAME (test password on stdin)'
        is_uuid "$1"
        [[ $2 =~ ^qa50_[a-z0-9]{4,14}_[abc]$ ]] || die 'expected a seed username'
        compose exec -T faults /usr/local/bin/qa-faults burst "$1" "$2" "$origin"
        ;;
    arm)
        [[ $# -ge 1 ]] || die 'usage: arm RULE CHAT USER [SECONDS [CLIENT_MSG_ID]]'
        kind=$1
        shift
        case $kind in
            no-pong|slow-reader)
                [[ $# -ge 1 && $# -le 2 ]] || die 'usage: arm no-pong|slow-reader USER [SECONDS]'
                chat='' user=$1 seconds=${2:-90} client=''
                ;;
            hold-read|drop-read|block-history|skip-extra-read)
                [[ $# -ge 2 && $# -le 3 ]] || die 'usage: arm RULE CHAT USER [SECONDS]'
                chat=$1 user=$2 seconds=${3:-45} client=''
                is_uuid "$chat"
                ;;
            drop-ack|drop-new|drop-both)
                [[ $# -ge 2 && $# -le 4 ]] || die 'usage: arm RULE CHAT USER [SECONDS [CLIENT_MSG_ID]]'
                chat=$1 user=$2 seconds=${3:-45} client=${4:-}
                is_uuid "$chat"
                [[ -z $client ]] || is_uuid "$client"
                ;;
            *) die 'unknown HTTP or WS fault' ;;
        esac
        is_uuid "$user"
        [[ $seconds =~ ^[0-9]{1,3}$ ]] && (( 10#$seconds >= 1 && 10#$seconds <= 180 )) || die 'seconds must be 1-180'
        ctl "arm?kind=$kind&chat=$chat&user=$user&seconds=$((10#$seconds))&client=$client" post
        ;;
    release)
        [[ $# == 1 && $1 =~ ^(hold-read|drop-read|block-history|skip-extra-read|drop-ack|drop-new|drop-both|no-pong|slow-reader|all)$ ]] || die 'expected a rule or all'
        ctl "release?kind=$1" post
        ;;
    clear)
        [[ $# == 0 ]] || die 'usage: clear'
        clear
        ;;
    gate)
        [[ $# == 4 && $1 =~ ^(read|save)$ && $3 =~ ^(hold|reject)$ && $4 =~ ^[0-9]{1,3}$ ]] \
            || die 'usage: gate read|save CHAT hold|reject SECONDS'
        is_uuid "$2"
        (( 10#$4 >= 1 && 10#$4 <= 180 )) || die 'seconds must be 1-180'
        sql --set op="$1" --set chat="$2" --set mode="$3" --set seconds="$((10#$4))" <<'SQL'
INSERT INTO qa_control.gates (operation, chat_id, mode, until_at)
SELECT :'op', id, :'mode', clock_timestamp() + (:'seconds'::int * interval '1 sec')
FROM history.chats WHERE id = :'chat'::uuid
ON CONFLICT (operation, chat_id) DO UPDATE SET mode = excluded.mode, until_at = excluded.until_at
RETURNING operation, chat_id, mode, until_at;
SQL
        ;;
    release-gate)
        [[ $# == 2 && $1 =~ ^(read|save)$ ]] || die 'usage: release-gate read|save CHAT'
        is_uuid "$2"
        sql --set op="$1" --set chat="$2" <<'SQL'
DELETE FROM qa_control.gates WHERE operation = :'op' AND chat_id = :'chat'::uuid
RETURNING operation, chat_id;
SQL
        ;;
    gate-log)
        [[ $# == 0 ]] || die 'usage: gate-log'
        compose logs --no-log-prefix --tail=120 postgres | grep 'QA_GATE' || true
        ;;
    wait-locks)
        [[ $# == 0 ]] || die 'usage: wait-locks'
        sql <<'SQL'
SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
FROM pg_stat_activity WHERE datname = 'messenger_qa' AND usename = 'qa_history'
    AND state != 'idle' ORDER BY pid;
SQL
        ;;
    revoke|restore)
        [[ $# == 2 ]] || die 'usage: revoke|restore CHAT USER'
        is_uuid "$1"; is_uuid "$2"
        sql --set op="$action" --set chat="$1" --set person="$2" <<'SQL'
BEGIN;
SELECT :'op' = 'revoke' AS revoking \gset
\if :revoking
    CREATE TABLE IF NOT EXISTS qa_control.revoked_members
        (LIKE history.chat_members INCLUDING ALL);
    WITH removed AS (
        DELETE FROM history.chat_members WHERE chat_id = :'chat'::uuid AND user_id = :'person'::uuid
        RETURNING *
    ) INSERT INTO qa_control.revoked_members SELECT * FROM removed
        ON CONFLICT (chat_id, user_id) DO UPDATE SET role = excluded.role,
        last_read_seq = excluded.last_read_seq, last_delivered_seq = excluded.last_delivered_seq,
        public_last_read_seq = excluded.public_last_read_seq,
        public_last_delivered_seq = excluded.public_last_delivered_seq
        RETURNING chat_id, user_id;
\else
    WITH saved AS (
        DELETE FROM qa_control.revoked_members WHERE chat_id = :'chat'::uuid AND user_id = :'person'::uuid
        RETURNING *
    ) INSERT INTO history.chat_members SELECT * FROM saved
        RETURNING chat_id, user_id;
\endif
COMMIT;
SQL
        ;;
    delete-message|delete-chat)
        [[ $# == 1 ]] || die 'usage: delete-message|delete-chat UUID'
        is_uuid "$1"
        sql --set op="$action" --set target="$1" <<'SQL'
SELECT :'op' = 'delete-message' AS message \gset
\if :message
    DELETE FROM history.messages WHERE id = :'target'::uuid RETURNING id, chat_id;
\else
    DELETE FROM history.chats WHERE id = :'target'::uuid RETURNING id;
\endif
SQL
        ;;
    storage-down|storage-up)
        [[ $# == 0 ]] || die "usage: $action"
        sql --set op="$action" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT :'op' = 'storage-down' AS unavailable \gset
\if :unavailable
    ALTER TABLE history.later_entries RENAME TO qa_unavailable_later;
    ALTER TABLE history.chats RENAME TO qa_unavailable_chats;
    ALTER TABLE history.messages RENAME TO qa_unavailable_messages;
\else
    ALTER TABLE history.qa_unavailable_messages RENAME TO messages;
    ALTER TABLE history.qa_unavailable_chats RENAME TO chats;
    ALTER TABLE history.qa_unavailable_later RENAME TO later_entries;
\endif
COMMIT;
SQL
        ;;
    expire-refresh)
        [[ $# == 1 ]] || die 'usage: expire-refresh USER'
        is_uuid "$1"
        sql --set person="$1" <<'SQL'
UPDATE auth.refresh_tokens SET expires_at = clock_timestamp() - interval '1 second'
WHERE user_id = :'person'::uuid AND expires_at > clock_timestamp() AND revoked_at IS NULL
RETURNING id, user_id, expires_at;
SQL
        ;;
    inspect-chat)
        [[ $# == 1 ]] || die 'usage: inspect-chat CHAT'
        is_uuid "$1"
        sql --set chat="$1" <<'SQL'
SELECT id, last_seq FROM history.chats WHERE id = :'chat'::uuid;
SELECT user_id, last_read_seq, last_delivered_seq FROM history.chat_members
WHERE chat_id = :'chat'::uuid ORDER BY user_id;
SELECT id, seq, sender_id, client_msg_id FROM history.messages
WHERE chat_id = :'chat'::uuid ORDER BY seq;
SQL
        ;;
    auth-check)
        [[ $# == 1 ]] || die 'usage: auth-check USER'
        is_uuid "$1"
        compose exec -T faults /usr/local/bin/qa-faults auth-check "$1"
        ;;
    auth-log-check)
        [[ $# == 0 ]] || die 'usage: auth-log-check (disposable password, access JWT and refresh token on stdin)'
        labels=(password access refresh)
        samples=()
        for label in "${labels[@]}"; do
            IFS= read -r -n 4097 -t 15 sample || die "expected $label on stdin"
            [[ -n $sample && ${#sample} -le 4096 ]] || die "invalid $label sample"
            samples+=("$sample")
        done
        logs=$(compose logs --no-color --no-log-prefix --since 15m --tail 2000 auth 2>&1) \
            || die 'unable to read QA Auth logs'
        found=0
        for i in "${!labels[@]}"; do
            if [[ $logs == *"${samples[$i]}"* ]]; then
                printf '%s: found in QA Auth logs\n' "${labels[$i]}"
                found=1
            else
                printf '%s: absent from scanned QA Auth logs\n' "${labels[$i]}"
            fi
        done
        exit "$found"
        ;;
    inspect-auth)
        [[ $# == 1 ]] || die 'usage: inspect-auth USER'
        is_uuid "$1"
        sql --set person="$1" <<'SQL'
SELECT id, password_hash LIKE '$2%' OR password_hash LIKE '$argon2%' AS password_is_hash
FROM auth.users WHERE id = :'person'::uuid;
SELECT id, token_hash ~ '^[0-9a-f]{64}$' AS refresh_is_sha256, expires_at, revoked_at
FROM auth.refresh_tokens WHERE user_id = :'person'::uuid ORDER BY expires_at;
SQL
        ;;
    *) die 'unknown action, see deploy/qa-staging/README.md' ;;
esac
