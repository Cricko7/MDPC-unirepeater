"""Exercise the application over HTTP, locally or in the built image."""

import argparse
import base64
import hashlib
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
SWAGGER_TOKEN = "smoke-only-swagger-token"
SWAGGER_TOKEN_SHA256 = hashlib.sha256(SWAGGER_TOKEN.encode()).hexdigest()


def check(base):
    auth = {"Authorization": "Basic " + base64.b64encode(b"admin:smoke-only-password").decode()}

    def request(path, status=200, headers=None, body=None, cors_origin=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(base + path, data=data, headers=headers or {}, method="PUT" if data else "GET")
        try:
            response = urlopen(req, timeout=4)
        except HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status, status)
            assert response.headers.get("Access-Control-Allow-Origin") == cors_origin
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
    home = request("/")
    for page in (home, request("/monitor/")):
        assert b'<meta name="datark-telemetry" content="/api/telemetry">' in page
    assert b'href="/admin/api/"' not in home
    assert b"assets/toasts.js" in home and request("/assets/toasts.js")
    assert b'<a href="#sms-tests">' in home and b'id="sms-tests-rows"' in home
    assert b'fetch("/api/sms-test-results"' in request("/assets/sms-test-results.js")
    assert b"datark-expert-report.pdf" not in home
    request("/docs/datark-expert-report.pdf", 404)
    request("/admin/", 401)
    request("/admin/admin.js", 401)
    request("/admin/api/", 401)
    request("/admin/api/openapi.json", 401)
    assert b'id="swagger-ui"' in request("/admin/api/", headers=auth)
    spec = json.loads(request("/admin/api/openapi.json", headers=auth))
    assert spec["paths"]["/admin/settings"]["put"]["security"] == [{"BasicAuth": []}]
    assert "get" in spec["paths"]["/api/sms-test-results"]
    assert "get" in spec["paths"]["/api/telemetry"]
    assert "put" in spec["paths"]["/admin/telemetry"]
    editor = "https://editor.swagger.io"
    for path in ("/healthz", "/assets/site-defaults.json", "/api/sms-test-results"):
        request(path, headers={"Origin": editor}, cors_origin=editor)
    request("/admin/api/", 401, headers={"Origin": editor})
    request("/admin/settings", headers={**auth, "Origin": editor})
    request("/api/sms-test-results", headers={"Origin": "https://example.org"})
    sms = json.loads(request("/api/sms-test-results"))
    request("/api/telemetry?scenario=invalid", 400)
    normal = json.loads(request("/api/telemetry?scenario=normal", headers={"Origin": "https://editor.swagger.io"},
                                cors_origin="https://editor.swagger.io"))
    assert normal["source"] == "synthetic" and normal["online"] and not normal["alarms"]
    assert [zone["id"] for zone in normal["zones"]] == ["A1", "A2", "A3", "A4", "A5"]
    assert len(normal["samples"]) == 8 and normal["time"] == normal["samples"][-1]["time"]
    for zone in normal["zones"]:
        assert zone["status"] == "good" and zone["reading"] == normal["samples"][-1]["zones"][zone["id"]]
    mixed = json.loads(request("/api/telemetry?scenario=mixed"))
    assert {(alarm["sourceId"], alarm["type"]) for alarm in mixed["alarms"]} == {
        ("A2", "low-signal"), ("A5", "no-telemetry"),
    }
    assert sms == {"source": "synthetic", "results": [
        {"lte_mode": "off", "sent": 10, "delivered": 10,
         "latency_ms": {"min": 1110, "mean": 1254, "max": 1410}},
        {"lte_mode": "on", "sent": 10, "delivered": 9,
         "latency_ms": {"min": 1380, "mean": 1580, "max": 1820}},
    ]}
    swagger_auth = {"Authorization": f"Bearer {SWAGGER_TOKEN}"}
    assert b'id="swagger-ui"' in request("/admin/api/", headers=swagger_auth)
    request("/admin/api/", 401, headers={"Authorization": "Bearer wrong-token"})
    request("/admin/api/%2e%2e/index.html", 404, headers=swagger_auth)
    request("/admin/", 401, headers=swagger_auth)
    request("/admin/settings", 401, headers=swagger_auth)
    request("/server/app.py", 404)
    request("/admin/%2e%2e/app.py", 404, headers=auth)
    request("/admin/settings", 401)
    admin = request("/admin/", headers=auth)
    assert b'id="settings"' in admin and b'<a href="api/">Swagger UI</a>' in admin
    settings = json.loads(request("/admin/settings", headers=auth))
    request("/admin/settings", 401, body=settings)
    request("/admin/settings", 401, body=settings, headers=swagger_auth)
    request("/admin/settings", 403, body=settings, headers=auth)
    write = {**auth, "Content-Type": "application/json", "X-Datark-Admin": "settings"}
    request("/admin/settings", 400, body={**settings, "scenario": "invalid"}, headers=write)
    settings["scenario"] = "offline"
    settings["calculator"]["operators"][0]["das_dl_dbm"] = 17.5
    settings["calculator"]["gsm"] = {"band": "900", "arfcn": 62}
    assert json.loads(request("/admin/settings", body=settings, headers=write)) == settings
    assert json.loads(request("/assets/site-defaults.json")) == settings
    offline = json.loads(request("/api/telemetry"))
    assert offline["scenario"] == "offline" and not offline["online"]
    assert {"sourceId": "R1", "type": "rf-off"} in offline["alarms"]
    assert all(zone["reading"] is None for zone in offline["zones"])
    telemetry_path = "/admin/telemetry"
    override = {"status": "warning", "reading": {"rsrp": -107, "sinr": 3}, "alarms": ["low-signal"]}
    update = {"zone": "A3", "override": override}
    telemetry_auth = {**write, "X-Datark-Admin": "telemetry"}
    request(telemetry_path, 401, body=update, headers=swagger_auth)
    request(telemetry_path, 403, body=update, headers=write)
    request(telemetry_path, 400, body={**update, "zone": "../A3"}, headers=telemetry_auth)
    request(telemetry_path, 400, body={**update, "override": {**override, "alarms": ["rf-off"]}}, headers=telemetry_auth)
    request(telemetry_path, 400, body={**update, "override": {**override, "reading": {"rsrp": True, "sinr": 3}}},
            headers=telemetry_auth)
    assert json.loads(request(telemetry_path, body=update, headers=telemetry_auth)) == update
    for scenario in ("normal", "offline"):
        sample = json.loads(request(f"/api/telemetry?scenario={scenario}"))
        assert sample["zones"][2] == {"id": "A3", "status": "warning", "reading": override["reading"], "manual": True}
        assert {"sourceId": "A3", "type": "low-signal"} in sample["alarms"]
        assert sample["samples"][-1]["zones"]["A3"] == override["reading"]
        assert sum(zone["manual"] for zone in sample["zones"]) == 1
    reset = {"zone": "A3", "override": None}
    assert json.loads(request(telemetry_path, body=reset, headers=telemetry_auth)) == reset
    assert not json.loads(request("/api/telemetry?scenario=normal"))["zones"][2]["manual"]
    for zone in ("A1", "A3"):
        request(telemetry_path, body={**update, "zone": zone}, headers=telemetry_auth)
    reset_all = {"zone": "all", "override": None}
    request(telemetry_path, 401, body=reset_all, headers=swagger_auth)
    request(telemetry_path, 400, body={**reset_all, "override": override}, headers=telemetry_auth)
    assert sum(zone["manual"] for zone in json.loads(request("/api/telemetry"))["zones"]) == 2
    for _ in range(2):
        assert json.loads(request(telemetry_path, body=reset_all, headers=telemetry_auth)) == reset_all
    assert not any(zone["manual"] for zone in json.loads(request("/api/telemetry"))["zones"])
    examples = spec["paths"][telemetry_path]["put"]["requestBody"]["content"]["application/json"]["examples"]
    for name, status, alarms in (
        ("normal", "good", []),
        ("degraded", "warning", ["low-signal"]),
        ("noTelemetry", "critical", ["no-telemetry"]),
        ("restore", "good", []),
    ):
        example = examples[name]["value"]
        assert example["zone"] == "A3"
        assert json.loads(request(telemetry_path, body=example, headers=telemetry_auth)) == example
        snapshot = json.loads(request("/api/telemetry?scenario=normal"))
        zone = next(zone for zone in snapshot["zones"] if zone["id"] == "A3")
        assert zone["status"] == status and zone["manual"] == (name != "restore")
        assert [alarm["type"] for alarm in snapshot["alarms"] if alarm["sourceId"] == "A3"] == alarms
        if example["override"] is not None:
            assert zone["reading"] == example["override"]["reading"]
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
                   "DATARK_ADMIN_USER": "admin", "DATARK_PORT": "0",
                   "DATARK_SWAGGER_TOKEN_SHA256": SWAGGER_TOKEN_SHA256}
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
                "DATARK_SWAGGER_TOKEN_SHA256": SWAGGER_TOKEN_SHA256,
            }
            with subprocess.Popen([sys.executable, str(ROOT / "server/app.py")], env=env) as process:
                try:
                    check(f"http://127.0.0.1:{port}")
                    assert json.loads((work / "data/settings.json").read_text(encoding="utf-8"))["scenario"] == "offline"
                finally:
                    process.terminate()


if __name__ == "__main__":
    main()
