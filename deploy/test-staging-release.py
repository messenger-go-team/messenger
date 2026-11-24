"""Integration regression for staging release and rollback. Run in WSL/Linux.

Requires Git history, Go, Docker with Compose, OpenSSL and curl. Uses dedicated containers
and a temporary database. Run from the repository root.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

REPO = Path.cwd()
SERVICES = ("auth", "chat", "history")
# Pre-v3 staging release (deployment 8012113499), including the old Nginx routes.
HISTORY_V2_SHA = "bf1c63770832eff9f8a6fa561957ecc4596af78b"
A, B, C, D = (char * 40 for char in "abcd")
RELEASES = (HISTORY_V2_SHA, A, B, C, D)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def out(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    os.umask(0o077)
    project = "messenger36-stage-test" + secrets.token_hex(4)
    edge, outer = project + "-inner", project + "-public"
    go = os.environ.get("GO_BIN", "go")
    with tempfile.TemporaryDirectory(prefix="messenger-cd-test-") as temp:
        work = Path(temp)
        baseline = work / "baseline"
        baseline.mkdir()
        with tempfile.TemporaryFile() as archive:
            run("git", "archive", HISTORY_V2_SHA, stdout=archive)
            archive.seek(0)
            run("tar", "-xf", "-", "-C", str(baseline), stdin=archive)
        binaries = work / "binaries"
        binaries.mkdir()
        nginx = work / "nginx"
        snippets = nginx / "snippets"
        shutil.copytree(REPO / "deploy/nginx/snippets", snippets)
        shutil.copyfile(REPO / "deploy/staging-rootless/nginx.conf", nginx / "nginx.conf")
        (snippets / "release-marker.conf").write_text('return 200 "baseline";\n')
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        origin = f"https://127.0.0.1:{port}"
        jwt, internal = secrets.token_hex(32), secrets.token_hex(32)
        admin_dsn = "postgres://postgres:lab-owner@postgres/messenger_stage?sslmode=disable"
        history_dsn = "postgres://messenger36_history:lab-runtime@postgres/messenger_stage?sslmode=disable"
        goenv = dict(os.environ, CGO_ENABLED="0")
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            jobs = [
                pool.submit(run, go, "build", "-trimpath", "-o", str(binaries / (service + suffix)),
                            f"./services/{service}", cwd=source, env=goenv)
                for source, suffix in ((REPO, ""), (baseline, "-v2"))
                for service in SERVICES
            ]
            jobs += [
                pool.submit(run, go, "build", "-trimpath", "-o", str(work / name), package, env=goenv)
                for name, package in (("migrate", "./cmd/migrate"),
                                      ("staging-wss-probe", "./cmd/staging-wss-probe"))
            ]
            for job in jobs:
                job.result()

        def release(sha, snippet):
            path = work / f"release-{sha[0]}"
            for folder in ("services/auth/migrations", "services/history/migrations"):
                shutil.copytree(REPO / folder, path / folder)
            dest = path / "deploy/nginx/snippets/public-locations.conf"
            dest.parent.mkdir(parents=True)
            dest.write_text(snippet)
            (path / "REVISION").write_text(sha + "\n")
            shutil.copy2(work / "migrate", path / "migrate")
            return path

        original = (snippets / "public-locations.conf").read_text()
        a = release(A, original)
        shutil.copy2(work / "migrate", baseline / "migrate")
        baseline_snippet = (baseline / "deploy/nginx/snippets/public-locations.conf").read_text()
        (snippets / "public-locations.conf").write_text(baseline_snippet)
        b = release(B, original + "\n# release B\n")
        c = release(C, original + "\ninvalid_staging_test_directive on;\n")
        start = original.index("location = /ws {")
        end = original.index("\n}", start) + 2
        d = release(D, original[:start] + "location = /ws { return 404; }" + original[end:])

        (work / "compose.yaml").write_text(json.dumps({"services": {
            "postgres": {"image": "postgres:18-alpine", "environment": {
                "POSTGRES_DB": "messenger_stage", "POSTGRES_USER": "postgres", "POSTGRES_PASSWORD": "lab-owner"}},
            "auth": {"image": f"{project}-auth:{HISTORY_V2_SHA}", "environment": {
                "AUTH_DATABASE_URL": admin_dsn, "JWT_SECRET": jwt, "AUTH_INTERNAL_TOKEN": internal}},
            "chat": {"image": f"{project}-chat:{HISTORY_V2_SHA}", "environment": {
                "JWT_SECRET": jwt, "WS_ALLOWED_ORIGINS": origin}},
            "history": {"image": f"{project}-history:{HISTORY_V2_SHA}", "environment": {
                "HISTORY_DATABASE_URL": history_dsn, "JWT_SECRET": jwt, "AUTH_INTERNAL_TOKEN": internal}},
            "ingress": {"image": "nginx:alpine", "container_name": edge, "volumes": [
                f"{nginx/'nginx.conf'}:/etc/nginx/nginx.conf:ro",
                f"{snippets}:/etc/nginx/messenger/snippets:ro"]},
        }}))
        compose = ("docker", "compose", "-p", project, "-f", str(work / "compose.yaml"))
        network = project + "_default"

        def sql(query):
            return run(*compose, "exec", "-T", "postgres", "psql", "-XAt", "-U", "postgres",
                       "-d", "messenger_stage", "-v", "ON_ERROR_STOP=1",
                       input=query, capture_output=True).stdout.strip()

        try:
            # Distinct OCI revisions let the test verify each selected image.
            # The pre-v3 deployment also uses binaries compiled from its own source.
            for sha in RELEASES:
                for service in SERVICES:
                    filename = f"{service}-v2" if sha == HISTORY_V2_SHA else service
                    recipe = f'FROM scratch\nCOPY --chmod=0555 {filename} /service\nUSER 65532:65532\nENTRYPOINT ["/service"]\n'
                    run("docker", "build", "-q", "-f", "-", "--label",
                        f"org.opencontainers.image.revision={sha}",
                        "-t", f"{project}-{service}:{sha}", str(binaries), input=recipe)

            run(*compose, "up", "-d", "postgres")
            for _ in range(60):
                ready = subprocess.run([*compose, "exec", "-T", "postgres", "pg_isready", "-h", "127.0.0.1"],
                                       stdout=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                time.sleep(.25)
            else:
                raise RuntimeError("local Postgres did not start")
            run("docker", "run", "--rm", "--network", network,
                "-e", "POSTGRES_DB=messenger_stage", "-e", "POSTGRES_HOST=postgres", "-e", "POSTGRES_PORT=5432",
                "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=lab-owner", "-e", "POSTGRES_SSLMODE=disable",
                "-v", f"{baseline}:/release:ro", "-w", "/release", "--entrypoint", "/release/migrate",
                "postgres:18-alpine", "-service=all", "-direction=up")
            sql("""
                CREATE ROLE messenger36_history LOGIN PASSWORD 'lab-runtime';
                GRANT USAGE ON SCHEMA history TO messenger36_history;
                GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA history TO messenger36_history;
                GRANT UPDATE (last_seq) ON history.chats TO messenger36_history;
                GRANT UPDATE (last_read_seq,last_delivered_seq) ON history.chat_members TO messenger36_history;
                GRANT UPDATE (id) ON history.messages TO messenger36_history;
                GRANT UPDATE (due_at,state,updated_at) ON history.later_entries TO messenger36_history;
                INSERT INTO history.chats (type,last_seq) VALUES ('personal',8);
            """)
            run(*compose, "up", "-d", "--no-deps", *SERVICES)
            run(*compose, "up", "-d", "--no-deps", "ingress")

            cert, key = work / "cert.pem", work / "key.pem"
            run("openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                "-keyout", str(key), "-out", str(cert), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            proxy = (REPO / "deploy/staging-rootless/outer-location.conf.example").read_text()
            proxy = proxy.replace("http://127.0.0.1:18080", f"http://{edge}:8080")
            (work / "outer.conf").write_text(f"""events {{}}
http {{
    map $http_upgrade $connection_upgrade {{ default upgrade; '' close; }}
    server {{
        listen 443 ssl;
        ssl_certificate /lab/cert.pem;
        ssl_certificate_key /lab/key.pem;
        {proxy}
    }}
}}
""")
            run("docker", "run", "-d", "--name", outer, "--network", network, "-p", f"127.0.0.1:{port}:443",
                "-v", f"{work/'outer.conf'}:/etc/nginx/nginx.conf:ro",
                "-v", f"{cert}:/lab/cert.pem:ro", "-v", f"{key}:/lab/key.pem:ro", "nginx:alpine")

            credentials = {"username": "staging_probe", "password": secrets.token_urlsafe(24)}
            file = work / "wss-probe.json"
            file.write_text(json.dumps(credentials))
            req = urllib.request.Request(origin + "/auth/register", json.dumps(credentials).encode(),
                                         {"Content-Type": "application/json"})
            context = ssl.create_default_context(cafile=cert)
            for retry in range(25):
                try:
                    with urllib.request.urlopen(req, context=context, timeout=5) as resp:
                        assert resp.status == 201
                        probe_user = json.load(resp)['id']
                    break
                except (urllib.error.URLError, ConnectionError):
                    if retry == 24:
                        raise
                    time.sleep(.3)

            env = dict(os.environ, STAGING_ROOT=str(work), STAGING_PROJECT=project, STAGING_INGRESS=edge,
                       STAGING_SNIPPETS=str(snippets), STAGING_URL=origin,
                       STAGING_WSS_PROBE=str(work / "staging-wss-probe"),
                       CURL_CA_BUNDLE=str(cert), SSL_CERT_FILE=str(cert))
            script = ("bash", str(REPO / "deploy/staging-release.sh"))
            state = work / ".release-state"

            def deploy(sha, path, expect):
                result = subprocess.run([*script, "deploy", sha, str(path)], env=env, text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                print(result.stdout, end="", flush=True)
                assert result.returncode == expect, result.stdout
                return result.stdout

            def running_revisions():
                return [
                    out("docker", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                        out(*compose, "ps", "-q", service))
                    for service in SERVICES
                ]

            db_container = out(*compose, "ps", "-q", "postgres")
            assert running_revisions() == [HISTORY_V2_SHA] * len(SERVICES)
            chat_id = sql("SELECT id FROM history.chats")
            peer_id = "00000000-0000-4000-8000-000000000002"
            sql(f"""
                INSERT INTO history.chat_members(chat_id,user_id,role,last_read_seq,last_delivered_seq)
                VALUES ('{chat_id}','{probe_user}','member',3,5),
                       ('{chat_id}','{peer_id}','member',2,4);
            """)
            assert sql("SELECT version,dirty FROM public.history_schema_migrations") == "2|f"
            run("docker", "exec", edge, "wget", "-qO", "/dev/null", "http://history:8080/readyz")
            a_log = deploy(A, a, 0)
            a_activation = (state / "current").read_text().strip()
            assert a_log.splitlines()[-1] == f"STAGING_RESULT deployed {A} {a_activation}"
            assert (state / a_activation).parent.joinpath("previous/receipts.status").read_text() == "404\n"
            assert "applying migrations before switching services (1:false,2:false)" in a_log
            assert "saved DB dump" in a_log
            assert "HTTPS /chats/00000000-0000-4000-8000-000000000001/receipts -> 401" in a_log
            assert sql("SELECT version,dirty FROM public.history_schema_migrations;") == "3|f"
            assert sql(f"SELECT last_read_seq,last_delivered_seq FROM history.chat_members WHERE user_id='{probe_user}'") == "3|5"
            login = urllib.request.Request(origin + "/auth/login", json.dumps(credentials).encode(),
                                           {"Content-Type": "application/json"})
            with urllib.request.urlopen(login, context=context, timeout=5) as resp:
                token = json.load(resp)["access_token"]
            receipts = urllib.request.Request(origin + f"/chats/{chat_id}/receipts",
                                              headers={"Authorization": f"Bearer {token}"})
            def assert_receipts(cursors):
                with urllib.request.urlopen(receipts, context=context, timeout=5) as resp:
                    assert resp.status == 200
                    assert resp.headers["Cache-Control"] == "no-store"
                    assert json.load(resp) == {"chat_id": chat_id, "members": [
                        {"user_id": user, "last_read_seq": read, "last_delivered_seq": delivered}
                        for user, (read, delivered) in sorted(cursors.items())
                    ]}

            assert_receipts({probe_user: (0, 0), peer_id: (0, 0)})
            sql(f"""
                SET ROLE messenger36_history;
                UPDATE history.chat_members SET public_last_read_seq=2,public_last_delivered_seq=6
                WHERE chat_id='{chat_id}' AND user_id='{probe_user}';
                UPDATE history.chat_members SET public_last_read_seq=1,public_last_delivered_seq=4
                WHERE chat_id='{chat_id}' AND user_id='{peer_id}';
            """)
            public_cursors = {probe_user: (2, 6), peer_id: (1, 4)}
            assert_receipts(public_cursors)

            def assert_v3_data():
                assert out(*compose, "ps", "-q", "postgres") == db_container
                assert sql("SELECT version,dirty FROM public.history_schema_migrations") == "3|f"
                assert sql(f"""
                    SELECT last_read_seq,last_delivered_seq,public_last_read_seq,public_last_delivered_seq
                    FROM history.chat_members WHERE chat_id='{chat_id}' ORDER BY user_id='{probe_user}' DESC
                """).splitlines() == ["3|5|2|6", "2|4|1|4"]

            run(*script, "rollback", env=env)
            assert running_revisions() == [HISTORY_V2_SHA] * len(SERVICES)
            assert (snippets / "public-locations.conf").read_text() == baseline_snippet
            run("docker", "exec", edge, "wget", "-qO", "/dev/null", "http://history:8080/readyz")
            try:
                with urllib.request.urlopen(receipts, context=context, timeout=5):
                    raise AssertionError("previous release unexpectedly exposes receipts")
            except urllib.error.HTTPError as error:
                with error:
                    assert error.code == 404, error
            assert_v3_data()
            print("PASS: rollback to v2 binaries preserves readiness, v3 schema and public cursors", flush=True)

            deploy(A, a, 0)
            assert_receipts(public_cursors)
            b_log = deploy(B, b, 0)
            b_pointer = (state / "current").read_text()
            b_activation = b_pointer.strip()
            assert b_activation != a_activation
            assert b_log.splitlines()[-1] == f"STAGING_RESULT deployed {B} {b_activation}"
            b_container = out(*compose, "ps", "-q", "history")
            assert deploy(B, b, 0).splitlines()[-1] == f"STAGING_RESULT already_active {B} {b_activation}"
            assert out(*compose, "ps", "-q", "history") == b_container
            assert (state / "current").read_text() == b_pointer
            assert "invalid_staging_test_directive" in deploy(C, c, 1)
            assert (state / "current").read_text() == b_pointer
            assert "public WSS returned HTTP 404" in deploy(D, d, 1)
            assert (state / "current").read_text() == b_pointer
            assert not (state / "pending").exists()
            assert deploy(B, b, 0).splitlines()[-1] == f"STAGING_RESULT already_active {B} {b_activation}"
            run(*script, "rollback", env=env)
            assert running_revisions() == [A] * len(SERVICES)
            assert (snippets / "public-locations.conf").read_text() == original
            assert sql("SELECT count(*) FROM history.chats") == "1"
            assert_v3_data()
            assert_receipts(public_cursors)
            print("PASS: v2→v3, authenticated HTTPS receipts, A → B → duplicate B → failed C and broken WSS → B → manual rollback A")
        finally:
            subprocess.run(["docker", "rm", "-f", outer], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run([*compose, "down", "-v"], check=False, stdout=subprocess.DEVNULL)
            for sha in RELEASES:
                for service in SERVICES:
                    subprocess.run(["docker", "image", "rm", f"{project}-{service}:{sha}"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Only image tags owned by this temporary project.
            for line in out("docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}").splitlines():
                if line.startswith(project + "-cd-"):
                    subprocess.run(["docker", "image", "rm", line],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
