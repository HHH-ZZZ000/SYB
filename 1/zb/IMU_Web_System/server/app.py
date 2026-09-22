"""ESP32 IMU HTTP ingestion and same-origin monitoring dashboard."""

import math
import json
import os
import queue
import re
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, Response, jsonify, request, send_from_directory
from flask_sock import Sock
from simple_websocket import ConnectionClosed
from werkzeug.exceptions import HTTPException

if __package__:
    from . import database
    from .camera import BOUNDARY, CameraStream
    from .telemetry import TelemetryHub
else:
    import database
    from camera import BOUNDARY, CameraStream
    from telemetry import TelemetryHub

AXES = ("acc_x", "acc_y", "acc_z")
GYRO_AXES = ("gyro_x", "gyro_y", "gyro_z")  # Optional real angular velocity, rad/s.
SENSOR = "QMA6100P"
DEVICE_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\Z", re.ASCII)
OFFLINE_SECONDS = 10
DEFAULT_DEVICE = "ESP32_S3_EYE"


def validate_upload(payload):
    """Reject malformed samples before opening a write transaction."""
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object.")
    required = ("device", "sensor", *AXES, "timestamp")
    missing = [field for field in required if field not in payload]
    if missing:
        raise ValueError("Missing fields: " + ", ".join(missing))
    extra = set(payload) - set(required) - set(GYRO_AXES)
    if extra:
        raise ValueError("Unsupported fields: " + ", ".join(sorted(extra)))
    if payload["sensor"] != SENSOR:
        raise ValueError("sensor must be QMA6100P.")
    device = payload["device"]
    if not isinstance(device, str) or not DEVICE_PATTERN.fullmatch(device):
        raise ValueError("device must contain 1-64 letters, digits, underscores or hyphens.")
    sample = {"device": device, "sensor": SENSOR}
    for axis in AXES:
        value = payload[axis]
        # bool is a Python int subclass, but not a valid sensor measurement.
        if type(value) not in (int, float):
            raise ValueError(f"{axis} must be a JSON number.")
        try:
            value = float(value)
        except (OverflowError, ValueError):
            raise ValueError(f"{axis} must be finite.") from None
        if not math.isfinite(value) or abs(value) > 2:
            raise ValueError(f"{axis} must be finite and within +/-2 g (configured sensor range).")
        sample[axis] = value
    gyro = [payload.get(axis) for axis in GYRO_AXES]
    if any(value is not None for value in gyro):
        if any(type(value) not in (int, float) for value in gyro):
            raise ValueError("Gyroscope readings must be three numbers in rad/s, or all null/omitted.")
        try:
            gyro = [float(value) for value in gyro]
        except (OverflowError, ValueError):
            raise ValueError("Gyroscope readings must be finite.") from None
        if not all(math.isfinite(value) for value in gyro):
            raise ValueError("Gyroscope readings must be finite.")
    sample.update(zip(GYRO_AXES, gyro))
    timestamp = payload["timestamp"]
    if not isinstance(timestamp, str) or not TIMESTAMP_PATTERN.fullmatch(timestamp):
        raise ValueError("timestamp must use YYYY-MM-DD HH:MM:SS (UTC+08:00).")
    try:
        datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise ValueError("timestamp must be a valid calendar date and time.") from None
    sample["timestamp"] = timestamp
    return sample


def serialize_sample(row):
    sample = dict(row)
    sample["received_at_ms"] = round(sample["received_at"] * 1000)
    sample["received_at"] = datetime.fromtimestamp(
        sample["received_at"], timezone.utc
    ).isoformat(timespec="milliseconds")
    return sample


def create_app(test_config=None):
    project_dir = Path(__file__).resolve().parent.parent
    app = Flask(__name__, static_folder=str(project_dir / "web"), static_url_path="/static")
    app.config.from_mapping(
        DATABASE=os.environ.get("IMU_DATABASE", str(project_dir / "server" / "sensor.db")),
        MAX_CONTENT_LENGTH=8192,
        JSON_SORT_KEYS=False,
        TEST_RUN_TOKEN=None,
        CAMERA_ENABLED=None,
        CAMERA_URL=None,
        CAMERA_ALLOW_TEST_UPSTREAM=False,
        SOCK_SERVER_OPTIONS={"ping_interval": 10, "max_message_size": 2048},
    )
    if test_config:
        app.config.update(test_config)
    app.json.sort_keys = False
    database.init_app(app)
    isolated = bool(app.testing or app.config.get("TEST_RUN_TOKEN"))
    camera_enabled = app.config["CAMERA_ENABLED"]
    if camera_enabled is None:
        camera_enabled = not isolated
    # Test factories never inherit the real camera URL from the environment.
    camera_url = app.config["CAMERA_URL"]
    if not isolated and not camera_url:
        camera_url = os.environ.get("IMU_CAMERA_URL")
    camera = CameraStream(enabled=camera_enabled, url=camera_url,
                          allow_loopback=isolated and app.config["CAMERA_ALLOW_TEST_UPSTREAM"])
    hub = TelemetryHub()
    app.extensions["camera"] = camera
    app.extensions["telemetry"] = hub
    sock = Sock(app)

    def selected_device():
        device = request.args.get("device", DEFAULT_DEVICE)
        if not DEVICE_PATTERN.fullmatch(device):
            raise ValueError("Invalid device identifier.")
        return device

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.post("/api/upload")
    def upload():
        # The isolated test tool marks requests; production refuses them before any write.
        test_header = request.headers.get("X-IMU-Test-Run")
        test_token = app.config.get("TEST_RUN_TOKEN")
        if test_header is not None or test_token is not None:
            if not (test_token and test_header and secrets.compare_digest(test_token, test_header)):
                return jsonify(error="Synthetic test requests are restricted to their isolated test instance."), 403
        if not request.is_json:
            return jsonify(error="Content-Type must be application/json."), 415
        sample = validate_upload(request.get_json())
        # Receipt time belongs to the server, never to the untrusted device clock.
        received_at = time.time()
        with app.extensions["sample_lock"]:
            row_id = database.insert_sample(sample, received_at)
            total = app.extensions["sample_counts"][sample["device"]][1]
            hub.publish({"type": "sample", "sample": serialize_sample({
                **sample, "id": row_id, "received_at": received_at,
            }), "server_time_ms": round(time.time() * 1000), "total_samples": total})
        if sample["device"] == DEFAULT_DEVICE:
            camera.discover(request.remote_addr)
        return jsonify(ok=True, id=row_id, device=sample["device"]), 201

    @app.get("/api/latest")
    def latest():
        return jsonify(latest_payload(selected_device()))

    def latest_payload(device):
        row, total = database.get_latest(device)
        now = time.time()
        meta = dict(
            total_samples=total,
            server_time_ms=round(now * 1000),
            offline_after_seconds=OFFLINE_SECONDS,
        )
        if row is None:
            return dict(
                device=device, sensor=SENSOR, **{axis: None for axis in (*AXES, *GYRO_AXES)}, timestamp=None,
                id=None, received_at=None, received_at_ms=None, age_seconds=None,
                status="offline", **meta,
            )
        age = max(0.0, now - row["received_at"])
        return dict(
            **serialize_sample(row), age_seconds=round(age, 3),
            status="online" if age <= OFFLINE_SECONDS else "offline", **meta,
        )

    @app.get("/api/history")
    def history():
        device = selected_device()
        limit_text = request.args.get("limit", "600")
        after_text = request.args.get("after_id")
        if not re.fullmatch(r"[0-9]{1,4}", limit_text) or not 1 <= int(limit_text) <= 2000:
            raise ValueError("limit must be an integer between 1 and 2000.")
        after_id = None
        if after_text is not None:
            if not re.fullmatch(r"[0-9]{1,19}", after_text) or int(after_text) > 2**63 - 1:
                raise ValueError("after_id must be a non-negative 64-bit integer.")
            after_id = int(after_text)
        rows, has_more = database.get_history(device, int(limit_text), after_id)
        return jsonify(samples=[serialize_sample(row) for row in rows], has_more=has_more)

    @app.get("/api/time")
    def server_time():
        # ESP32 can obtain wall-clock time over the LAN when public NTP is blocked.
        return str(int(time.time())), 200, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/api/status")
    def status():
        device = selected_device()
        result = latest_payload(device)
        result["camera"] = camera.status() if device == DEFAULT_DEVICE else {
            "status": "offline", "fps": None, "last_frame_at_ms": None,
            "frame_age_ms": None, "width": 320, "height": 240,
        }
        return jsonify(result)

    @app.get("/api/camera")
    def camera_stream():
        viewer = camera.subscribe()
        if viewer is None:
            return jsonify(error="Camera stream unavailable."), 503, {"Retry-After": "2"}
        response = Response(viewer, content_type="multipart/x-mixed-replace; boundary=" + BOUNDARY.decode("ascii"))
        response.headers["X-Accel-Buffering"] = "no"
        response.call_on_close(viewer.close)
        return response

    @sock.route("/ws/telemetry")
    def telemetry(ws):
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc.lower() != request.host.lower():
            ws.close(reason=1008, message="Use this server's same-origin dashboard.")
            return
        subscriber = None
        try:
            device = selected_device()
            with app.extensions["sample_lock"]:
                subscriber = hub.subscribe(device)
                if subscriber is None:
                    ws.close(reason=1013, message="Too many telemetry viewers.")
                    return
                snapshot = latest_payload(device)
            # The long-lived socket must not retain a SQLite connection/transaction.
            database.close_db()
            ws.send(json.dumps({"type": "snapshot", "latest": snapshot}, allow_nan=False))
            last_id = snapshot["id"] or 0
            heartbeat_at = time.monotonic() + 2
            while ws.connected:
                if subscriber.overrun.is_set():
                    ws.close(reason=1013, message="Recover samples using the history cursor.")
                    break
                if ws.receive(timeout=0) is not None:
                    ws.close(reason=1008, message="Telemetry is read-only.")
                    break
                try:
                    message = subscriber.messages.get(timeout=max(0.01, heartbeat_at - time.monotonic()))
                    if message["sample"]["id"] > last_id:
                        ws.send(json.dumps(message, allow_nan=False))
                        last_id = message["sample"]["id"]
                except queue.Empty:
                    pass
                if time.monotonic() >= heartbeat_at:
                    ws.send(json.dumps({"type": "heartbeat", "server_time_ms": round(time.time() * 1000)}))
                    heartbeat_at = time.monotonic() + 2
        except (ConnectionClosed, OSError):
            pass
        except ValueError:
            ws.close(reason=1008, message="Invalid device identifier.")
        finally:
            if subscriber is not None:
                hub.unsubscribe(subscriber)

    @app.errorhandler(ValueError)
    def validation_error(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(sqlite3.Error)
    def database_error(error):
        app.logger.exception("Database operation failed")
        return jsonify(error="Database unavailable. Please retry."), 503

    @app.errorhandler(HTTPException)
    def http_error(error):
        if request.path.startswith("/api/"):
            return jsonify(error=error.description), error.code
        return error

    @app.after_request
    def response_headers(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        )
        return response

    return app


if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=5000, debug=False, threaded=True)
