"""Exercise the deployed workflow's shell steps with stubbed GitHub and SSH."""
from pathlib import Path
import os
import subprocess
import tempfile
import textwrap


def script(workflow, step):
    body = workflow.split(f"      - name: {step}\n", 1)[1].split("        run: |\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line.strip() and not line.startswith("          "):
            break
        lines.append(line)
    return textwrap.dedent("\n".join(lines))


def main():
    workflow = Path(".github/workflows/deploy.yml").read_text()
    preflight = script(workflow, "Check main and both CI runs")
    deploy = script(workflow, "Run the restricted staging deploy command")
    receiver = Path("deploy/staging-ssh-receiver.sh").read_text()
    receiver_gate = (
        'die() { echo "$*" >&2; exit 1; }\nsha=$RELEASE_SHA\nrepo=$GH_REPO\n'
        + "github() {"
        + receiver.split("github() {", 1)[1].split("\ninstall -d", 1)[0]
        + "\nverify_release\n"
    )
    sha = "a" * 40
    newer = "b" * 40
    assert 'workflows: ["Go CI", "Frontend CI"]' in workflow
    assert "group: deploy-staging-${{ needs.preflight.outputs.sha }}" in workflow
    assert "deployment: false" in workflow
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        gh = root / "gh"
        gh.write_text("""#!/usr/bin/env bash
case "$2" in
    */git/ref/heads/main) printf '%s\\n' "$TEST_MAIN" ;;
    */workflows/ci.yml/*) printf '%s\\n' "$TEST_GO" ;;
    */workflows/frontend-ci.yml/*) printf '%s\\n' "$TEST_FRONTEND" ;;
    *) exit 42 ;;
esac
""")
        ssh = root / "ssh"
        ssh.write_text("""#!/usr/bin/env bash
printf 'SSH called\\n' >> "$TEST_SSH_LOG"
printf '%s\\n' "$TEST_REMOTE_RESULT"
exit "$TEST_REMOTE_EXIT"
""")
        gh.chmod(0o700)
        ssh.chmod(0o700)
        curl = root / "curl"
        curl.write_text("""#!/usr/bin/env python3
import json, os, sys
target = sys.argv[-1].split("?", 1)[0]
if target.endswith("git/ref/heads/main"):
    print(json.dumps({"object": {"sha": os.environ["TEST_MAIN"]}}))
else:
    result = os.environ["TEST_FRONTEND" if target.endswith("frontend-ci.yml/runs") else "TEST_GO"]
    print(json.dumps({"workflow_runs": [{
        "head_sha": os.environ["TEST_CI_SHA"], "head_branch": "main", "event": "push",
        "status": "in_progress" if result == "pending" else "completed",
        "conclusion": result,
    }]}))
""")
        curl.chmod(0o700)
        output = root / "output"
        ssh_log = root / "ssh.log"
        defaults = dict(os.environ, PATH=tmp + ":" + os.environ["PATH"],
                        STAGING_CD_ENABLED="true", TEST_MAIN=sha, TEST_GO="success",
                        TEST_FRONTEND="success", RELEASE_SHA=sha, GH_REPO="fixture/repo",
                        GITHUB_OUTPUT=str(output), STAGING_SSH_KEY="test-only",
                        STAGING_KNOWN_HOSTS="test-only", STAGING_SSH_HOST="test.invalid",
                        TEST_REMOTE_EXIT="0", TEST_SSH_LOG=str(ssh_log), TEST_CI_SHA=sha)

        def check(body, wanted, status=0, ssh_calls="", stdout="", **overrides):
            output.write_text("")
            ssh_log.write_text("")
            res = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", body],
                                 env=defaults | overrides, text=True, capture_output=True)
            assert res.returncode == status, (res.stdout, res.stderr)
            assert output.read_text() == wanted, res.stdout
            assert ssh_log.read_text() == ssh_calls, res.stdout
            assert res.stdout.startswith(stdout), res.stdout

        check(preflight, "", STAGING_CD_ENABLED="false")
        check(preflight, "", TEST_FRONTEND="pending")  # Go completes first.
        check(preflight, f"sha={sha}\n")                # Frontend completion starts a new gate.
        check(preflight, "", TEST_GO="pending")        # Frontend completes first.
        check(preflight, "", TEST_FRONTEND="failure")
        check(preflight, "", TEST_MAIN=newer)
        check(deploy, "", TEST_MAIN=newer)             # Superseded while queued.
        check(deploy, "", ssh_calls="SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT skipped {sha}")
        check(deploy, "", ssh_calls="SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT already_active {sha}")
        check(deploy, "", 1, "SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT deployed {newer}")
        check(deploy, "", 1, "SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT deployed {sha}", TEST_REMOTE_EXIT="1")
        check(deploy, f"deployed_sha={sha}\n", ssh_calls="SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT deployed {sha}")
        check(receiver_gate, "", stdout=f"STAGING_RESULT skipped {sha}", TEST_MAIN=newer)
        check(receiver_gate, "", 1, TEST_FRONTEND="failure")
        check(receiver_gate, "", 1, TEST_GO="pending")
        check(receiver_gate, "", 1, TEST_CI_SHA=newer)
        check(receiver_gate, "")
    print("PASS: CI order, wrong and pending SHAs, stale queue, skipped/duplicate/failed/confirmed deployments")


if __name__ == "__main__":
    main()
