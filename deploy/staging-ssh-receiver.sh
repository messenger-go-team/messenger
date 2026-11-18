#!/usr/bin/env bash
# Install outside release directories as the dedicated key's forced SSH command.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
root=/root/messenger36-stage
repo=messenger-go-team/messenger

die() { printf 'staging receiver: %s\n' "$*" >&2; exit 1; }
command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == probe ]]; then
    printf 'staging receiver ready\n'
    exit 0
fi
[[ $command =~ ^deploy\ ([a-f0-9]{40})$ ]] || die 'expected deploy followed by the full SHA'
sha=${BASH_REMATCH[1]}
main_sha() {
    curl -fsS --proto '=https' --max-time 20 --retry 2 -H 'Cache-Control: no-cache' \
        "https://api.github.com/repos/$repo/git/ref/heads/main" |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])'
}

install -d -m 0700 "$root/releases"
exec 9>"$root/releases/.receiver.lock"
flock -n 9 || die 'another receiver is busy'
current=$(main_sha) || die 'cannot verify main on GitHub'
if [[ $current != "$sha" ]]; then
    printf 'Skipping superseded commit %s\n' "$sha"
    exit 0
fi

# Each attempt gets its own directory, including reruns of the same SHA.
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
    "golang:$go_version-alpine" go build -trimpath -o migrate ./cmd/migrate
for service in auth chat history; do
    docker build --label "org.opencontainers.image.revision=$sha" \
        -f "$release/services/$service/Dockerfile" \
        -t "messenger36-stage-$service:$sha" "$release"
done

# Check again after the builds so an older commit cannot supersede a new main.
current=$(main_sha) || die 'cannot verify main on GitHub after build'
if [[ $current != "$sha" ]]; then
    printf 'Skipping superseded commit %s after build\n' "$sha"
    exit 0
fi
# The workflow key supplies only a SHA. Deployment code comes from main.
env -i PATH="$PATH" HOME=/root bash "$release/deploy/staging-release.sh" deploy "$sha" "$release"
