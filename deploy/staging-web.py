"""Install and smoke-test an immutable staging web release."""
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import HTTPRedirectHandler, build_opener
import zipfile

SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"[a-f0-9]{64}")
NAME = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")
ENTRY = re.compile(r"/app/assets/[A-Za-z0-9_-]+\.(js|css)")
MAX_UNPACKED = 128 * 1024 * 1024


class IndexAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        path = None
        if tag == "script":
            path = attrs.get("src")
        if tag == "link" and attrs.get("rel") == "stylesheet":
            path = attrs.get("href")
        if path is not None:
            if not ENTRY.fullmatch(path):
                raise ValueError(f"invalid staging entry asset: {path}")
            self.paths.add(path)


def index_assets(app):
    assets = IndexAssets()
    assets.feed((app / "index.html").read_text(encoding="utf-8"))
    assets.close()
    if {path.rsplit(".", 1)[1] for path in assets.paths} != {"js", "css"}:
        raise ValueError("staging index must reference JS and CSS under /app/assets/")
    for path in assets.paths:
        if not (app / path.removeprefix("/app/")).is_file():
            raise ValueError(f"missing entry asset: {path}")
    return sorted(assets.paths)


def install(root, sha, digest, archive):
    if not SHA.fullmatch(sha) or not DIGEST.fullmatch(digest):
        raise ValueError("invalid web SHA or digest")
    with archive.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != digest:
            raise ValueError("staging web artifact digest mismatch")

    ref = f"releases/{sha}-{digest}"
    target = root / ref
    with tempfile.TemporaryDirectory(prefix=".web.", dir=root / "releases") as scratch:
        incoming = Path(scratch) / "release"
        app = incoming / "app"
        app.mkdir(parents=True)
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.infolist()
            if len(entries) > 4096 or sum(item.file_size for item in entries) > MAX_UNPACKED:
                raise ValueError("staging web artifact exceeds unpacked limits")
            for item in entries:
                name = item.filename.rstrip("/")
                mode = stat.S_IFMT(item.external_attr >> 16)
                if (
                    not NAME.fullmatch(name)
                    or any(part in {".", ".."} for part in name.split("/"))
                    or mode not in {0, stat.S_IFDIR if item.is_dir() else stat.S_IFREG}
                ):
                    raise ValueError(f"unsafe staging archive entry: {item.filename!r}")
                path = app / name
                if item.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(item) as source, path.open("xb") as dest:
                        shutil.copyfileobj(source, dest)
        index_assets(app)
        (incoming / "REVISION").write_text(sha + "\n", encoding="ascii")
        (incoming / "ARTIFACT_SHA256").write_text("sha256:" + digest + "\n", encoding="ascii")
        for item in incoming.rglob("*"):
            item.chmod(0o755 if item.is_dir() else 0o644)
        incoming.chmod(0o755)
        if target.exists():
            def files(path):
                return {p.relative_to(path): p.read_bytes() for p in path.rglob("*") if p.is_file()}

            if files(incoming) != files(target):
                raise ValueError("existing web release differs from its artifact")
        else:
            incoming.rename(target)
    print(ref)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(root, ref, origin):
    release = root / ref
    sha = (release / "REVISION").read_text(encoding="ascii").strip()
    if not SHA.fullmatch(sha):
        raise ValueError("invalid installed web revision")
    app = release / "app"
    opener = build_opener(NoRedirect())

    def get(path):
        try:
            return opener.open(origin + path, timeout=5)
        except HTTPError as exc:
            return exc

    with get("/") as response:
        location = urljoin(origin + "/", response.headers.get("Location", ""))
        if response.code not in {301, 302, 307, 308} or location != origin + "/app/":
            raise ValueError("wrong redirect at staging root")

    expected = (app / "index.html").read_bytes()
    for path in ("/app/", "/app/login", "/app/contacts"):
        with get(path) as response:
            if (
                response.code != 200
                or response.headers.get_content_type() != "text/html"
                or response.read(len(expected) + 1) != expected
            ):
                raise ValueError(f"unexpected HTML at {path}")
    for path in index_assets(app):
        expected = (app / path.removeprefix("/app/")).read_bytes()
        types = {"text/css"} if path.endswith(".css") else {"application/javascript", "text/javascript"}
        with get(path) as response:
            if (
                response.code != 200
                or response.headers.get_content_type() not in types
                or response.read(len(expected) + 1) != expected
            ):
                raise ValueError(f"unexpected asset at {path}")
    print(f"staging: web SHA {sha} passed HTTPS smoke (/app/, login, contacts, JS, CSS)")


if __name__ == "__main__":
    try:
        command, root, *args = sys.argv[1:]
        if command == "install":
            sha, digest, archive = args
            install(Path(root), sha, digest, Path(archive))
        elif command == "probe":
            probe(Path(root), *args)
        else:
            raise ValueError("expected install or probe")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(f"staging web: {error}")
