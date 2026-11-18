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
root=$(realpath -e "${STAGING_ROOT:-/root/messenger36-stage}")
project=${STAGING_PROJECT:-messenger36-stage}
ingress=${STAGING_INGRESS:-messenger36-ingress}
snippets=$(realpath -e "${STAGING_SNIPPETS:-/root/messenger36-nginx/snippets}")
url=${STAGING_URL:-https://staging.tidingm.ru}
[[ $project =~ ^messenger36-stage(-[a-z0-9]+)*$ ]] || die 'expected a staging Compose project'
[[ $url =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || die 'expected an HTTPS origin'
active_snippet="$snippets/public-locations.conf"
[[ -f $root/compose.yaml && -f $active_snippet ]] || die 'existing staging Compose and Nginx config required'
network="${project}_default"
services=(auth chat history)
compose=(docker compose --project-name "$project" --project-directory "$root" --file "$root/compose.yaml")
overlay="$root/compose.release.yaml"
state="$root/.release-state"
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

activate() {
    local revision=$1 check_later=$2 service expected
    atomic_copy "$revision/compose.yaml" "$overlay" 0600 || return 1
    local target=("${compose[@]}" --file "$overlay")
    "${target[@]}" config --quiet || return 1
    "${target[@]}" up -d --no-deps --no-build --force-recreate "${services[@]}" || return 1
    for service in "${services[@]}"; do
        expected=$(<"$revision/$service.image")
        [[ $(container_image "$service") == "$expected" ]] || return 1
    done
    health || return 1
    atomic_copy "$revision/public-locations.conf" "$active_snippet" 0644 || return 1
    docker exec "$ingress" nginx -t || return 1
    docker exec "$ingress" nginx -s reload || return 1
    https_status /me 401 && https_status /internal/users/test 404 || return 1
    if [[ $check_later == yes ]]; then https_status /later 401 || return 1; fi
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
    [[ $(schema) == '1:false,2:false' ]] || die 'expected Auth schema 1 and History schema 2, both clean'
    db <<'SQL'
BEGIN;
GRANT SELECT, INSERT ON history.later_entries TO messenger36_history;
GRANT UPDATE (due_at, state, updated_at) ON history.later_entries TO messenger36_history;
GRANT UPDATE (id) ON history.messages TO messenger36_history;
COMMIT;
SQL
}

rollback() {
    [[ -f $state/previous ]] || die 'no rollback snapshot'
    local previous
    previous=$(<"$state/previous")
    [[ $previous =~ ^rel\.[a-zA-Z0-9]+$ && -d $state/$previous/previous ]] || die 'invalid rollback snapshot'
    atomic_copy "$state/previous" "$state/pending" 0600
    log "restoring $previous and preserving the current DB schema"
    activate "$state/$previous/previous" no || die "rollback failed; snapshot retained at $state/$previous/previous"
    rm -f "$state/pending" "$state/previous"
    log 'previous images and Nginx snippet restored'
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
[[ ! -e $state/pending ]] || die 'incomplete switch; run rollback before deploying again'

sha=$2
[[ $sha =~ ^[a-f0-9]{40}$ ]] || die 'expected full lowercase Git SHA'
release=$(realpath -e "$3")
[[ -f $release/REVISION && $(<"$release/REVISION") == "$sha" && -x $release/migrate ]] || die 'release SHA or migrator missing'
candidate="$release/deploy/nginx/snippets/public-locations.conf"
[[ -s $candidate ]] || die 'release is missing the public Nginx snippet'

# Future schema changes need their own compatibility review before deployment.
for service in auth history; do
    files=("$release/services/$service/migrations/"*.up.sql)
    case "$service:${#files[@]}:${files[-1]##*/}" in
        auth:1:000001_initial_schema.up.sql|history:2:000002_later_entries.up.sql) ;;
        *) die "unsupported $service migrations in release" ;;
    esac
done
before=$(schema)
case "$before" in
    1:false,1:false|1:false,2:false) ;;
    *) die "unexpected DB schema: $before" ;;
esac
docker exec "$ingress" nginx -t

run=$(mktemp -d "$state/rel.XXXXXXXX")
id=${run##*/}
mkdir "$run/previous" "$run/next"
install -m 0600 "$active_snippet" "$run/previous/public-locations.conf"
install -m 0600 "$candidate" "$run/next/public-locations.conf"
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

if [[ $before == '1:false,1:false' ]]; then
    "${compose[@]}" exec -T --interactive=false postgres sh -ec \
        'exec pg_dump -Fc -U "$POSTGRES_USER" -d messenger_stage' > "$run/before-migration.dump"
    test -s "$run/before-migration.dump"
    "${compose[@]}" exec -T postgres pg_restore --list < "$run/before-migration.dump" > "$run/dump-contents.txt"
    log "saved DB dump at $run/before-migration.dump"
fi
log "applying migrations before switching services ($before)"
migrate "$release"

printf '%s\n' "$id" > "$run/pointer"
atomic_copy "$run/pointer" "$state/previous" 0600
atomic_copy "$run/pointer" "$state/pending" 0600
log "switching staging services to $sha"
if ! activate "$run/next" yes; then
    log 'deployment failed; starting application rollback' >&2
    rollback
    exit 1
fi
rm -f "$state/pending"
log "deployed $sha; rollback snapshot is $run/previous"
