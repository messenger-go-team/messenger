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
[[ $command =~ ^(deploy|deploy-web)\ ([a-f0-9]{40})$ ]] || die 'expected deploy-web followed by the full SHA'
mode=${BASH_REMATCH[1]}
sha=${BASH_REMATCH[2]}
root="$HOME/messenger36-stage"

github() {
    curl -fsS --proto '=https' --max-time 20 --retry 2 -H 'Cache-Control: no-cache' \
        "https://api.github.com/repos/$repo/$1"
}

verify_release() {
    local current ci line result ci_id ci_attempt
    current=$(github git/ref/heads/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])') \
        || die 'cannot verify main on GitHub'
    [[ $current =~ ^[a-f0-9]{40}$ ]] || die 'GitHub returned an invalid main SHA'
    if [[ $current != "$sha" ]]; then
        printf 'STAGING_RESULT skipped %s\n' "$sha"
        exit 0
    fi
    for ci in ci.yml frontend-ci.yml; do
        line=$(github "actions/workflows/$ci/runs?branch=main&event=push&head_sha=$sha&per_page=1" |
            python3 -c 'import json,sys
runs = json.load(sys.stdin)["workflow_runs"]
r = runs[0] if runs else {}
valid = (r.get("head_sha") == sys.argv[1] and r.get("event") == "push"
         and r.get("head_branch") == "main" and r.get("status") == "completed")
print(r.get("conclusion") if valid else "not_verified", r.get("id", ""), r.get("run_attempt", ""))' "$sha") \
            || die "cannot verify $ci for $sha"
        read -r result ci_id ci_attempt <<< "$line"
        [[ $result == success ]] || die "$ci is not successful for $sha ($result)"
        if [[ $ci == frontend-ci.yml ]]; then
            frontend_run=$ci_id
            frontend_attempt=$ci_attempt
        fi
    done
}

receive_web() {
    local name metadata digest bytes
    [[ $frontend_run =~ ^[0-9]+$ && $frontend_attempt =~ ^[0-9]+$ ]] || die 'invalid Frontend CI run'
    name="web-dist-$sha-attempt-$frontend_attempt"
    metadata=$(github "actions/runs/$frontend_run/artifacts?name=$name" |
        python3 -c 'import json,sys
items = [a for a in json.load(sys.stdin)["artifacts"] if a["name"] == sys.argv[1] and a["expired"] is False]
if len(items) != 1:
    sys.exit("expected one current Frontend CI artifact")
print(items[0]["digest"], items[0]["size_in_bytes"])' "$name") || die 'cannot verify web artifact metadata'
    read -r digest bytes <<< "$metadata"
    [[ $digest =~ ^sha256:[0-9a-f]{64}$ && $bytes =~ ^[1-9][0-9]{0,8}$ ]] || die 'invalid web artifact metadata'
    (( bytes <= 64 * 1024 * 1024 )) || die 'web archive exceeds 64 MiB'
    head -c "$((bytes + 1))" > "$release/web.zip"
    [[ $(wc -c < "$release/web.zip") -eq $bytes ]] || die 'web archive size mismatch'
    printf '%s  %s\n' "${digest#sha256:}" "$release/web.zip" | sha256sum --status -c - || die 'web archive digest mismatch'
    printf '%s\n' "${digest#sha256:}" > "$release/web.digest"
    printf 'staging receiver: verified %s (%s)\n' "$name" "$digest"
}


install -d -m 0700 "$root/releases"
exec 9>"$root/releases/.receiver.lock"
flock -w 1200 9 || die 'timed out waiting for another deployment'
verify_release

release=$(mktemp -d "$root/releases/$sha.XXXXXX")
if [[ $mode == deploy-web ]]; then
    trap 'rm -f "$release/web.zip"' EXIT
    receive_web
    selected_frontend="$frontend_run/$frontend_attempt"
fi
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 --retry 2 \
    "https://codeload.github.com/$repo/tar.gz/$sha" -o "$release/source.tar.gz"
tar -xzf "$release/source.tar.gz" -C "$release" --strip-components=1
rm "$release/source.tar.gz"
if [[ $mode == deploy && -f $release/deploy/staging-web.py ]]; then
    die 'this revision requires deploy-web with a Frontend CI artifact'
fi
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
if [[ $mode == deploy-web && $selected_frontend != "$frontend_run/$frontend_attempt" ]]; then
    die 'Frontend CI changed while preparing the release'
fi
env -i PATH="$PATH" HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DOCKER_HOST="$DOCKER_HOST" \
    bash "$release/deploy/staging-release.sh" deploy "$sha" "$release"
