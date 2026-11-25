#!/usr/bin/env bash
# Exercise the production upload verifier with a real artifact and an isolated forced SSH command.
set -Eeuo pipefail

repo=$GITHUB_REPOSITORY
sha=$GITHUB_SHA
name="web-dist-$sha-attempt-$GITHUB_RUN_ATTEMPT"
lab=$(mktemp -d "$HOME/.staging-ssh-test.XXXXXXXX")
daemon=
cleanup() {
    if [[ -n $daemon ]]; then sudo kill "$daemon" 2>/dev/null || true; fi
    rm -rf -- "$lab"
}
trap cleanup EXIT
for ((attempt=1; attempt<=10; attempt++)); do
    id=$(gh api "repos/$repo/actions/runs/$GITHUB_RUN_ID/artifacts?name=$name" \
        --jq '.artifacts | map(select(.expired == false)) | if length == 1 then .[0].id else empty end')
    if [[ $id =~ ^[0-9]+$ ]]; then break; fi
    sleep 2
done
[[ $id =~ ^[0-9]+$ ]]
gh api "repos/$repo/actions/artifacts/$id/zip" > "$lab/source.zip" 2>"$lab/download.log" ||
    { echo 'could not download the uploaded Frontend CI ZIP' >&2; exit 1; }

# Shared runner IPs may exhaust the anonymous GitHub API quota. The test
# receiver uses the runner's read-only token, stored locally and never sent via SSH.
(umask 077; printf '%s' "$GH_TOKEN" > "$lab/gh.token")
{
    printf '#!/usr/bin/env bash\nset -Eeuo pipefail\n'
    printf 'repo=%q\nsha=%q\nfrontend_run=%q\nfrontend_attempt=%q\nrelease=%q\n' \
        "$repo" "$sha" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$lab"
    printf 'die() { echo "$*" >&2; exit 1; }\n'
    printf '%s\n' 'github() { GH_TOKEN=$(<"$release/gh.token") gh api "repos/$repo/$1"; }'
    # Execute the exact size and SHA-256 verifier from the installed receiver.
    sed -n '/^receive_web() {/,/^}/p' deploy/staging-ssh-receiver.sh
    printf '[[ $SSH_ORIGINAL_COMMAND == "deploy-web $sha" ]] || exit 1\nreceive_web\n'
} > "$lab/receiver"
chmod 0700 "$lab/receiver"
ssh-keygen -q -N '' -t ed25519 -f "$lab/host"
ssh-keygen -q -N '' -t ed25519 -f "$lab/client"
printf 'restrict,command="%s" %s\n' "$lab/receiver" "$(cat "$lab/client.pub")" > "$lab/authorized_keys"
chmod 0600 "$lab/authorized_keys"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
cat > "$lab/sshd.conf" <<EOF
ListenAddress 127.0.0.1
Port $port
PidFile $lab/sshd.pid
HostKey $lab/host
AuthorizedKeysFile $lab/authorized_keys
AllowUsers $(id -un)
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
EOF
if [[ ! -x /usr/sbin/sshd ]]; then
    sudo apt-get update
    sudo apt-get install -y openssh-server
fi
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -t -f "$lab/sshd.conf"
sudo /usr/sbin/sshd -f "$lab/sshd.conf" -E "$lab/sshd.log"
daemon=$(cat "$lab/sshd.pid")
printf '[127.0.0.1]:%s %s\n' "$port" "$(cut -d ' ' -f 1,2 "$lab/host.pub")" > "$lab/known_hosts"
client=(ssh -T -p "$port" -i "$lab/client" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$lab/known_hosts" 127.0.0.1)
"${client[@]}" "deploy-web $sha" < "$lab/source.zip"
cmp "$lab/source.zip" "$lab/web.zip"
printf junk > "$lab/invalid.zip"
if "${client[@]}" "deploy-web $sha" < "$lab/invalid.zip"; then
    echo 'forced command accepted an invalid upload' >&2
    exit 1
fi
echo 'PASS: Actions artifact download, real SSH stdin, forced command and GitHub digest verification'
