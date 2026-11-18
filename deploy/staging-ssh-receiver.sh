#!/usr/bin/env bash
# Install as a root-owned forced command for the unprivileged staging account.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
repo=messenger-go-team/messenger

die() { printf 'staging receiver: %s\n' "$*" >&2; exit 1; }
[[ $(id -un) == messenger-stage && $EUID != 0 ]] || die 'expected unprivileged messenger-stage account'
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export XDG_RUNTIME_DIR=/run/user/$EUID
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
[[ -S $XDG_RUNTIME_DIR/docker.sock ]] || die 'rootless Docker socket is unavailable'
docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -Fx 'name=rootless' >/dev/null \
    || die 'Docker daemon must be rootless'

command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == probe ]]; then
    printf 'staging receiver ready (rootless)\n'
    exit 0
fi
[[ $command =~ ^deploy\ ([a-f0-9]{40})$ ]] || die 'expected deploy followed by the full SHA'
sha=${BASH_REMATCH[1]}
root="$HOME/messenger36-stage"

github() {
    curl -fsS --proto '=https' --max-time 20 --retry 2 -H 'Cache-Control: no-cache' \
        "https://api.github.com/repos/$repo/$1"
}

verify_release() {
    local current ci result
    current=$(github git/ref/heads/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])') \
        || die 'cannot verify main on GitHub'
    [[ $current =~ ^[a-f0-9]{40}$ ]] || die 'GitHub returned an invalid main SHA'
    if [[ $current != "$sha" ]]; then
        printf 'STAGING_RESULT skipped %s\n' "$sha"
        exit 0
    fi
    for ci in ci.yml frontend-ci.yml; do
        result=$(github "actions/workflows/$ci/runs?branch=main&event=push&head_sha=$sha&per_page=1" |
            python3 -c 'import json,sys
runs = json.load(sys.stdin)["workflow_runs"]
r = runs[0] if runs else {}
valid = (r.get("head_sha") == sys.argv[1] and r.get("event") == "push"
         and r.get("head_branch") == "main" and r.get("status") == "completed")
print(r.get("conclusion") if valid else "not verified")' "$sha") \
            || die "cannot verify $ci for $sha"
        [[ $result == success ]] || die "$ci is not successful for $sha ($result)"
    done
}

install -d -m 0700 "$root/releases"
exec 9>"$root/releases/.receiver.lock"
flock -w 1200 9 || die 'timed out waiting for another deployment'
verify_release

release=$(mktemp -d "$root/releases/$sha.XXXXXX")
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 --retry 2 \
    "https://codeload.github.com/$repo/tar.gz/$sha" -o "$release/source.tar.gz"
tar -xzf "$release/source.tar.gz" -C "$release" --strip-components=1
rm "$release/source.tar.gz"
printf '%s\n' "$sha" > "$release/REVISION"
go_version=$(awk '$1 == "go" {print $2; exit}' "$release/go.mod")
[[ $go_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid Go version in release'

docker run --rm -e CGO_ENABLED=0 -e GOTOOLCHAIN=local \
    --mount "type=bind,source=$release,target=/release" --workdir /release \
    "golang:$go_version-alpine" sh -ec '
        go build -trimpath -o migrate ./cmd/migrate
        go build -trimpath -o staging-wss-probe ./cmd/staging-wss-probe
    '
for service in auth chat history; do
    docker build --label "org.opencontainers.image.revision=$sha" \
        -f "$release/services/$service/Dockerfile" \
        -t "messenger36-stage-$service:$sha" "$release"
done

verify_release
env -i PATH="$PATH" HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DOCKER_HOST="$DOCKER_HOST" \
    bash "$release/deploy/staging-release.sh" deploy "$sha" "$release"
