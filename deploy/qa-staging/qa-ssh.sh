#!/bin/bash
set -Eeuo pipefail
export LC_ALL=C

usage() {
    printf '%s\n' 'Use SSH with a QA command: status, start, stop, seed, restart-chat, reset, or a documented QA hook.' >&2
    exit 64
}

command_text=${SSH_ORIGINAL_COMMAND:-}
[[ ${#command_text} -le 256 && $command_text =~ ^[A-Za-z0-9_\ -]+$ ]] || usage
IFS=' ' read -r -a args <<<"$command_text"
case ${args[0]:-} in
    status|start|stop|seed|restart-chat|reset|clear|slow-profile|burst|replay-new|arm|release|gate|release-gate|gate-log|wait-locks|revoke|restore|delete-message|delete-chat|storage-down|storage-up|expire-refresh|inspect-chat|inspect-auth|auth-check|auth-log-check) ;;
    *) usage ;;
esac

[[ $(/usr/bin/id -un) == messenger-qa ]] || usage
controller=/opt/messenger-qa-controller
cd -- "$controller"
runtime_dir="/run/user/$(/usr/bin/id -u)"
if [[ ${args[0]} != burst && ${args[0]} != auth-log-check ]]; then
    exec </dev/null
fi
exec /usr/bin/env -i \
    PATH=/opt/messenger-qa-rootless/bin:/usr/sbin:/usr/bin:/bin \
    LC_ALL=C HOME="$controller" DOCKER_CONFIG=/etc/messenger-qa/docker-client \
    QA_ENV_FILE=/etc/messenger-qa/staging.env QA_LOCK_DIR="$runtime_dir" \
    COMPOSE_PARALLEL_LIMIT=1 \
    /bin/bash "$controller/deploy/qa-staging/qa.sh" "${args[@]}"
