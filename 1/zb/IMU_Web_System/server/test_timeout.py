"""Durable task deadlines; all test data stays in temporary SQLite files."""

import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import create_app
import database
import tasks


class TimeoutTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="imu-timeout-tests-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "tasks.db"
        self.config = {"TESTING": True, "DATABASE": str(self.path)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()

    def create_sent(self, created_at, sent_at):
        with patch("tasks.time.time", return_value=created_at):
            response = self.client.post("/api/task/create", json={"device": "ESP32-S3-EYE", "action": "capture_once"})
        self.assertEqual(response.status_code, 201)
        request_id = response.get_json()["request_id"]
        with patch("tasks.time.time", return_value=sent_at):
            claim = self.client.get("/api/device/command?device=ESP32_S3_EYE")
        self.assertEqual(claim.get_json()["request_id"], request_id)
        return request_id

    def running(self, request_id, at):
        with patch("tasks.time.time", return_value=at):
            reply = self.client.post(f"/api/device/task/{request_id}/status",
                                     json={"device": "ESP32_S3_EYE", "status": "RUNNING"})
        self.assertEqual(reply.status_code, 200)

    def sweep(self, at):
        with self.app.app_context():
            return tasks.expire_overdue_tasks(now=at)

    def task(self, request_id, client=None):
        response = (client or self.client).get(f"/api/task/{request_id}")
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_sent_expires_only_after_30_seconds_and_logs_transition(self):
        sent_at = 2_000_000_000.0
        request_id = self.create_sent(sent_at - 2, sent_at)
        self.assertEqual(self.sweep(sent_at + 30), [])
        self.assertEqual(self.task(request_id)["status"], "SENT")
        with self.assertLogs(self.app.logger, level="INFO") as recorded:
            self.assertEqual(self.sweep(sent_at + 30.001), [(request_id, "SENT")])
        result = self.task(request_id)
        self.assertEqual((result["status"], result["error"]), ("TIMEOUT", "task timeout"))
        self.assertEqual(result["finished_at"], sent_at + 30.001)
        self.assertIsNone(result["result_sample_id"])
        self.assertIn(f"request_id={request_id} SENT -> TIMEOUT at=", recorded.output[0])
        self.assertEqual(self.sweep(sent_at + 300), [])

    def test_running_uses_first_running_receipt_for_60_second_deadline(self):
        start = 2_000_000_000.0
        request_id = self.create_sent(start - 100, start - 90)
        self.running(request_id, start)
        self.running(request_id, start + 30)  # Duplicate HTTP receipt cannot extend the deadline.
        self.assertEqual(self.sweep(start + 60), [])
        self.assertEqual(self.task(request_id)["status"], "RUNNING")
        self.assertEqual(self.sweep(start + 60.001), [(request_id, "RUNNING")])
        result = self.task(request_id)
        self.assertEqual((result["status"], result["error"]), ("TIMEOUT", "task timeout"))
        self.assertEqual(result["sent_at"], start - 90)
        self.assertEqual(result["finished_at"], start + 60.001)
        self.assertEqual(self.client.post(f"/api/device/task/{request_id}/status",
                                          json={"device": "ESP32_S3_EYE", "status": "FAILED", "error": "late"}).status_code, 409)
        self.assertEqual(self.client.post("/api/upload", json={
            "device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": .1, "acc_y": .2, "acc_z": .9,
            "timestamp": "2026-09-23 12:00:00", "request_id": request_id,
        }).status_code, 409)
        with self.app.app_context():
            self.assertEqual(database.get_db().execute("SELECT COUNT(*) FROM sensor_data").fetchone()[0], 0)

    def test_success_and_failed_tasks_never_expire(self):
        base = 2_000_000_000.0
        success_id = self.create_sent(base - 200, base - 190)
        self.running(success_id, base - 180)
        sample = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": .1, "acc_y": .2,
                  "acc_z": .9, "timestamp": "2026-09-23 12:00:00", "request_id": success_id}
        with patch("app.time.time", return_value=base - 170):
            self.assertEqual(self.client.post("/api/upload", json=sample).status_code, 201)
        failed_id = self.create_sent(base - 160, base - 150)
        with patch("tasks.time.time", return_value=base - 140):
            self.assertEqual(self.client.post(f"/api/device/task/{failed_id}/status",
                                              json={"device": "ESP32_S3_EYE", "status": "FAILED",
                                                    "error": "sensor_or_clock_error"}).status_code, 200)
        before = [self.task(value) for value in (success_id, failed_id)]
        self.assertEqual(self.sweep(base + 500), [])
        self.assertEqual([self.task(value) for value in (success_id, failed_id)], before)
        self.assertEqual(before[0]["result"]["id"], before[0]["result_sample_id"])

    def test_worker_resumes_after_restart_and_expires_existing_running_task(self):
        now = time.time()
        request_id = self.create_sent(now - 150, now - 120)
        self.running(request_id, now - 70)
        restarted = create_app({**self.config, "TESTING": False, "CAMERA_ENABLED": False,
                                "TASK_TIMEOUT_CHECK_INTERVAL": .05})
        worker, stop = restarted.extensions["task_timeout_worker"]
        self.addCleanup(worker.join, 1)
        self.addCleanup(stop.set)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.task(request_id, restarted.test_client())["status"] != "TIMEOUT":
            time.sleep(.02)
        self.assertTrue(worker.is_alive())
        self.assertEqual(self.task(request_id)["status"], "TIMEOUT")
        self.assertEqual(self.task(request_id)["error"], "task timeout")

    def test_v4_running_task_gets_grace_period_when_start_time_was_unknown(self):
        now = time.time()
        request_id = self.create_sent(now - 200, now - 190)
        self.running(request_id, now - 180)
        with closing(sqlite3.connect(self.path)) as db, db:
            columns = db.execute("PRAGMA table_info(tasks)").fetchall()
            db.execute("DROP TABLE task_running_times")
            db.execute("PRAGMA user_version = 4")
        restarted = create_app(self.config)
        with closing(sqlite3.connect(self.path)) as db:
            started_at = db.execute("SELECT started_at FROM task_running_times WHERE request_id=?", (request_id,)).fetchone()[0]
            self.assertGreaterEqual(started_at, now)
            self.assertEqual(db.execute("PRAGMA table_info(tasks)").fetchall(), columns)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], database.SCHEMA_VERSION)
        self.assertEqual(self.task(request_id, restarted.test_client())["status"], "RUNNING")
        with restarted.app_context():
            self.assertEqual(tasks.expire_overdue_tasks(now=started_at + 60.001), [(request_id, "RUNNING")])


if __name__ == "__main__":
    unittest.main()
