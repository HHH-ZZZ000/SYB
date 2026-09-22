"""Upgrade checks use temporary SQLite files and owned loopback services only."""

import io
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from simple_websocket import Client

from app import AXES, GYRO_AXES, create_app
from camera import CameraStream, jpeg_frames, validate_camera_url
from telemetry import TelemetryHub
from test_client import OwnedWSGIServer, QuietRequestHandler

V2_SCHEMA = """CREATE TABLE sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL,
    sensor TEXT NOT NULL CHECK(sensor = 'QMA6100P'),
    acc_x REAL NOT NULL, acc_y REAL NOT NULL, acc_z REAL NOT NULL,
    timestamp TEXT NOT NULL, received_at REAL NOT NULL)"""
# Parser-only fixture bytes. These never represent hardware or enter production.
JPEG_FIXTURE = b"\xff\xd8\xff\xe0\x00\x06TEST\xff\xd9"


def wait_until(predicate, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Timed out waiting for the isolated test condition.")


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="imu-upgrade-tests-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "isolated.db"
        self.config = {"TESTING": True, "DATABASE": str(self.path)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.sample = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P",
                       "acc_x": 0.1, "acc_y": 0.2, "acc_z": 0.98,
                       "timestamp": "2026-09-14 12:00:00"}

    def test_nullable_gyro_preserves_old_upload_and_requires_complete_finite_triple(self):
        for optional in [{}, {"gyro_x": None}, dict.fromkeys(GYRO_AXES)]:
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, **optional}).status_code, 201)
            result = self.client.get("/api/latest").get_json()
            self.assertTrue(all(result[key] is None for key in GYRO_AXES))
        real_extension_contract = dict(zip(GYRO_AXES, [3.0, -4.0, 0.0]))
        self.assertEqual(self.client.post("/api/upload", json={**self.sample, **real_extension_contract}).status_code, 201)
        self.assertEqual({key: self.client.get("/api/latest").get_json()[key] for key in GYRO_AXES}, real_extension_contract)
        for bad in [True, "2", float("nan"), float("inf"), 10**400, None]:
            payload = {**self.sample, **real_extension_contract, "gyro_y": bad}
            self.assertEqual(self.client.post("/api/upload", json=payload).status_code, 400)
        self.assertEqual(self.client.post("/api/upload", json={**self.sample, "gyro_x": 0}).status_code, 400)
        self.assertEqual(self.client.get("/api/latest").get_json()["total_samples"], 4)

    def _v2_database(self):
        path = Path(self.temp.name) / "v2.db"
        with closing(sqlite3.connect(path)) as db, db:
            db.execute(V2_SCHEMA)
            db.execute("PRAGMA user_version = 2")
            rows = [(7, "ESP32_S3_EYE", "QMA6100P", .125, -.25, 1.0, "2026-09-11 09:30:00", 1789090200.125),
                    (11, "ESP32_S3_EYE", "QMA6100P", -.4, .8, .2, "2026-09-11 09:30:01", 1789090201.875)]
            db.executemany("INSERT INTO sensor_data VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        return path, rows

    def test_nonempty_v2_migration_keeps_every_original_value_and_id_on_restart(self):
        path, rows = self._v2_database()
        app = create_app({**self.config, "DATABASE": str(path)})
        create_app({**self.config, "DATABASE": str(path)})
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("SELECT id, device, sensor, acc_x, acc_y, acc_z, timestamp, received_at FROM sensor_data ORDER BY id").fetchall(), rows)
            self.assertEqual(db.execute("SELECT gyro_x, gyro_y, gyro_z FROM sensor_data").fetchall(), [(None, None, None)] * 2)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
        self.assertEqual(app.test_client().post("/api/upload", json=self.sample).get_json()["id"], 12)

    def test_migration_error_rolls_back_added_columns_and_version(self):
        path, rows = self._v2_database()
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE idx_sensor_device_id (conflict INTEGER)")
        with self.assertRaises(sqlite3.OperationalError):
            create_app({**self.config, "DATABASE": str(path)})
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("SELECT * FROM sensor_data ORDER BY id").fetchall(), rows)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(len(db.execute("PRAGMA table_info(sensor_data)").fetchall()), 8)

    def test_history_holds_a_complete_120_second_window_at_10_hz(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executemany("INSERT INTO sensor_data (device,sensor,acc_x,acc_y,acc_z,timestamp,received_at) VALUES (?,?,?,?,?,?,?)",
                           [(self.sample["device"], "QMA6100P", .1, .2, .98, self.sample["timestamp"], 1789370000 + index / 10) for index in range(1201)])
        rows = self.client.get("/api/history?limit=2000").get_json()["samples"]
        self.assertEqual(len(rows), 1201)
        self.assertEqual(rows[-1]["received_at_ms"] - rows[0]["received_at_ms"], 120000)
        self.assertTrue(all(row["gyro_x"] is None for row in rows))

    def test_repeated_upload_and_latest_do_not_rescan_the_history_count(self):
        self.client.post("/api/upload", json=self.sample)
        import database
        statements = []
        with self.app.app_context():
            database.get_db().set_trace_callback(statements.append)
            for _ in range(5):
                self.assertEqual(self.client.post("/api/upload", json=self.sample).status_code, 201)
                self.client.get("/api/latest")
            self.assertFalse(any("COUNT(" in sql.upper() for sql in statements))
        self.assertEqual(self.client.get("/api/latest").get_json()["total_samples"], 6)

    def test_test_instances_ignore_production_camera_environment_and_never_discover(self):
        with patch.dict(os.environ, {"IMU_CAMERA_URL": "http://192.168.1.99:81/stream"}):
            for options in [{"TESTING": True}, {"TESTING": False, "TEST_RUN_TOKEN": "isolated-only"}]:
                app = create_app({**self.config, **options})
                camera = app.extensions["camera"]
                camera.discover("192.168.1.99")
                self.assertFalse(camera.enabled)
                self.assertIsNone(camera._url)
                self.assertIsNone(camera._thread)
                self.assertEqual(app.test_client().get("/api/camera").status_code, 503)
        status = self.client.get("/api/status").get_json()
        self.assertEqual(status["status"], "offline")
        self.assertEqual(status["camera"]["status"], "offline")

    def test_websocket_http_handshake_commit_delivery_heartbeat_and_isolation(self):
        server = OwnedWSGIServer("127.0.0.1", 0, self.app, handler=QuietRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertNotEqual(server.server_port, 5000)
        ws = Client.connect(f"ws://127.0.0.1:{server.server_port}/ws/telemetry")
        self.addCleanup(lambda: ws.close() if ws.connected else None)
        first = json.loads(ws.receive(timeout=3))
        self.assertEqual(first["type"], "snapshot")
        self.assertIsNone(first["latest"]["id"])
        self.assertEqual(first["latest"]["gyro_x"], None)
        self.client.post("/api/upload", json={**self.sample, "device": "OTHER_DEVICE"})
        other = create_app({**self.config, "DATABASE": str(Path(self.temp.name) / "other.db")})
        other.test_client().post("/api/upload", json=self.sample)
        # The connected app's real HTTP request goes to its owned ephemeral port.
        from urllib.request import Request, urlopen
        req = Request(f"http://127.0.0.1:{server.server_port}/api/upload", data=json.dumps(self.sample).encode(), headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=3) as response:
            self.assertEqual(response.status, 201)
            committed_id = json.load(response)["id"]
        message = json.loads(ws.receive(timeout=3))
        self.assertEqual(message["type"], "sample")
        self.assertEqual(message["sample"]["id"], committed_id)
        self.assertEqual(message["total_samples"], 1)
        self.assertEqual(message["sample"]["gyro_x"], None)
        heartbeat = json.loads(ws.receive(timeout=3))
        self.assertEqual(heartbeat["type"], "heartbeat")
        self.assertNotIn("sample", heartbeat)
        ws.close()
        wait_until(lambda: len(self.app.extensions["telemetry"]._subscribers) == 0)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sensor_data").fetchone()[0], 2)

    def test_slow_subscriber_is_bounded_and_does_not_delay_publisher(self):
        hub = TelemetryHub(capacity=2, max_clients=1)
        subscriber = hub.subscribe("ESP32_S3_EYE")
        self.assertIsNone(hub.subscribe("ESP32_S3_EYE"))
        message = {"sample": {"device": "ESP32_S3_EYE", "id": 1}}
        for _ in range(1000):
            hub.publish(message)
        self.assertTrue(subscriber.overrun.is_set())
        self.assertEqual(subscriber.messages.qsize(), 2)
        hub.unsubscribe(subscriber)
        self.assertIsNotNone(hub.subscribe("ESP32_S3_EYE"))


class CameraTests(unittest.TestCase):
    def test_parser_accepts_fragmented_frames_and_rejects_junk_truncation_and_oversize(self):
        class Fragments:
            def __init__(self, data):
                self.parts = iter(data)
            def read(self, size):
                return next(self.parts, b"")
        stream = Fragments([b"--boundary\r\nContent-Type: image/jpeg\r\n\r\n\xff", b"\xd8" + JPEG_FIXTURE[2:5], JPEG_FIXTURE[5:] + b"\r\n" + JPEG_FIXTURE])
        frames = jpeg_frames(stream)
        self.assertEqual(next(frames), JPEG_FIXTURE)
        self.assertEqual(next(frames), JPEG_FIXTURE)
        with self.assertRaises(EOFError):
            next(frames)
        for content, limit, error in [(b"x" * 70000, 100, ValueError),
                                     (b"\xff\xd8" + b"x" * 100, 32, ValueError),
                                     (b"\xff\xd8truncated", 100, EOFError),
                                     (b"\xff\xd8a\xff\xd8b\xff\xd9", 100, ValueError)]:
            with self.subTest(content=content[:20]), self.assertRaises(error):
                next(jpeg_frames(io.BytesIO(content), max_bytes=limit))

    def test_camera_urls_cannot_redirect_to_arbitrary_hosts_or_loopback(self):
        self.assertEqual(validate_camera_url("http://192.168.1.10:81/stream"), "http://192.168.1.10:81/stream")
        for value in ["http://127.0.0.1:81/stream", "http://8.8.8.8/stream", "http://localhost/stream", "file:///camera", "http://u:p@192.168.1.10/stream", "http://192.168.1.10/stream?url=bad", "http://169.254.1.1/stream"]:
            with self.subTest(url=value), self.assertRaises(ValueError):
                validate_camera_url(value)

    def test_actual_loopback_mjpeg_online_disconnect_recovery_and_sensor_independence(self):
        disconnected = threading.Event()
        stopping = threading.Event()
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=test")
                self.end_headers()
                try:
                    while not stopping.is_set() and not disconnected.is_set():
                        self.wfile.write(b"--test\r\nContent-Type: image/jpeg\r\n\r\n" + JPEG_FIXTURE + b"\r\n")
                        self.wfile.flush()
                        stopping.wait(.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args):
                pass
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        upstream.daemon_threads = True
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        self.addCleanup(stopping.set)
        with tempfile.TemporaryDirectory(prefix="imu-camera-tests-") as directory:
            app = create_app({"TESTING": True, "DATABASE": str(Path(directory) / "camera-test.db"),
                              "CAMERA_ENABLED": True, "CAMERA_ALLOW_TEST_UPSTREAM": True,
                              "CAMERA_URL": f"http://127.0.0.1:{upstream.server_port}/stream"})
            camera = app.extensions["camera"]
            camera._timeout = .3
            camera._retry_seconds = .05
            camera._stale_seconds = .3
            try:
                client = app.test_client()
                wait_until(lambda: client.get("/api/status").get_json()["camera"]["status"] == "online")
                first = client.get("/api/camera", buffered=False)
                second = client.get("/api/camera", buffered=False)
                self.assertIn(JPEG_FIXTURE, next(first.response))
                self.assertIn(JPEG_FIXTURE, next(second.response))
                self.assertEqual(len(requests), 1)  # Two viewers, one real upstream.
                self.assertEqual(camera._clients, 2)
                first.close()
                second.close()
                self.assertEqual(camera._clients, 0)
                disconnected.set()
                wait_until(lambda: camera.status()["status"] == "offline")
                self.assertEqual(client.get("/api/camera").status_code, 503)
                sample = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": .1, "acc_y": .2, "acc_z": .98, "timestamp": "2026-09-14 12:00:00"}
                self.assertEqual(client.post("/api/upload", json=sample).status_code, 201)
                status = client.get("/api/status").get_json()
                self.assertEqual(status["status"], "online")
                self.assertEqual(status["total_samples"], 1)
                disconnected.clear()
                wait_until(lambda: camera.status()["status"] == "online")
                self.assertEqual(client.get("/api/latest").get_json()["total_samples"], 1)
            finally:
                camera.stop()
                self.assertFalse(camera._thread.is_alive())
