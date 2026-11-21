#!/usr/bin/env bash
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }

[[ $# == 5 ]] ||
  die 'usage: staging-qa-reset.sh --preview|--apply RUN A_UUID B_UUID CHAT_UUID'
mode=$1
run=$2
alice=$3
bob=$4
chat=$5
case "$mode" in
  --preview) apply=false ;;
  --apply) apply=true ;;
  *) die 'expected --preview or --apply' ;;
esac
[[ $run =~ ^[a-z0-9]{6,12}$ ]] || die 'invalid run code'
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for id in "$alice" "$bob" "$chat"; do
  [[ $id =~ $uuid ]] || die 'expected lowercase UUID'
done
[[ $alice != "$bob" ]] || die 'expected distinct users'
[[ $(id -un) == messenger-stage ]] || die 'use the staging operator account'
root=/home/messenger-stage/messenger36-stage
cd "$root"
socket="/run/user/$(id -u)/docker.sock"
[[ -S $socket ]] || die 'missing rootless Docker socket'
docker_cmd=(/opt/messenger-rootless/bin/docker --host "unix://$socket")
security=$("${docker_cmd[@]}" info --format '{{json .SecurityOptions}}')
[[ $security == *name=rootless* ]] || die 'expected rootless Docker'
compose=("${docker_cmd[@]}" compose
  --project-name messenger36-stage --project-directory "$root"
  --file "$root/compose.yaml" --file "$root/compose.release.yaml")

[[ -f $root/.release-state/lock ]] || die 'staging release lock file missing'
exec 9<>"$root/.release-state/lock"
flock -n 9 || die 'another staging operation holds the lock'
[[ ! -f $root/.release-state/pending ]] || die 'a pending release needs inspection'
pg=$("${compose[@]}" ps -q postgres)
[[ -n $pg ]] || die 'staging PostgreSQL is unavailable'
scope=$("${docker_cmd[@]}" inspect --format \
  '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$pg")
[[ $scope == messenger36-stage/postgres ]] || die 'unexpected database container'

"${compose[@]}" exec -T postgres sh -ec '
  test "$POSTGRES_DB" = messenger_stage
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
' sh -v apply="$apply" -v run="$run" -v alice="$alice" -v bob="$bob" -v chat="$chat" <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';

CREATE TEMP TABLE qa_target (run_code text, alice uuid, bob uuid, chat_id uuid) ON COMMIT DROP;
INSERT INTO qa_target VALUES (:'run', :'alice', :'bob', :'chat');

DO $check$
DECLARE
    target qa_target%ROWTYPE;
BEGIN
    SELECT * INTO STRICT target FROM qa_target;
    IF current_database() <> 'messenger_stage'
        OR target.run_code !~ '^[a-z0-9]{6,12}$' OR target.alice = target.bob THEN
        RAISE EXCEPTION 'refusing reset: wrong staging context';
    END IF;
    PERFORM 1 FROM history.chats
      WHERE id = target.chat_id AND type = 'personal' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'refusing reset: expected personal chat';
    END IF;
    PERFORM 1 FROM history.chat_members WHERE chat_id = target.chat_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM auth.users
                    WHERE id = target.alice AND username = 'qa38_' || target.run_code || '_a')
        OR NOT EXISTS (SELECT 1 FROM auth.users
                    WHERE id = target.bob AND username = 'qa38_' || target.run_code || '_b')
        OR (SELECT count(*) FROM history.chat_members WHERE chat_id = target.chat_id) <> 2
        OR EXISTS (SELECT 1 FROM history.chat_members WHERE chat_id = target.chat_id
                    AND user_id NOT IN (target.alice, target.bob))
        OR NOT EXISTS (SELECT 1 FROM history.personal_chat_pairs WHERE chat_id = target.chat_id
                    AND user_low_id = LEAST(target.alice, target.bob)
                    AND user_high_id = GREATEST(target.alice, target.bob)) THEN
        RAISE EXCEPTION 'refusing reset: fixture users or chat do not match';
    END IF;
    -- Hold off new Later references until the transaction finishes.
    PERFORM 1 FROM history.messages WHERE chat_id = target.chat_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM history.later_entries l
               JOIN history.messages m ON m.id = l.message_id
               WHERE m.chat_id = target.chat_id AND l.user_id NOT IN (target.alice, target.bob)) THEN
        RAISE EXCEPTION 'refusing reset: found a Later entry owned by another user';
    END IF;
END;
$check$;

SELECT t.chat_id,
    (SELECT count(*) FROM history.messages m WHERE m.chat_id = t.chat_id) AS messages,
    (SELECT count(*) FROM history.later_entries l JOIN history.messages m ON m.id = l.message_id
      WHERE m.chat_id = t.chat_id) AS later_entries
FROM qa_target t;

\if :apply
DELETE FROM history.messages m USING qa_target t WHERE m.chat_id = t.chat_id;
DELETE FROM history.chats c USING qa_target t WHERE c.id = t.chat_id;
COMMIT;
\else
ROLLBACK;
\endif
SQL
