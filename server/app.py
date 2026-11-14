"""Serve the Datark demo and its authenticated defaults editor."""

import base64
import hashlib
import json
import math
import mimetypes
import os
import secrets
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(os.environ.get("DATARK_ROOT", "/app"))
PUBLIC = ROOT / "public"
ADMIN = ROOT / "admin"
DATA = Path(os.environ.get("DATARK_DATA", "/data"))
SETTINGS = DATA / "settings.json"
BANDS = {
    "B1": (2110, 2170, (5, 10, 15, 20)),
    "B3": (1805, 1880, (1.4, 3, 5, 10, 15, 20)),
    "B7": (2620, 2690, (5, 10, 15, 20)),
}
OPERATORS = json.loads((PUBLIC / "tools/mdpc-scenario.json").read_text(encoding="utf-8"))["operators"]
DEFAULTS = {"scenario": "mixed", "calculator": {"operators": OPERATORS, "gsm": {"band": "1800", "arfcn": 698}}}
MAX_BODY = 16384
ADMIN_USER = os.environ.get("DATARK_ADMIN_USER", "admin")
PASSWORD_FILE = Path(os.environ.get("DATARK_PASSWORD_FILE", "/run/datark/admin-password"))
REVISION = os.environ.get("DATARK_REVISION", "local")
SWAGGER_TOKEN_SHA256 = os.environ.get("DATARK_SWAGGER_TOKEN_SHA256", "")
EDITOR_ORIGINS = {"https://editor.swagger.io", "https://jdegre.github.io"}
EDITOR_PATHS = {"/healthz", "/assets/site-defaults.json", "/api/sms-test-results", "/api/telemetry"}

TELEMETRY_INTERVAL_MS = 5000
ZONE_BASELINES = ((-89, 15), (-91, 12), (-85, 18), (-93, 10), (-82, 20))
ZONE_IDS = tuple(f"A{number}" for number in range(1, len(ZONE_BASELINES) + 1))
TELEMETRY_DRIFT = (0, 2, 1, -1, -2, 1, 0, -1)
ZONE_ALARMS = ("low-signal", "no-telemetry")


def telemetry(scenario, now_ms, overrides):
    slot = now_ms // TELEMETRY_INTERVAL_MS
    online = scenario != "offline"
    zones = []
    alarms = [] if online else [{"sourceId": "R1", "type": "rf-off"}]
    samples = [{"time": tick * TELEMETRY_INTERVAL_MS, "zones": {}} for tick in range(slot - 7, slot + 1)]
    for number, (zone_id, (rsrp, sinr)) in enumerate(zip(ZONE_IDS, ZONE_BASELINES), 1):
        override = overrides.get(zone_id)
        status = "good"
        if override is not None:
            status = override["status"]
            alarm_types = override["alarms"]
        elif not online or (scenario == "mixed" and zone_id == "A5"):
            status = "critical"
            alarm_types = ("no-telemetry",)
        elif scenario == "mixed" and zone_id == "A2":
            rsrp, sinr = -105, 2
            status = "warning"
            alarm_types = ("low-signal",)
        else:
            alarm_types = ()
        alarms.extend({"sourceId": zone_id, "type": kind} for kind in alarm_types)
        for sample in samples:
            drift = TELEMETRY_DRIFT[(sample["time"] // TELEMETRY_INTERVAL_MS + number) % len(TELEMETRY_DRIFT)]
            if override is not None:
                reading = override["reading"]
            else:
                reading = None if status == "critical" else {"rsrp": rsrp + drift, "sinr": sinr + drift}
            sample["zones"][zone_id] = reading
        zones.append({"id": zone_id, "status": status, "reading": samples[-1]["zones"][zone_id],
                      "manual": override is not None})
    drift = TELEMETRY_DRIFT[slot % len(TELEMETRY_DRIFT)]
    return {
        "source": "synthetic", "time": samples[-1]["time"], "scenario": scenario,
        "online": online, "donor": {"rsrp": -78 + drift, "sinr": 17 + drift},
        "zones": zones, "samples": samples,
        "alarms": sorted(alarms, key=lambda alarm: alarm["type"] == "low-signal"),
    }

# Each value is the delay in milliseconds for one sent SMS. None means
# no confirmed delivery. These fixtures never contact a modem.
SMS_TEST_DELAYS = {
    "off": (1110, 1240, 1280, 1170, 1350, 1220, 1190, 1410, 1260, 1310),
    "on": (1380, 1540, 1710, 1630, 1490, None, 1820, 1570, 1650, 1430),
}


def sms_test_results():
    results = []
    for mode, delays in SMS_TEST_DELAYS.items():
        confirmed = [delay for delay in delays if delay is not None]
        results.append({
            "lte_mode": mode,
            "sent": len(delays),
            "delivered": len(confirmed),
            "latency_ms": {
                "min": min(confirmed),
                "mean": round(sum(confirmed) / len(confirmed), 2),
                "max": max(confirmed),
            } if confirmed else None,
        })
    return {"source": "synthetic", "results": results}


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def validate(settings):
    if not isinstance(settings, dict) or settings.get("scenario") not in ("mixed", "normal", "offline"):
        raise ValueError("Выберите тестовый сценарий.")
    calculator = settings.get("calculator")
    if not isinstance(calculator, dict):
        raise ValueError("Укажите настройки калькулятора.")
    operators = calculator.get("operators")
    if not isinstance(operators, list) or len(operators) != len(OPERATORS):
        raise ValueError("Укажите пять LTE-несущих.")
    approved = []
    for operator, original in zip(operators, OPERATORS):
        name = original["name"]
        if not isinstance(operator, dict) or operator.get("name") != name:
            raise ValueError(f"{name}: проверьте оператора.")
        band = operator.get("band")
        width = operator.get("bandwidth_mhz")
        power = operator.get("das_dl_dbm")
        center = operator.get("dl_mhz")
        if not isinstance(band, str) or band not in BANDS:
            raise ValueError(f"{name}: выберите B1, B3 или B7.")
        low, high, widths = BANDS[band]
        if not finite(width) or width not in widths:
            raise ValueError(f"{name}: ширина вне допустимых значений для {band}.")
        if not finite(power):
            raise ValueError(f"{name}: укажите конечное значение мощности.")
        if center is not None and (not finite(center) or not low + width / 2 <= center <= high - width / 2):
            raise ValueError(f"{name}: несущая выходит за границы {band}.")
        row = {"name": name, "band": band, "bandwidth_mhz": width, "das_dl_dbm": power}
        if center is not None:
            row["dl_mhz"] = center
        approved.append(row)
    gsm = calculator.get("gsm")
    if not isinstance(gsm, dict):
        raise ValueError("Укажите GSM-канал.")
    band, arfcn = gsm.get("band"), gsm.get("arfcn")
    if type(arfcn) is not int or not (
        (band == "900" and (0 <= arfcn <= 124 or 975 <= arfcn <= 1023))
        or (band == "1800" and 512 <= arfcn <= 885)
    ):
        raise ValueError("ARFCN вне допустимых значений для выбранного диапазона GSM.")
    return {"scenario": settings["scenario"], "calculator": {"operators": approved, "gsm": {"band": band, "arfcn": arfcn}}}


def load_settings():
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return DEFAULTS


def save_json(destination, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=DATA, delete=False) as stream:
        path = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
            os.replace(path, destination)
        finally:
            path.unlink(missing_ok=True)


def zone_file(zone):
    return DATA / f"telemetry-{zone}.json"


def read_zone_overrides():
    overrides = {}
    for zone in ZONE_IDS:
        try:
            overrides[zone] = json.loads(zone_file(zone).read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
    return overrides


def validate_zone_override(body):
    if not isinstance(body, dict) or body.get("zone") not in ZONE_IDS or "override" not in body:
        raise ValueError("Укажите зону A1–A5 и поле override.")
    override = body["override"]
    if override is None:
        return body["zone"], None
    if not isinstance(override, dict) or override.get("status") not in ("good", "warning", "critical"):
        raise ValueError("Укажите статус good, warning или critical.")
    reading = override.get("reading")
    if "reading" not in override or (reading is not None and (
        not isinstance(reading, dict) or any(not finite(reading.get(key)) for key in ("rsrp", "sinr"))
    )):
        raise ValueError("Укажите числовые RSRP и SINR или передайте reading: null.")
    alarms = override.get("alarms")
    if not isinstance(alarms, list) or any(kind not in ZONE_ALARMS for kind in alarms) or len(alarms) != len(set(alarms)):
        raise ValueError("Укажите список уникальных тревог low-signal и no-telemetry.")
    return body["zone"], {"status": override["status"], "reading": (
        None if reading is None else {key: reading[key] for key in ("rsrp", "sinr")}
    ), "alarms": alarms}


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).digest()


def admin_password():
    try:
        return PASSWORD_FILE.read_text(encoding="utf-8").rstrip("\r\n")
    except OSError:
        return ""


class Handler(BaseHTTPRequestHandler):
    timeout = 15
    server_version = "Datark"
    sys_version = ""

    def send_payload(self, status, content, media_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if self.command in ("GET", "HEAD") and urlsplit(self.path).path in EDITOR_PATHS:
            self.send_header("Vary", "Origin")
            origin = self.headers.get("Origin")
            if origin in EDITOR_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("X-Content-Type-Options", "nosniff")
        policy = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
        if urlsplit(self.path).path == "/admin/api/":
            policy += "; img-src 'self' data:"
        self.send_header("Content-Security-Policy", policy)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def json(self, status, body, headers=None):
        self.send_payload(status, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", headers)

    def authorize(self):
        password = admin_password()
        if not password:
            self.json(503, {"error": "Настройте пароль администратора на сервере."})
            return False
        scheme, _, token = self.headers.get("Authorization", "").partition(" ")
        try:
            user, separator, supplied = base64.b64decode(token, validate=True).decode().partition(":")
        except (ValueError, UnicodeError):
            user, separator, supplied = "", "", ""
        if scheme.lower() == "basic" and separator and (
            secrets.compare_digest(digest(user), digest(ADMIN_USER))
            & secrets.compare_digest(digest(supplied), digest(password))
        ):
            return True
        self.json(401, {"error": "Требуется вход."}, {"WWW-Authenticate": 'Basic realm="Datark admin", charset="UTF-8"'})
        return False

    def authorize_swagger(self):
        scheme, _, token = self.headers.get("Authorization", "").partition(" ")
        return (
            bool(SWAGGER_TOKEN_SHA256)
            and scheme.lower() == "bearer"
            and bool(token)
            and secrets.compare_digest(digest(token).hex().encode(), SWAGGER_TOKEN_SHA256.encode())
        )

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/healthz":
            try:
                validate(load_settings())
            except (OSError, ValueError, OverflowError):
                self.json(503, {"status": "unhealthy", "revision": REVISION})
                return
            self.json(200, {"status": "ok", "revision": REVISION})
            return
        if path == "/assets/site-defaults.json":
            self.send_settings()
            return
        if path == "/api/sms-test-results":
            self.json(200, sms_test_results())
            return
        if path == "/api/telemetry":
            self.send_telemetry()
            return
        if path.startswith("/admin/api/"):
            if self.authorize_swagger() or self.authorize():
                self.serve_file(ADMIN / "api", path.removeprefix("/admin/api/"))
            return
        if path == "/admin" or path.startswith("/admin/"):
            if not self.authorize():
                return
            if path == "/admin":
                self.send_payload(308, b"", "text/plain", {"Location": "/admin/"})
            elif path == "/admin/settings":
                self.send_settings()
            else:
                self.serve_file(ADMIN, path.removeprefix("/admin/"))
            return
        self.serve_file(PUBLIC, path.lstrip("/"))

    do_HEAD = do_GET

    def send_settings(self):
        try:
            settings = load_settings()
        except (OSError, ValueError):
            self.json(503, {"error": "Настройки сервера недоступны."})
            return
        self.json(200, settings)

    def send_telemetry(self):
        params = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        requested = params.get("scenario")
        if requested is not None and (len(requested) != 1 or requested[0] not in ("mixed", "normal", "offline")):
            self.json(400, {"error": "Выберите тестовый сценарий."})
            return
        try:
            scenario = requested[0] if requested else load_settings()["scenario"]
            overrides = read_zone_overrides()
        except (OSError, ValueError, KeyError, TypeError):
            self.json(503, {"error": "Настройки сервера недоступны."})
            return
        if scenario not in ("mixed", "normal", "offline"):
            self.json(503, {"error": "Настройки сервера недоступны."})
            return
        self.json(200, telemetry(scenario, time.time_ns() // 1_000_000, overrides))

    def serve_file(self, root, name):
        try:
            file = (root / name).resolve()
        except (ValueError, OSError):
            self.json(404, {"error": "Страница не найдена."})
            return
        if not file.is_relative_to(root.resolve()):
            self.json(404, {"error": "Страница не найдена."})
            return
        if file.is_dir():
            if not urlsplit(self.path).path.endswith("/"):
                self.send_payload(308, b"", "text/plain", {"Location": urlsplit(self.path).path + "/"})
                return
            file /= "index.html"
        if not file.is_file():
            self.json(404, {"error": "Страница не найдена."})
            return
        media_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix in (".html", ".js", ".css", ".md", ".csv"):
            media_type += "; charset=utf-8"
        try:
            content = file.read_bytes()
        except OSError:
            self.json(404, {"error": "Страница не найдена."})
            return
        if root == PUBLIC and file in (PUBLIC / "index.html", PUBLIC / "monitor/index.html"):
            content = content.replace(b"<!-- SERVER_TELEMETRY -->", b'<meta name="datark-telemetry" content="/api/telemetry">', 1)
        if root == PUBLIC and file == PUBLIC / "index.html":
            content = content.replace(
                b"<!-- SERVER_NAVIGATION -->",
                '<a href="#sms-tests">Испытания SMS</a>'.encode(),
                1,
            )
        self.send_payload(200, content, media_type)

    def do_PUT(self):
        resource = urlsplit(self.path).path
        if resource not in ("/admin/settings", "/admin/telemetry"):
            self.json(404, {"error": "Страница не найдена."})
            return
        if not self.authorize():
            return
        # A browser on another origin cannot supply this header without CORS permission.
        if self.headers.get("X-Datark-Admin") != resource.rsplit("/", 1)[-1] or self.headers.get_content_type() != "application/json":
            self.json(403, {"error": "Запрос отклонён."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_BODY:
            self.json(413, {"error": "Недопустимый размер запроса."})
            return
        try:
            body = json.loads(self.rfile.read(size))
            if resource == "/admin/settings":
                settings = validate(body)
            else:
                zone, override = validate_zone_override(body)
        except (ValueError, OverflowError, RecursionError) as error:
            message = str(error) if type(error) is ValueError else "Некорректные параметры."
            self.json(400, {"error": message})
            return
        try:
            if resource == "/admin/settings":
                save_json(SETTINGS, settings)
                result = settings
            else:
                file = zone_file(zone)
                if override is None:
                    file.unlink(missing_ok=True)
                else:
                    save_json(file, override)
                result = {"zone": zone, "override": override}
        except OSError:
            self.json(500, {"error": "Хранилище настроек недоступно для записи."})
            return
        self.json(200, result)


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    address = os.environ.get("DATARK_BIND", "0.0.0.0"), int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(address, Handler).serve_forever()
