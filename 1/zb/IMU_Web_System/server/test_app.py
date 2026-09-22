"""Run: python -m unittest discover -s server -p 'test_*.py' -v"""

import json
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import AXES, GYRO_AXES, create_app


class IMUSystemTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="imu-tests-")
        self.addCleanup(self.directory.cleanup)
        self.db_path = Path(self.directory.name) / "sensor.db"
        self.config = {"TESTING": True, "DATABASE": str(self.db_path)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.sample = {
            "device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": 0.12, "acc_y": 0.05, "acc_z": 0.98,
            "timestamp": "2026-09-09 12:00:00",
        }

    def count_rows(self):
        connection = sqlite3.connect(self.db_path)
        try:
            return connection.execute("SELECT COUNT(*) FROM sensor_data").fetchone()[0]
        finally:
            connection.close()

    def test_empty_database_is_explicitly_offline(self):
        response = self.client.get("/api/latest")
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["status"], "offline")
        self.assertEqual(result["total_samples"], 0)
        self.assertIsNone(result["timestamp"])
        self.assertTrue(all(result[axis] is None for axis in AXES))
        self.assertEqual(self.client.get("/api/history").get_json()["samples"], [])

    def test_upload_round_trip_and_database_schema(self):
        response = self.client.post("/api/upload", json=self.sample)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["id"], 1)
        latest = self.client.get("/api/latest").get_json()
        for key, value in self.sample.items():
            self.assertEqual(latest[key], value)
        self.assertEqual(latest["status"], "online")
        self.assertEqual(latest["total_samples"], 1)
        self.assertLess(latest["age_seconds"], 2)
        self.assertEqual(self.count_rows(), 1)
        connection = sqlite3.connect(self.db_path)
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(sensor_data)")}
            self.assertEqual({"id", "received_at", *GYRO_AXES, *self.sample}, columns)
        finally:
            connection.close()

    def test_offline_boundary_uses_server_receipt_not_device_clock(self):
        with patch("app.time.time", return_value=2000000000.0):
            self.client.post("/api/upload", json={**self.sample, "timestamp": "2000-01-01 00:00:00"})
        for delta, expected in [(9.9, "online"), (10.0, "online"), (10.001, "offline")]:
            with self.subTest(delta=delta), patch("app.time.time", return_value=2000000000.0 + delta):
                self.assertEqual(self.client.get("/api/latest").get_json()["status"], expected)

    def test_rejected_upload_does_not_refresh_status(self):
        with patch("app.time.time", return_value=2000000000.0):
            self.client.post("/api/upload", json=self.sample)
        with patch("app.time.time", return_value=2000000020.0):
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "acc_x": True}).status_code, 400)
            result = self.client.get("/api/latest").get_json()
            self.assertEqual(result["status"], "offline")
            self.assertEqual(result["total_samples"], 1)

    def test_missing_fields_and_non_object_body(self):
        for field in self.sample:
            sample = {key: value for key, value in self.sample.items() if key != field}
            with self.subTest(field=field):
                self.assertEqual(self.client.post("/api/upload", json=sample).status_code, 400)
        for payload in [[], None, "sample", 17]:
            self.assertEqual(self.client.post("/api/upload", data=json.dumps(payload), content_type="application/json").status_code, 400)
        self.assertEqual(self.count_rows(), 0)

    def test_invalid_numbers_never_reach_database(self):
        for axis in AXES:
            for value in [True, False, "0.12", None, float("nan"), float("inf"), -float("inf"), 10**400, 2.01, -2.01]:
                with self.subTest(axis=axis, value=str(value)[:30]):
                    self.assertEqual(self.client.post("/api/upload", json={**self.sample, axis: value}).status_code, 400)
        self.assertEqual(self.count_rows(), 0)

    def test_invalid_device_and_timestamp(self):
        for device in ["", "x" * 65, "<script>", "a/b", "x'; DROP TABLE sensor_data;--", 123]:
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "device": device}).status_code, 400)
        for timestamp in ["2026-02-30 12:00:00", "2026-09-09 25:00:00", "2026-9-9 12:00:00", "2026-09-09T12:00:00", None]:
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "timestamp": timestamp}).status_code, 400)
        self.assertEqual(self.count_rows(), 0)

    def test_content_type_malformed_json_and_body_limit(self):
        self.assertEqual(self.client.post("/api/upload", data="text").status_code, 415)
        bad = self.client.post("/api/upload", data="{broken", content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("error", bad.get_json())
        oversized = self.client.post("/api/upload", json={**self.sample, "padding": "x" * 9000})
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(self.count_rows(), 0)

    def test_history_order_incremental_cursor_and_limits(self):
        for value in range(7):
            self.client.post("/api/upload", json={**self.sample, "acc_x": value / 10})
        result = self.client.get("/api/history?limit=3").get_json()
        self.assertEqual([row["id"] for row in result["samples"]], [5, 6, 7])
        result = self.client.get("/api/history?after_id=2&limit=3").get_json()
        self.assertEqual([row["id"] for row in result["samples"]], [3, 4, 5])
        self.assertTrue(result["has_more"])
        result = self.client.get("/api/history?after_id=5&limit=3").get_json()
        self.assertEqual([row["id"] for row in result["samples"]], [6, 7])
        self.assertFalse(result["has_more"])
        self.assertEqual(self.client.get("/api/history?after_id=7").get_json()["samples"], [])
        for query in ["limit=0", "limit=2001", "limit=x", "after_id=-1", "after_id=1.2", "after_id=9999999999999999999", "device=%3Cscript%3E"]:
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/api/history?" + query).status_code, 400)

    def test_device_queries_are_isolated(self):
        self.client.post("/api/upload", json=self.sample)
        self.client.post("/api/upload", json={**self.sample, "device": "API_TEST", "acc_x": 0.42})
        self.assertEqual(self.client.get("/api/latest").get_json()["acc_x"], 0.12)
        self.assertEqual(self.client.get("/api/latest?device=API_TEST").get_json()["acc_x"], 0.42)
        self.assertEqual(len(self.client.get("/api/history").get_json()["samples"]), 1)
        self.assertEqual(self.client.get("/api/latest?device=NO_DEVICE").get_json()["total_samples"], 0)

    def test_persistence_survives_application_restart(self):
        self.client.post("/api/upload", json=self.sample)
        second_app = create_app(self.config)
        latest = second_app.test_client().get("/api/latest").get_json()
        self.assertEqual(latest["total_samples"], 1)
        self.assertEqual(latest["timestamp"], self.sample["timestamp"])

    def test_concurrent_uploads_are_all_committed(self):
        def upload(index):
            with self.app.test_client() as client:
                return client.post("/api/upload", json={**self.sample, "acc_x": index / 100}).status_code
        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(upload, range(40)))
        self.assertTrue(all(status == 201 for status in statuses))
        self.assertEqual(self.count_rows(), 40)
        result = self.client.get("/api/history").get_json()["samples"]
        self.assertEqual(len({row["id"] for row in result}), 40)

    def test_database_failure_returns_json_without_success(self):
        with patch("app.database.insert_sample", side_effect=sqlite3.OperationalError("test failure")):
            with self.assertLogs(self.app.logger, level="ERROR"):
                response = self.client.post("/api/upload", json=self.sample)
        self.assertEqual(response.status_code, 503)
        self.assertIn("error", response.get_json())
        self.assertEqual(self.count_rows(), 0)

    def test_wrong_sensor_legacy_fields_and_test_requests_are_refused(self):
        for payload in [{**self.sample, "sensor": "MPU6050"}, {**self.sample, "gyro_x": True}]:
            self.assertEqual(self.client.post("/api/upload", json=payload).status_code, 400)
        self.assertEqual(self.client.post("/api/upload", json=self.sample,
                                        headers={"X-IMU-Test-Run": "synthetic-test"}).status_code, 403)
        self.assertEqual(self.count_rows(), 0)

    def test_empty_legacy_schema_migrates_and_nonempty_legacy_is_preserved(self):
        legacy = Path(self.directory.name) / "legacy.db"
        with closing(sqlite3.connect(legacy)) as db, db:
            db.execute("CREATE TABLE sensor_data (id INTEGER PRIMARY KEY, device TEXT, legacy_note TEXT)")
            db.execute("INSERT INTO sensor_data VALUES (1, 'OLD_DEVICE', 'preserve this record')")
        with self.assertRaisesRegex(RuntimeError, "not empty"):
            create_app({"TESTING": True, "DATABASE": str(legacy)})
        with closing(sqlite3.connect(legacy)) as db, db:
            self.assertEqual(db.execute("SELECT legacy_note FROM sensor_data").fetchone()[0], "preserve this record")
            db.execute("DELETE FROM sensor_data")
        migrated = create_app({"TESTING": True, "DATABASE": str(legacy)})
        self.assertEqual(migrated.test_client().post("/api/upload", json=self.sample).status_code, 201)
        with closing(sqlite3.connect(legacy)) as db:
            self.assertEqual({row[1] for row in db.execute("PRAGMA table_info(sensor_data)")}, {"id", "received_at", *GYRO_AXES, *self.sample})

    def test_page_assets_and_no_cache_api(self):
        for path in ["/", "/static/style.css", "/static/app.js"]:
            response = self.client.get(path)
            self.addCleanup(response.close)
            self.assertEqual(response.status_code, 200)
        response = self.client.get("/api/latest")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/api/does-not-exist").status_code, 404)
        self.assertEqual(self.client.get("/api/upload").status_code, 405)
        self.assertAlmostEqual(int(self.client.get("/api/time").data), time.time(), delta=2)


if __name__ == "__main__":
    unittest.main()
