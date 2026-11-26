#!/usr/bin/env bash
# Deploy prepared images to the existing staging Compose project.
set -Eeuo pipefail
umask 077

die() { printf 'staging: %s\n' "$*" >&2; exit 1; }
log() { printf 'staging: %s\n' "$*"; }

case "${1:-}:$#" in
    deploy:3|rollback:1) ;;
    *) die 'usage: staging-release.sh deploy SHA RELEASE_DIR | rollback' ;;
esac
root=$(realpath -e "${STAGING_ROOT:-$HOME/messenger36-stage}")
project=${STAGING_PROJECT:-messenger36-stage}
ingress=${STAGING_INGRESS:-messenger36-ingress}
snippets=$(realpath -e "${STAGING_SNIPPETS:-$root/nginx/snippets}")
url=${STAGING_URL:-https://staging.tidingm.ru}
tool_root=$(dirname "$(realpath "$0")")
wss_probe=${STAGING_WSS_PROBE:-$tool_root/../staging-wss-probe}
wss_credentials=${STAGING_WSS_CREDENTIALS:-$root/wss-probe.json}
[[ $project =~ ^messenger36-stage(-[a-z0-9]+)*$ ]] || die 'expected a staging Compose project'
[[ $url =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || die 'expected an HTTPS origin'
active_snippet="$snippets/public-locations.conf"
marker_snippet="$snippets/release-marker.conf"
[[ -f $root/compose.yaml && -f $active_snippet ]] || die 'existing staging Compose and Nginx config required'
[[ -x $wss_probe && -r $wss_credentials ]] || die 'WSS probe executable and staging test credentials required'
network="${project}_default"
services=(auth chat history)
compose=(docker compose --project-name "$project" --project-directory "$root" --file "$root/compose.yaml")
overlay="$root/compose.release.yaml"
state="$root/.release-state"
web_root=${STAGING_WEB_ROOT:-/var/lib/messenger/acme/staging-web}
install -d -m 0700 "$state"
exec 9>"$state/lock"
flock -n 9 || die 'another deployment or rollback is running'

db() {
    "${compose[@]}" exec -T postgres sh -ec '
        test "$POSTGRES_DB" = messenger_stage
        exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"
    ' sh "$@"
}

schema() {
    db -Atc "
        SELECT (SELECT version::text || ':' || dirty::text FROM public.auth_schema_migrations)
            || ',' ||
            (SELECT version::text || ':' || dirty::text FROM public.history_schema_migrations)
    "
}

container_image() {
    local container
    container=$("${compose[@]}" ps --status running -q "$1") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    docker inspect --format '{{.Image}}' "$container"
}

atomic_copy() {
    local tmp
    tmp=$(mktemp "${2}.XXXXXX") || return 1
    install -m "$3" "$1" "$tmp" && mv -fT "$tmp" "$2"
}

write_overlay() {
    local tag=$1 service
    printf 'services:\n'
    for service in "${services[@]}"; do
        printf '  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$project-cd-$service:$tag"
    done
}

health() {
    local service path attempt
    for service in "${services[@]}"; do
        for path in healthz readyz; do
            for ((attempt=1; attempt<=20; attempt++)); do
                if docker exec "$ingress" wget -T 2 -qO /dev/null "http://$service:8080/$path"; then break; fi
                sleep 1
            done
            (( attempt <= 20 )) || { log "$service /$path failed" >&2; return 1; }
            log "$service /$path OK"
        done
    done
}

https_status() {
    local path=$1 expected=$2 actual attempt
    for ((attempt=1; attempt<=10; attempt++)); do
        actual=$(curl --silent --show-error --proto '=https' --max-time 5 \
            --output /dev/null --write-out '%{http_code}' "$url$path") || actual=000
        if [[ $actual == "$expected" ]]; then
            log "HTTPS $path -> $actual"
            return 0
        fi
        sleep 1
    done
    log "HTTPS $path -> $actual, expected $expected" >&2
    return 1
}

valid_web_ref() {
    [[ $1 =~ ^releases/([a-f0-9]{40})(-[a-f0-9]{64})?(~[a-zA-Z0-9_]+)?$ ]]
}

valid_web_release() {
    valid_web_ref "$1" || return 1
    local expected=${BASH_REMATCH[1]}
    [[ -s $web_root/$1/app/index.html && -f $web_root/$1/REVISION &&
        $(<"$web_root/$1/REVISION") == "$expected" ]]
}

probe_web() {
    valid_web_release "$1" || return 1
    python3 "$tool_root/staging-web.py" probe "$web_root" "$1" "$url"
}

activate_web() {
    local revision=$1 ref incoming
    [[ -f $revision/web.release ]] || return 0
    ref=$(<"$revision/web.release") || return 1
    valid_web_release "$ref" || return 1
    if [[ $(readlink "$web_root/current") == "$ref" ]]; then return 0; fi
    incoming=$(mktemp -d "$web_root/.switch.XXXXXXXX") || return 1
    if ln -s "$ref" "$incoming/current" && mv -fT "$incoming/current" "$web_root/current"; then
        rmdir "$incoming"
    else
        rm -f "$incoming/current"
        rmdir "$incoming"
        return 1
    fi
}

prepare_web_rollback() {
    local revision=$1 ref ready
    [[ -f $revision/web.release ]] || return 0
    ref=$(<"$revision/web.release") || return 1
    valid_web_ref "$ref" || return 1
    ready=$(python3 "$tool_root/staging-web.py" prepare-rollback "$web_root" "$ref") || return 1
    valid_web_release "$ready" || return 1
    if [[ $ready != "$ref" ]]; then
        local pointer
        pointer=$(mktemp "$revision/.web.XXXXXXXX") || return 1
        printf '%s\n' "$ready" > "$pointer" && mv -fT "$pointer" "$revision/web.release" || return 1
        log "prepared rollback from verified web snapshot $ready"
    fi
}

confirm_web() {
    local revision=$1
    [[ -f $revision/web.release ]] || return 0
    python3 "$tool_root/staging-web.py" confirm "$web_root" "$(<"$revision/web.release")"
}

runtime_matches() {
    local revision=$1 service expected
    for service in "${services[@]}"; do
        expected=$(<"$revision/$service.image") || return 1
        [[ $(container_image "$service") == "$expected" ]] || return 1
    done
}

verify_runtime() {
    local revision=$1 expected actual attempt later_status receipts_status=404 web_ref
    runtime_matches "$revision" && cmp -s "$revision/public-locations.conf" "$active_snippet" || return 1
    expected=$(<"$revision/marker") || return 1
    for ((attempt=1; attempt<=10; attempt++)); do
        actual=$(docker exec "$ingress" wget -T 2 -qO- http://127.0.0.1:8081/) || actual=
        if [[ -n $expected && $actual == "$expected" ]]; then break; fi
        sleep 1
    done
    (( attempt <= 10 )) || { log 'Nginx did not load the selected config' >&2; return 1; }
    health || return 1
    later_status=$(<"$revision/later.status") || return 1
    https_status /me 401 && https_status /internal/users/test 404 &&
        https_status /later "$later_status" || return 1
    if [[ -f $revision/receipts.status ]]; then
        receipts_status=$(<"$revision/receipts.status") || return 1
    fi
    https_status /chats/00000000-0000-4000-8000-000000000001/receipts "$receipts_status" || return 1
    if [[ -f $revision/web.release ]]; then
        web_ref=$(<"$revision/web.release") || return 1
        [[ $(readlink "$web_root/current") == "$web_ref" ]] && probe_web "$web_ref" || return 1
    fi
    "$wss_probe" "$url" "$wss_credentials"
}

activate() {
    local revision=$1 marker signature
    atomic_copy "$revision/compose.yaml" "$overlay" 0600 || return 1
    local target=("${compose[@]}" --file "$overlay")
    "${target[@]}" config --quiet || return 1
    "${target[@]}" up -d --no-deps --no-build --force-recreate "${services[@]}" || return 1
    runtime_matches "$revision" || return 1
    health || return 1
    atomic_copy "$revision/public-locations.conf" "$active_snippet" 0644 || return 1
    # Equivalent recovery snapshots must report the same active marker.
    signature=$(cd "$revision" &&
        sha256sum public-locations.conf auth.image chat.image history.image | sha256sum | cut -d ' ' -f 1) || return 1
    marker=$(mktemp "$snippets/.release.XXXXXXXX") || return 1
    printf '%s\n' "$signature" > "$revision/marker" &&
        printf 'return 200 "%s";\n' "$signature" > "$marker" &&
        chmod 0644 "$marker" && mv -fT "$marker" "$marker_snippet" || return 1
    docker exec "$ingress" nginx -t || return 1
    docker exec "$ingress" nginx -s reload || return 1
    activate_web "$revision" || return 1
    verify_runtime "$revision"
}

migrate() {
    local release=$1 postgres
    postgres=$("${compose[@]}" ps --status running -q postgres)
    [[ -n $postgres ]] || die 'PostgreSQL is not running'
    # Feed the admin credentials to the temporary migrator over stdin.
    "${compose[@]}" exec -T --interactive=false postgres sh -ec '
        test "$POSTGRES_DB" = messenger_stage
        test -n "$POSTGRES_USER" && test -n "$POSTGRES_PASSWORD"
        cr=$(printf "\r")
        case "$POSTGRES_USER$POSTGRES_PASSWORD" in *"$cr"*|*"
"*) exit 1;; esac
        printf "POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\n" "$POSTGRES_USER" "$POSTGRES_PASSWORD"
    ' | docker run --rm --network "$network" --env-file /dev/stdin \
        -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 -e POSTGRES_DB=messenger_stage \
        -e POSTGRES_SSLMODE=disable -e 'PGOPTIONS=-c lock_timeout=10s -c statement_timeout=60s' \
        --mount "type=bind,source=$release,target=/release,readonly" --workdir /release \
        --entrypoint /release/migrate "$(docker inspect --format '{{.Image}}' "$postgres")" \
        -service=all -direction=up
    [[ $(schema) == '1:false,4:false' ]] || die 'expected Auth schema 1 and History schema 4, both clean'
    db <<'SQL'
BEGIN;
GRANT SELECT, INSERT ON history.later_entries TO messenger36_history;
GRANT UPDATE (due_at, state, updated_at) ON history.later_entries TO messenger36_history;
GRANT UPDATE (id) ON history.messages TO messenger36_history;
GRANT UPDATE (public_last_delivered_seq, public_last_read_seq) ON history.chat_members TO messenger36_history;
COMMIT;
SQL
}

valid_ref() {
    [[ $1 =~ ^rel\.[a-zA-Z0-9]+/(previous|next)$ && -d $state/$1 ]]
}

recovery_ref() {
    case "$1" in
        */next) printf '%s/previous\n' "${1%/*}" ;;
        */previous) printf '%s/next\n' "${1%/*}" ;;
    esac
}

# A pending switch points at its target. Its sibling already contains the
# prepared recovery reference and can be activated without reading verified/.
# The current pointer changes only after verification. A crash after that
# atomic commit needs only marker cleanup, never another switch.
recover_pending() {
    local target recovery active
    target=$(<"$state/pending")
    valid_ref "$target" || die 'invalid pending switch'
    if [[ -f $state/current && $(<"$state/current") == "$target" ]]; then
        rm -f "$state/pending"
        return
    fi
    recovery=$(recovery_ref "$target")
    valid_ref "$recovery" || die 'invalid recovery snapshot'
    log "restoring $recovery and preserving the current DB schema"
    # Restore the web pointer even if the subsequent backend recovery fails.
    activate_web "$state/$recovery" || die "web recovery failed; snapshot retained at $state/$recovery"
    activate "$state/$recovery" || die "recovery failed; snapshot retained at $state/$recovery"
    if [[ -f $state/current && -f $state/$recovery/web.release ]]; then
        active=$(<"$state/current")
        valid_ref "$active" || die 'invalid active release after recovery'
        atomic_copy "$state/$recovery/web.release" "$state/$active/web.release" 0600
    fi
    rm -f "$state/pending"
}

switch_to() {
    local target=$1 pointer recovery
    valid_ref "$target" || die 'invalid switch target'
    recovery=$(recovery_ref "$target")
    valid_ref "$recovery" || die 'invalid recovery snapshot'
    prepare_web_rollback "$state/$recovery" || die "cannot prepare recovery snapshot at $state/$recovery"
    pointer=$(mktemp "$state/.switch.XXXXXX")
    printf '%s\n' "$target" > "$pointer"
    mv -fT "$pointer" "$state/pending"
    if ! activate "$state/$target" || ! confirm_web "$state/$target"; then
        log 'switch failed; restoring previous running configuration' >&2
        recover_pending
        return 1
    fi
    atomic_copy "$state/pending" "$state/current" 0600
    rm -f "$state/pending"
}

rollback() {
    if [[ -f $state/pending ]]; then
        recover_pending
        return
    fi
    [[ -f $state/current ]] || die 'no rollback snapshot'
    local current target
    current=$(<"$state/current")
    valid_ref "$current" && [[ $current == */next ]] || die 'no rollback snapshot'
    target="${current%/*}/previous"
    valid_ref "$target" || die 'invalid rollback snapshot'
    prepare_web_rollback "$state/$target" || die 'cannot prepare web rollback snapshot'
    switch_to "$target"
    log 'previous images, Nginx snippet and saved web version restored'
}

docker network inspect "$network" --format '{{index .Labels "com.docker.compose.project"}}' | grep -Fx "$project" >/dev/null \
    || die 'network is not owned by this staging project'
docker inspect "$ingress" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | grep -Fx "$network" >/dev/null \
    || die 'ingress does not use the staging network'
docker inspect "$ingress" --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/messenger/snippets"}}{{println .Source}}{{end}}{{end}}' | grep -Fx "$snippets" >/dev/null \
    || die 'ingress is not using the configured snippet directory'

if [[ $1 == rollback ]]; then
    rollback
    exit
fi
if [[ -f $state/pending ]]; then
    if [[ -f $state/current && $(<"$state/current") == "$(<"$state/pending")" ]]; then
        recover_pending
    else
        die 'incomplete switch; run rollback before deploying again'
    fi
fi

sha=$2
[[ $sha =~ ^[a-f0-9]{40}$ ]] || die 'expected full lowercase Git SHA'
release=$(realpath -e "$3")
[[ -f $release/REVISION && $(<"$release/REVISION") == "$sha" && -x $release/migrate ]] || die 'release SHA or migrator missing'
candidate="$release/deploy/nginx/snippets/public-locations.conf"
[[ -s $candidate ]] || die 'release is missing the public Nginx snippet'
with_web=false
if [[ -e $release/web.zip || -e $release/web.digest ]]; then
    [[ -s $release/web.zip && -s $release/web.digest ]] || die 'incomplete staging web artifact'
    with_web=true
fi
if [[ $with_web == true ]]; then
    web_digest=$(<"$release/web.digest")
    [[ $web_digest =~ ^[a-f0-9]{64}$ ]] || die 'invalid web digest'
    printf '%s  %s\n' "$web_digest" "$release/web.zip" | sha256sum --status -c - || die 'web archive digest mismatch'
fi
if [[ -f $state/current ]]; then
    current=$(<"$state/current")
    valid_ref "$current" || die 'invalid current release'
    if [[ $(<"$state/$current/REVISION") == "$sha" ]]; then
        if [[ $with_web == false ]]; then
            verify_runtime "$state/$current"
            printf 'STAGING_RESULT already_active %s %s\n' "$sha" "$current"
            exit 0
        fi
        if [[ -f $state/$current/web.release ]]; then
            active_web=$(<"$state/$current/web.release")
            if valid_web_release "$active_web" && [[ -f $web_root/$active_web/ARTIFACT_SHA256 ]]; then
                active_digest=$(<"$web_root/$active_web/ARTIFACT_SHA256")
                if [[ $active_digest == "sha256:$web_digest" ]] && verify_runtime "$state/$current"; then
                    confirm_web "$state/$current"
                    printf 'STAGING_RESULT already_active %s %s\n' "$sha" "$current"
                    exit 0
                fi
                log "staging web replacement for $sha: active $active_digest, requested sha256:$web_digest"
            fi
        fi
    fi
fi

# Future schema changes need their own compatibility review before deployment.
for service in auth history; do
    files=("$release/services/$service/migrations/"*.up.sql)
    case "$service:${#files[@]}:${files[-1]##*/}" in
        auth:1:000001_initial_schema.up.sql|history:4:000004_presence_delivery.up.sql) ;;
        *) die "unsupported $service migrations in release" ;;
    esac
done
before=$(schema)
case "$before" in
    1:false,1:false|1:false,2:false|1:false,3:false|1:false,4:false) ;;
    *) die "unexpected DB schema: $before" ;;
esac
docker exec "$ingress" nginx -t

run=$(mktemp -d "$state/rel.XXXXXXXX")
id=${run##*/}
mkdir "$run/previous" "$run/next"
if [[ $with_web == true ]]; then
    previous_web=$(readlink "$web_root/current") || previous_web=
    if probe_web "$previous_web"; then
        python3 "$tool_root/staging-web.py" confirm "$web_root" "$previous_web"
    else
        [[ -n ${current:-} && -f $state/$current/web.release ]] || die 'no confirmed web snapshot for recovery'
        confirmed_web=$(<"$state/$current/web.release")
        valid_web_ref "$confirmed_web" ||
            die 'invalid confirmed web snapshot reference'
        previous_web=$(python3 "$tool_root/staging-web.py" restore "$web_root" "$confirmed_web") ||
            die 'cannot restore confirmed web snapshot'
        log "web baseline failed smoke; rollback will use confirmed snapshot $previous_web"
    fi
    next_web=$(python3 "$tool_root/staging-web.py" install "$web_root" "$sha" "$web_digest" "$release/web.zip") \
        || die 'could not install staging web artifact'
    valid_web_release "$next_web" || die 'invalid prepared staging web release'
    printf '%s\n' "$previous_web" > "$run/previous/web.release"
    printf '%s\n' "$next_web" > "$run/next/web.release"
fi
install -m 0600 "$active_snippet" "$run/previous/public-locations.conf"
install -m 0600 "$candidate" "$run/next/public-locations.conf"
previous_revision=unknown
if [[ -f $state/current ]] && runtime_matches "$state/$current" &&
    cmp -s "$state/$current/public-locations.conf" "$active_snippet"; then
    previous_revision=$(<"$state/$current/REVISION")
fi
printf '%s\n' "$previous_revision" > "$run/previous/REVISION"
printf '%s\n' "$sha" > "$run/next/REVISION"
previous_later=$(curl --silent --show-error --proto '=https' --max-time 5 \
    --output /dev/null --write-out '%{http_code}' "$url/later")
[[ $previous_later == 401 || $previous_later == 404 ]] || die 'unexpected /later baseline status'
printf '%s\n' "$previous_later" > "$run/previous/later.status"
printf '401\n' > "$run/next/later.status"
previous_receipts=$(curl --silent --show-error --proto '=https' --max-time 5 \
    --output /dev/null --write-out '%{http_code}' "$url/chats/00000000-0000-4000-8000-000000000001/receipts")
[[ $previous_receipts == 401 || $previous_receipts == 404 ]] || die 'unexpected chat receipts baseline status'
printf '%s\n' "$previous_receipts" > "$run/previous/receipts.status"
printf '401\n' > "$run/next/receipts.status"
for service in "${services[@]}"; do
    image="$project-$service:$sha"
    previous=$(container_image "$service") || die "$service must be running to capture rollback"
    revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
    [[ $revision == "$sha" ]] || die "$image has a missing or mismatched revision label"
    next=$(docker image inspect --format '{{.Id}}' "$image")
    printf '%s\n' "$previous" > "$run/previous/$service.image"
    printf '%s\n' "$next" > "$run/next/$service.image"
    docker image tag "$previous" "$project-cd-$service:$id-previous"
    docker image tag "$next" "$project-cd-$service:$id-next"
done
write_overlay "$id-previous" > "$run/previous/compose.yaml"
write_overlay "$id-next" > "$run/next/compose.yaml"
"${compose[@]}" --file "$run/next/compose.yaml" config --quiet

if [[ $before != '1:false,4:false' ]]; then
    "${compose[@]}" exec -T --interactive=false postgres sh -ec \
        'exec pg_dump -Fc -U "$POSTGRES_USER" -d messenger_stage' > "$run/before-migration.dump"
    test -s "$run/before-migration.dump"
    "${compose[@]}" exec -T postgres pg_restore --list < "$run/before-migration.dump" > "$run/dump-contents.txt"
    log "saved DB dump at $run/before-migration.dump"
fi
log "applying migrations before switching services ($before)"
migrate "$release"

log "switching staging services to $sha"
switch_to "$id/next"
log "deployed $sha; rollback snapshot is $run/previous"
printf 'STAGING_RESULT deployed %s %s/next\n' "$sha" "$id"
