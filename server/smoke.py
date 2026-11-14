"""Exercise the application over HTTP, locally or in the built image."""

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent


def check(base):
    auth = {"Authorization": "Basic " + base64.b64encode(b"admin:smoke-only-password").decode()}

    def request(path, status=200, headers=None, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(base + path, data=data, headers=headers or {}, method="PUT" if data else "GET")
        try:
            response = urlopen(req, timeout=4)
        except HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status, status)
            return response.read()

    for _ in range(30):
        try:
            request("/healthz")
            break
        except (URLError, OSError):
            time.sleep(1)
    else:
        raise RuntimeError("Server did not become ready")

    for path in ("/", "/monitor/", "/monitor/budget.html", "/tools/mdpc-scenario.json", "/docs/mdpc-radio-layout.png"):
        assert request(path), path
    request("/admin/", 401)
    request("/admin/admin.js", 401)
    request("/admin/api/", 401)
    request("/admin/api/openapi.json", 401)
    assert b'id="swagger-ui"' in request("/admin/api/", headers=auth)
    spec = json.loads(request("/admin/api/openapi.json", headers=auth))
    assert spec["paths"]["/admin/settings"]["put"]["security"] == [{"BasicAuth": []}]
    request("/server/app.py", 404)
    request("/admin/%2e%2e/app.py", 404, headers=auth)
    request("/admin/settings", 401)
    assert b'id="settings"' in request("/admin/", headers=auth)
    settings = json.loads(request("/admin/settings", headers=auth))
    request("/admin/settings", 401, body=settings)
    request("/admin/settings", 403, body=settings, headers=auth)
    write = {**auth, "Content-Type": "application/json", "X-Datark-Admin": "settings"}
    request("/admin/settings", 400, body={**settings, "scenario": "invalid"}, headers=write)
    settings["scenario"] = "offline"
    settings["calculator"]["operators"][0]["das_dl_dbm"] = 17.5
    settings["calculator"]["gsm"] = {"band": "900", "arfcn": 62}
    assert json.loads(request("/admin/settings", body=settings, headers=write)) == settings
    assert json.loads(request("/assets/site-defaults.json")) == settings
    settings["calculator"]["operators"][0]["dl_mhz"] = 100
    request("/admin/settings", 400, body=settings, headers=write)
    assert "dl_mhz" not in json.loads(request("/assets/site-defaults.json"))["calculator"]["operators"][0]
    print("Health, static pages, authentication, validation and persisted settings passed.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        password = work / "admin-password"
        password.write_text("smoke-only-password", encoding="utf-8")
        password.chmod(0o444)
        if args.docker:
            project = ["docker", "compose", "--project-name", f"datark-smoke-{os.getpid()}"]
            env = {**os.environ, "DATARK_ADMIN_PASSWORD_FILE": str(password), "DATARK_IMAGE": "datark:local",
                   "DATARK_ADMIN_USER": "admin", "DATARK_PORT": "0"}
            try:
                subprocess.run([*project, "up", "-d", "--wait", "--wait-timeout", "45"], env=env, check=True)
                address = subprocess.check_output([*project, "port", "web", "8080"], env=env, text=True).strip()
                check("http://" + address)
                auth = base64.b64encode(b"admin:smoke-only-password").decode()
                asset = Request("http://" + address + "/admin/api/vendor/swagger-ui-bundle.js",
                                headers={"Authorization": "Basic " + auth})
                with urlopen(asset, timeout=4) as response:
                    assert b"SwaggerUIBundle" in response.read()
                subprocess.run([*project, "up", "-d", "--wait", "--force-recreate", "web"], env=env, check=True)
                address = subprocess.check_output([*project, "port", "web", "8080"], env=env, text=True).strip()
                with urlopen("http://" + address + "/assets/site-defaults.json", timeout=4) as response:
                    assert json.load(response)["scenario"] == "offline"
            finally:
                subprocess.run([*project, "down", "-v"], env=env, check=True)
        else:
            public = work / "public"
            public.mkdir()
            shutil.copy2(ROOT / "index.html", public)
            for name in ("assets", "monitor", "docs", "tools"):
                shutil.copytree(ROOT / name, public / name)
            shutil.copytree(ROOT / "server/admin", work / "admin")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = {
                **os.environ, "DATARK_ROOT": str(work), "DATARK_DATA": str(work / "data"),
                "DATARK_PASSWORD_FILE": str(password), "DATARK_ADMIN_USER": "admin",
                "PORT": str(port), "DATARK_BIND": "127.0.0.1",
            }
            with subprocess.Popen([sys.executable, str(ROOT / "server/app.py")], env=env) as process:
                try:
                    check(f"http://127.0.0.1:{port}")
                    assert json.loads((work / "data/settings.json").read_text(encoding="utf-8"))["scenario"] == "offline"
                finally:
                    process.terminate()


if __name__ == "__main__":
    main()
