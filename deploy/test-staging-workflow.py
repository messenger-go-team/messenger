"""Exercise the deployed workflow's shell steps with stubbed GitHub and SSH."""
from pathlib import Path
import hashlib
import json
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
    record = script(workflow, "Record the confirmed staging deployment")
    receiver = Path("deploy/staging-ssh-receiver.sh").read_text()
    receiver_gate = (
        'die() { echo "$*" >&2; exit 1; }\nsha=$RELEASE_SHA\nrepo=$GH_REPO\n'
        + "github() {"
        + receiver.split("github() {", 1)[1].split("\ninstall -d", 1)[0]
        + "\nverify_release\n"
    )
    sha = "a" * 40
    newer = "b" * 40
    archive = "test staging artifact\n"
    digest = "sha256:" + hashlib.sha256(archive.encode()).hexdigest()
    activation = "rel.ABC123/next"
    newer_activation = "rel.DEF456/next"
    assert 'workflows: ["Go CI", "Frontend CI"]' in workflow
    assert "group: deploy-staging\n      cancel-in-progress: false" in workflow
    assert "deployment: false" in workflow
    assert "if: steps.release.outputs.activation != ''" in workflow
    assert "RELEASE_SHA: ${{ steps.release.outputs.sha }}" in workflow
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        gh = root / "gh"
        gh.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

args = sys.argv[2:]
mode = args[0]
url = urlsplit(args[2] if mode == "-X" else args[1] if mode == "--paginate" else mode)
if url.path.endswith("/git/ref/heads/main"):
    print(os.environ["TEST_MAIN"])
    sys.exit()
if url.path.endswith("/ci.yml/runs") or url.path.endswith("/frontend-ci.yml/runs"):
    gate = "TEST_FRONTEND" if "frontend-ci" in url.path else "TEST_GO"
    result = os.environ[gate]
    if "run_attempt" in args[-1]:
        if result == "success":
            sha = os.environ.get("TEST_ARTIFACT_SHA") or parse_qs(url.query)["head_sha"][0]
            print(f"{sha}\t200\t2")
    else:
        print(result)
    sys.exit()
if url.path.endswith("/actions/runs/200/artifacts"):
    assert parse_qs(url.query)["name"] == [f"web-dist-{os.environ['RELEASE_SHA']}-attempt-2"]
    if os.environ["TEST_ARTIFACT"] == "present":
        print("300\t" + os.environ["TEST_DIGEST"])
    sys.exit()
if url.path.endswith("/actions/artifacts/300/zip"):
    sys.stdout.write(os.environ["TEST_ARCHIVE"])
    sys.exit()
if "/deployments" not in url.path:
    sys.exit(42)

state = Path(os.environ["TEST_DEPLOYMENTS"])
deployments = json.loads(state.read_text())
failure = os.environ.get("TEST_API_FAILURE")
if url.path.endswith("/deployments"):
    if mode == "--paginate":
        query = parse_qs(url.query)
        print("[]")
        print(json.dumps([d for d in deployments if d["ref"] in query["sha"]
                          and d["environment"] in query["environment"]]))
    else:
        entry = json.load(sys.stdin)
        entry.update(id=len(deployments) + 1, statuses=[])
        deployments.append(entry)
        state.write_text(json.dumps(deployments))
        if failure == "create-response":
            sys.exit(1)
        print(entry["id"])
else:
    deployment_id = int(url.path.split("/")[-2])
    statuses = deployments[deployment_id - 1]["statuses"]
    if mode != "-X":
        if failure == "read-status":
            sys.exit(1)
        print(statuses[-1] if statuses else "")
    elif failure == "write-status":
        sys.exit(1)
    else:
        assert "state=success" in args
        for d in deployments:
            if d["id"] != deployment_id and d["statuses"][-1:] == ["success"]:
                d["statuses"].append("inactive")
        statuses.append("success")
        state.write_text(json.dumps(deployments))
        if failure == "status-response":
            sys.exit(1)
""")
        ssh = root / "ssh"
        ssh.write_text("""#!/usr/bin/env bash
[[ ${!#} == "deploy-web $RELEASE_SHA" ]] || exit 43
[[ $(cat) == "$(printf '%s' "$TEST_ARCHIVE")" ]] || exit 44
printf 'SSH called\\n' >> "$TEST_SSH_LOG"
printf '%s\\n' "$TEST_REMOTE_RESULT"
exit "$TEST_REMOTE_EXIT"
""")
        gh.chmod(0o700)
        ssh.chmod(0o700)
        curl = root / "curl"
        curl.write_text("""#!/usr/bin/env python3
import json, os, sys
from urllib.parse import parse_qs, urlsplit
url = urlsplit(sys.argv[-1])
target = url.path
if target.endswith("git/ref/heads/main"):
    print(json.dumps({"object": {"sha": os.environ["TEST_MAIN"]}}))
elif target.endswith("/actions/runs/200/artifacts"):
    name = parse_qs(url.query)["name"][0]
    assert name == f"web-dist-{os.environ['RELEASE_SHA']}-attempt-2"
    items = [{"name": name, "expired": False, "digest": os.environ["TEST_DIGEST"],
              "size_in_bytes": len(os.environ["TEST_ARCHIVE"].encode())}]
    print(json.dumps({"artifacts": items if os.environ["TEST_ARTIFACT"] == "present" else []}))
else:
    result = os.environ["TEST_FRONTEND" if target.endswith("frontend-ci.yml/runs") else "TEST_GO"]
    print(json.dumps({"workflow_runs": [{
        "head_sha": os.environ["TEST_CI_SHA"], "head_branch": "main", "event": "push",
        "status": "in_progress" if result == "pending" else "completed",
        "conclusion": result, "id": 200, "run_attempt": 2,
    }]}))
""")
        curl.chmod(0o700)
        output = root / "output"
        ssh_log = root / "ssh.log"
        deployments = root / "deployments.json"
        deployments.write_text("[]")
        defaults = dict(os.environ, PATH=tmp + ":" + os.environ["PATH"],
                        STAGING_CD_ENABLED="true", TEST_MAIN=sha, TEST_GO="success",
                        TEST_FRONTEND="success", RELEASE_SHA=sha, GH_REPO="fixture/repo",
                        GITHUB_OUTPUT=str(output), STAGING_SSH_KEY="test-only",
                        STAGING_KNOWN_HOSTS="test-only", STAGING_SSH_HOST="test.invalid",
                        TEST_REMOTE_EXIT="0", TEST_SSH_LOG=str(ssh_log), TEST_CI_SHA=sha,
                        ACTIVATION=activation, TEST_DEPLOYMENTS=str(deployments),
                        GITHUB_SERVER_URL="https://github.com", GITHUB_RUN_ID="123",
                        TEST_ARCHIVE=archive, TEST_DIGEST=digest, TEST_ARTIFACT="present",
                        TEST_RECEIVER_RELEASE=tmp)

        def check(body, wanted, status=0, ssh_calls="", stdout="", stdin=None, **overrides):
            output.write_text("")
            ssh_log.write_text("")
            res = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", body],
                                 env=defaults | overrides, text=True, capture_output=True, input=stdin)
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
        check(deploy, "", TEST_MAIN=newer, TEST_FRONTEND="pending")
        check(deploy, "", TEST_MAIN=newer, TEST_GO="failure")
        check(deploy, "", 1, TEST_ARTIFACT_SHA=newer)
        check(deploy, "", 1, TEST_ARTIFACT="missing")
        check(deploy, "", 1, TEST_DIGEST="sha256:" + "0" * 64)
        check(deploy, "", ssh_calls="SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT skipped {sha}")
        for receipt in (f"deployed {newer} {activation}", f"deployed {sha}",
                        f"deployed {sha} rel.ABC123/other"):
            check(deploy, "", 1, "SSH called\n", TEST_REMOTE_RESULT="STAGING_RESULT " + receipt)
        check(deploy, "", 1, "SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT deployed {sha} {activation}",
              TEST_REMOTE_EXIT="1")
        for result in ("deployed", "already_active"):
            check(deploy, f"sha={sha}\nactivation={activation}\n", ssh_calls="SSH called\n",
                  TEST_REMOTE_RESULT=f"STAGING_RESULT {result} {sha} {activation}")
        check(receiver_gate, "", stdout=f"STAGING_RESULT skipped {sha}", TEST_MAIN=newer)
        check(receiver_gate, "", 1, TEST_FRONTEND="failure")
        check(receiver_gate, "", 1, TEST_GO="pending")
        check(receiver_gate, "", 1, TEST_CI_SHA=newer)
        check(receiver_gate, "")
        receiver_upload = receiver_gate + '\nrelease=$TEST_RECEIVER_RELEASE\nreceive_web\n'
        check(receiver_upload, "", stdin=archive)
        assert (root / "web.zip").read_text() == archive
        assert (root / "web.digest").read_text().strip() == digest.removeprefix("sha256:")
        check(receiver_upload, "", 1, stdin=archive + "x")
        check(receiver_upload, "", 1, stdin=archive.replace("test", "fake"))
        check(receiver_upload, "", 1, stdin=archive, TEST_ARTIFACT="missing")

        def history():
            return [d["statuses"] for d in json.loads(deployments.read_text())]

        check(record, "", 1, TEST_API_FAILURE="create-response")
        assert history() == [[]]  # Creation happened even though the response was lost.
        check(record, "", 1, TEST_API_FAILURE="write-status")
        assert history() == [[]]
        check(record, "", 1, TEST_API_FAILURE="status-response")
        assert history() == [["success"]]
        check(record, "", 1, TEST_API_FAILURE="read-status")
        assert history() == [["success"]]
        check(record, "", stdout="Deployment 1 is already recorded")
        assert history() == [["success"]]
        # The next job in the shared staging slot records the next release.
        check(record, "", RELEASE_SHA=newer, ACTIVATION=newer_activation)
        assert history() == [["success", "inactive"], ["success"]]
        # Even if a delayed old job replaced the pending job for the new SHA,
        # it reports the actual latest release, then reuses its existing status.
        check(deploy, f"sha={newer}\nactivation={newer_activation}\n", TEST_MAIN=newer,
              ssh_calls="SSH called\n", TEST_REMOTE_RESULT=f"STAGING_RESULT already_active {newer} {newer_activation}")
        check(record, "", RELEASE_SHA=newer, ACTIVATION=newer_activation, stdout="Deployment 2 is already recorded")
        assert history() == [["success", "inactive"], ["success"]]
    print("PASS: CI gates, SSH receipts, retry after ambiguous API failures, no duplicates, and ordered statuses")


if __name__ == "__main__":
    main()
