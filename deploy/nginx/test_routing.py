"""Test committed ingress configs with real Docker Nginx and echo backends.

Requires Python 3, Docker and OpenSSL. No application secrets or database needed.
"""

import http.client
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parent
IMAGE = os.environ.get("NGINX_TEST_IMAGE", "nginx:alpine")


def docker(*args):
    return subprocess.check_output(
        ["docker", *args], text=True, stderr=subprocess.STDOUT, timeout=120
    ).strip()


class RoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="messenger-nginx-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.work = Path(cls.temp.name)
        cls.network = "messenger-nginx-" + uuid.uuid4().hex[:12]
        docker("network", "create", cls.network)
        cls.addClassCleanup(docker, "network", "rm", cls.network)
        cls.containers = []
        cls.addClassCleanup(cls.remove_containers)
        for backend in ("auth", "history", "chat"):
            config = cls.work / (backend + ".conf")
            config.write_text(
                'events {}\nhttp { server { listen 8080; location / {\n'
                'default_type text/plain;\n'
                f'return 200 "{backend}|$request_method|$request_uri|$http_authorization";\n'
                '} } }\n', encoding="utf-8",
            )
            cls.start("--network-alias", backend, "-v", f"{config}:/etc/nginx/nginx.conf:ro")
        certs = cls.work / "certs"
        certs.mkdir()
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-days", "1", "-subj", "/CN=staging.example.com",
             "-addext", "subjectAltName=DNS:staging.example.com",
             "-keyout", str(certs / "privkey.pem"), "-out", str(certs / "fullchain.pem")],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        challenge = cls.work / "acme" / ".well-known" / "acme-challenge"
        challenge.mkdir(parents=True)
        (challenge / "routing-test").write_text("acme-ok", encoding="utf-8")
        cls.edges = {}
        for config, ports in (
            ("nginx.conf", (8080,)), ("acme.conf", (80,)),
            ("staging.conf.example", (80, 443)),
        ):
            mounts = [
                "-v", f"{ROOT / config}:/etc/nginx/nginx.conf:ro",
                "-v", f"{ROOT / 'snippets'}:/etc/nginx/messenger/snippets:ro",
                "-v", f"{certs}:/etc/letsencrypt/live/staging.example.com:ro",
                "-v", f"{cls.work / 'acme'}:/var/www/acme:ro",
            ]
            published = [arg for port in ports for arg in ("-p", f"127.0.0.1::{port}")]
            container = cls.start(*mounts, *published)
            # Exact repository configs are mounted unchanged.
            print(config + ": " + docker("exec", container, "nginx", "-t"), flush=True)
            for port in ports:
                host_port = int(docker("port", container, str(port)).rsplit(":", 1)[1])
                edge = (host_port, port == 443)
                cls.edges[(config, port)] = edge
                for attempt in range(50):
                    try:
                        cls.request(edge, "GET", "/")
                        break
                    except (OSError, http.client.HTTPException):
                        if attempt == 49:
                            raise
                        time.sleep(0.1)

    @classmethod
    def start(cls, *args):
        name = cls.network + "-" + str(len(cls.containers))
        cls.containers.append(name)
        docker("run", "-d", "--name", name, "--network", cls.network, *args, IMAGE)
        return name

    @classmethod
    def remove_containers(cls):
        for name in reversed(cls.containers):
            docker("rm", "-f", name)

    @staticmethod
    def request(edge, method, uri, token=""):
        port, tls = edge
        if tls:
            context = ssl.create_default_context(
                cafile=str(RoutingTest.work / "certs" / "fullchain.pem")
            )
            context.check_hostname = False  # TCP address is the loopback port.
            connection = http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=5)
        else:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            headers = {"Host": "staging.example.com"}
            if token:
                headers["Authorization"] = "Bearer " + token
            connection.request(method, uri, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            connection.close()

    def test_public_routes_preserve_method_uri_and_authorization(self):
        routes = [
            ("POST", "/auth/login", "auth"), ("GET", "/me", "auth"),
            ("GET", "/users/search?prefix=alice", "auth"), ("GET", "/contacts", "auth"),
            ("PUT", "/contacts/x%2F..%2Fid", "auth"),
            ("DELETE", "/contacts/x%252F..%252Fid", "auth"),
            ("POST", "/chats/personal", "history"), ("GET", "/chats", "history"),
            ("GET", "/chats/id/messages?after_seq=2&limit=10", "history"),
            ("GET", "/chats/id/messages/target/context?limit=3", "history"),
            ("GET", "/chats/id/messages/target/context?before_seq=1&limit=%ZZ", "history"),
            ("GET", "/chats/id/messages/x%2f..%2ftarget/context?limit=1", "history"),
            ("POST", "/chats/id/read", "history"), ("GET", "/ws", "chat"),
        ]
        for method, uri in (
            ("GET", "/later"), ("POST", "/later"),
            ("PATCH", "/later/id"), ("POST", "/later/id/done"),
        ):
            for query in ("", "?unexpected=a%2Fb&x=1&x=2", "?bad=%ZZ"):
                routes.append((method, uri + query, "history"))
        routes.extend([
            ("PATCH", "/later/x%2f..%2fid", "history"),
            ("POST", "/later/x%252F..%252Fid/done", "history"),
        ])
        for edge in (self.edges[("nginx.conf", 8080)], self.edges[("staging.conf.example", 443)]):
            for method, uri, backend in routes:
                with self.subTest(edge=edge, method=method, uri=uri):
                    status, _, data = self.request(edge, method, uri, "routing-test-token")
                    self.assertEqual(status, 200)
                    self.assertEqual(data, f"{backend}|{method}|{uri}|Bearer routing-test-token")

    def test_private_and_unknown_routes_are_closed(self):
        for edge in self.edges.values():
            if edge == self.edges[("staging.conf.example", 80)]:
                continue  # Staging HTTP redirects; HTTPS enforces the boundary.
            for uri in (
                "/internal", "/internal/users/id", "/internal%2Fusers%2Fid",
                "/later/%2e%2e/internal/users/id", "/auth/%2e%2e/internal/users/id",
                "/chats/id/messages/target/context/extra", "/chats/id/context",
                "/readyz", "/healthz", "/metrics", "/api/history", "/later-other",
            ):
                with self.subTest(edge=edge, uri=uri):
                    self.assertEqual(self.request(edge, "GET", uri, "routing-test-token")[0], 404)

    def test_acme_and_https_redirect(self):
        for config in ("acme.conf", "staging.conf.example"):
            edge = self.edges[(config, 80)]
            with self.subTest(config=config):
                status, _, body = self.request(edge, "GET", "/.well-known/acme-challenge/routing-test")
                self.assertEqual((status, body), (200, "acme-ok"))
                self.assertEqual(self.request(edge, "GET", "/.well-known/acme-challenge/missing")[0], 404)
        for method in ("GET", "POST", "PATCH"):
            status, headers, _ = self.request(
                self.edges[("staging.conf.example", 80)], method, "/later/id?x=a%2Fb&n=2"
            )
            self.assertEqual(status, 308)
            self.assertEqual(headers["Location"], "https://staging.example.com/later/id?x=a%2Fb&n=2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
