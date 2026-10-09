r"""TEST TOOL ONLY: synthetic ESP32 HTTP uploads into a private test instance.

This module is never imported by server/app.py, run.bat or the dashboard.
It owns a loopback HTTP server and a new .qa/test-client/.../sensor-test.db.
It deliberately accepts neither a destination URL nor a database override.
The real ESP32 payload, server implementation and web assets stay unchanged.

Run: .venv\Scripts\python.exe test_client.py --verify --keep-open
"""

import argparse
import json
import math
import os
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from werkzeug.serving import ThreadedWSGIServer, WSGIRequestHandler

from server.app import AXES, create_app

PROJECT_DIR = Path(__file__).resolve().parent
QA_ROOT = PROJECT_DIR / ".qa" / "test-client"
TEST_HEADER = "X-IMU-Test-Run"
DEVICE = "ESP32_S3_EYE"  # Same contract as hardware, ONLY in the isolated instance.
TIMEZONE = timezone(timedelta(hours=8))


class NoRedirect(HTTPRedirectHandler):
    """Do not follow redirects that could lead out of the isolated instance."""

    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class QuietRequestHandler(WSGIRequestHandler):
    def log_request(self, code="-", size="-"):
        pass


class OwnedWSGIServer(ThreadedWSGIServer):
    # Windows SO_REUSEADDR permits a second listener on an occupied port.
    # Exclusive ownership is required before the test tool may send uploads.
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def parse_port(text):
    try:
        port = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("port must be an integer") from None
    if port == 5000 or not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("use a port from 1024 to 65535 other than production port 5000")
    return port


def sample_interval(text):
    try:
        interval = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("interval must be numeric") from None
    if not math.isfinite(interval) or not 0.05 <= interval <= 5:
        raise argparse.ArgumentTypeError("interval must be finite and between 0.05 and 5 seconds")
    return interval


def sample_count(text):
    try:
        count = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("samples must be an integer") from None
    if not 1 <= count <= 100000:
        raise argparse.ArgumentTypeError("samples must be between 1 and 100000")
    return count


def make_sample(index):
    """Deterministic artificial waveforms, NOT measured motion or experiment data."""
    phase = index / 9
    return {
        "device": DEVICE,
        "sensor": "QMA6100P",
        "acc_x": round(0.45 * math.sin(phase), 5),
        "acc_y": round(0.20 * math.cos(phase * 0.7), 5),
        "acc_z": round(1.0 + 0.10 * math.sin(phase * 1.7), 5),
        "timestamp": datetime.now(TIMEZONE).strftime("%Y-%m-%d %H:%M:%S"),
    }


class IsolatedTestServer:
    def __init__(self, port=5001):
        self.port = parse_port(str(port))
        self.token = uuid.uuid4().hex
        self.run_dir = QA_ROOT / f"{datetime.now():%Y%m%d-%H%M%S}-{self.token[:8]}"
        self.database = self.run_dir / "sensor-test.db"
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.http = build_opener(ProxyHandler({}), NoRedirect())
        self.server = None
        self.thread = None
        self.app = None

    def start(self):
        if self.server is not None:
            raise RuntimeError("This test server is already running.")
        # Explicit factory config overrides even an inherited IMU_DATABASE value.
        self.app = create_app({"DATABASE": str(self.database), "TESTING": False, "TEST_RUN_TOKEN": self.token})

        @self.app.after_request
        def mark_test_response(response):
            response.headers[TEST_HEADER] = self.token
            response.headers["Cache-Control"] = "no-store"
            if response.status_code == 200 and response.mimetype == "text/html":
                response.direct_passthrough = False
                html = response.get_data(as_text=True)
                html = html.replace("<title>", "<title>[测试数据] ", 1)
                html = html.replace(
                    "<!-- test-banner -->",
                    '<div class="test-banner" role="note"><strong>隔离测试工具 / 模拟数据</strong>'
                    ' — 模拟测试数据，仅用于软件验证；独立测试数据库，非真实传感器读数。</div>',
                    1,
                )
                html = html.replace('<body ', '<body data-test-mode="true" ', 1)
                response.set_data(html)
                response.headers.pop("ETag", None)
                response.headers.pop("Last-Modified", None)
            return response

        # Bind before sending ANY request. An occupied port fails; we never connect
        # to a pre-existing service. Only this owned socket is used for uploads.
        try:
            self.server = OwnedWSGIServer(
                "127.0.0.1", self.port, self.app, handler=QuietRequestHandler,
            )
        except SystemExit as error:
            raise RuntimeError(f"Cannot bind test port {self.port}; no uploads were sent. Choose another --port.") from error
        self.thread = threading.Thread(target=self.server.serve_forever, name="imu-test-http", daemon=True)
        self.thread.start()

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
            self.server = None
            self.thread = None

    def request(self, path, payload=None, *, raw=None, expected=200, content_type="application/json"):
        if self.server is None:
            raise RuntimeError("Refusing HTTP request without an owned test server.")
        if not path.startswith("/api/") or "//" in path or ".." in path:
            raise ValueError("Only local /api/ paths are accepted.")
        body = json.dumps(payload, allow_nan=False).encode("utf-8") if payload is not None else raw
        request = Request(self.base_url + path, data=body, headers={"Content-Type": content_type, TEST_HEADER: self.token})
        try:
            response = self.http.open(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            if response.headers.get(TEST_HEADER) != self.token:
                raise RuntimeError("Response did not originate from this isolated test run.")
            text = response.read().decode("utf-8")
            if response.status != expected:
                raise RuntimeError(f"{path}: expected HTTP {expected}, got {response.status}: {text[:200]}")
            return json.loads(text) if "application/json" in response.headers.get("Content-Type", "") else text


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_rejections(server):
    before = server.request("/api/latest")["total_samples"]
    server.request("/api/upload", {"device": DEVICE}, expected=400)
    server.request("/api/upload", {**make_sample(0), "acc_x": True}, expected=400)
    server.request("/api/upload", {**make_sample(0), "timestamp": "2026-02-30 12:00:00"}, expected=400)
    server.request("/api/upload", raw=b'{"broken"', expected=400)
    server.request("/api/upload", raw=json.dumps({**make_sample(0), "acc_x": float("nan")}).encode(), expected=400)
    server.request("/api/upload", raw=b"not JSON", content_type="text/plain", expected=415)
    server.request("/api/upload", {**make_sample(0), "padding": "x" * 9000}, expected=413)
    require(server.request("/api/latest")["total_samples"] == before, "Rejected payloads changed the sample count.")
    print("[PASS] Malformed input / boolean / date / content type / size rejection; no rows added.", flush=True)


def run(args):
    server = IsolatedTestServer(args.port)
    report = {
        "tool": "test_client.py", "data_source": "SYNTHETIC_TEST_ONLY",
        "hardware_verified": False, "status": "running", "checks": [],
        "database": str(server.database), "url": server.base_url,
    }
    exit_code = 0
    try:
        server.start()
        print("\n=== TEST TOOL ONLY / SYNTHETIC DATA / NO HARDWARE CLAIM ===", flush=True)
        print(f"Test dashboard: {server.base_url}\nTest database: {server.database}", flush=True)
        print("Production port 5000 and server/sensor.db are not used by this tool.\n", flush=True)
        require(server.request("/api/latest")["total_samples"] == 0, "Expected a new empty test database.")
        require(server.request("/api/latest")["status"] == "offline", "Empty state must be offline.")
        require(abs(int(server.request("/api/time")) - time.time()) < 3, "Server time endpoint differs from local time.")
        report["checks"].append("empty_state_and_server_time")
        if args.verify:
            verify_rejections(server)
            report["checks"].append("invalid_uploads_rejected_without_writes")

        uploaded = []
        for index in range(args.samples):
            started = time.monotonic()
            sample = make_sample(index)
            uploaded.append(server.request("/api/upload", sample, expected=201)["id"])
            if index == 0 or (index + 1) % 20 == 0 or index + 1 == args.samples:
                print(f"[TEST POST] {index + 1}/{args.samples} accepted; id={uploaded[-1]}", flush=True)
            if index + 1 < args.samples:
                time.sleep(max(0, args.interval - (time.monotonic() - started)))

        latest = server.request("/api/latest")
        require(latest["status"] == "online", "Expected online after successful upload.")
        require(latest["total_samples"] == args.samples, "Not every accepted upload was persisted.")
        require(all(latest[key] == sample[key] for key in ("device", "sensor", "timestamp", *AXES)), "Latest sample differs from the HTTP payload.")
        history = server.request(f"/api/history?after_id={uploaded[-1] - 1}")
        require([row["id"] for row in history["samples"]] == [uploaded[-1]], "Incremental history cursor is incorrect.")
        require(not server.request(f"/api/history?after_id={uploaded[-1]}")["samples"], "Repeated cursor produced duplicate history.")
        require(len(set(uploaded)) == args.samples, "Upload IDs are not unique.")
        report["checks"].append("http_post_persistence_latest_history_and_online")
        print("[PASS] HTTP POST -> SQLite -> latest/history; values match, IDs unique, status ONLINE.", flush=True)

        if args.verify:
            print("[VERIFY] Uploads stopped; waiting for the real 10-second offline timeout...", flush=True)
            deadline = time.monotonic() + 13
            while True:
                latest = server.request("/api/latest")
                if latest["status"] == "offline":
                    break
                require(time.monotonic() < deadline, "Device did not become offline after uploads stopped.")
                time.sleep(0.25)
            require(latest["total_samples"] == args.samples, "Idle polling added rows.")
            report["checks"].append("real_elapsed_offline_timeout_and_no_duplicate_rows")
            print("[PASS] OFFLINE after uploads stopped; polling did not add rows.", flush=True)
            # Leave enough time for the dashboard's next poll to display OFFLINE.
            time.sleep(2)
            server.request("/api/upload", make_sample(args.samples), expected=201)
            require(server.request("/api/latest")["status"] == "online", "New upload did not restore online state.")
            report["checks"].append("new_upload_restores_online")
            print("[PASS] New upload restores ONLINE. Restarting isolated server to check persistence...", flush=True)
            server.stop()
            time.sleep(2)
            server.start()
            require(server.request("/api/latest")["total_samples"] == args.samples + 1, "Rows were lost on restart.")
            report["checks"].append("server_restart_preserves_database")
            print("[PASS] Server restart preserves all uploaded rows.", flush=True)

        report["status"] = "passed"
        report["accepted_samples"] = args.samples + (1 if args.verify else 0)
        report_path = server.run_dir / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"[PASS] Report: {report_path}", flush=True)
        if args.keep_open:
            print("[TEST ONLY] Dashboard remains available. Uploads are stopped; OFFLINE is expected. Ctrl+C closes it.", flush=True)
            while True:
                time.sleep(0.5)
    except KeyboardInterrupt:
        if report["status"] != "passed":
            report["status"] = "interrupted"
            exit_code = 130
        print("\nTest tool stopped by user.", flush=True)
    except (OSError, RuntimeError, ValueError, URLError) as error:
        report["status"] = "failed"
        report["error"] = str(error)
        print(f"[FAIL] {error}", file=sys.stderr, flush=True)
        exit_code = 1
    finally:
        server.stop()
        if server.run_dir.exists():
            (server.run_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(description="TEST TOOL ONLY: simulate ESP32 against an owned, isolated localhost server.")
    parser.add_argument("--port", type=parse_port, default=5001, help="isolated test port (default: 5001; 5000 is forbidden)")
    parser.add_argument("--samples", type=sample_count, default=120, help="number of synthetic uploads (default: 120)")
    parser.add_argument("--interval", type=sample_interval, default=0.5, help="upload interval in seconds (default: 0.5)")
    parser.add_argument("--verify", action="store_true", help="also verify rejection, real offline timeout, reconnect and restart persistence")
    parser.add_argument("--keep-open", action="store_true", help="keep the test dashboard available until Ctrl+C after uploads stop")
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
