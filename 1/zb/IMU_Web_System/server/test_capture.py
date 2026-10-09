"""Phase 3 receipt/atomic-result tests using isolated SQLite databases only."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from app import create_app
import database


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="imu-capture-tests-")
        self.addCleanup(self.temp.cleanup)
        self.config = {"TESTING": True, "DATABASE": str(Path(self.temp.name) / "capture.db")}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.sample = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": .12, "acc_y": -.3,
                       "acc_z": .98, "timestamp": "2026-09-23 12:00:00"}

    def create(self):
        return self.client.post("/api/task/create", json={"device": "ESP32-S3-EYE", "action": "capture_once"}).get_json()["request_id"]

    def receipt(self, rid, status="RUNNING", **kwargs):
        return self.client.post(f"/api/device/task/{rid}/status", json={"device": "ESP32_S3_EYE", "status": status, **kwargs})

    def running(self):
        rid = self.create()
        self.assertEqual(self.client.get("/api/device/command?device=ESP32_S3_EYE").get_json()["request_id"], rid)
        self.assertEqual(self.receipt(rid).status_code, 200)
        return rid

    def task(self, rid):
        return self.client.get(f"/api/task/{rid}").get_json()

    def count(self):
        return self.client.get("/api/latest").get_json()["total_samples"]

    def test_full_flow_returns_associated_sample_even_after_newer_periodic_upload(self):
        old = self.client.post("/api/upload", json=self.sample).get_json()["id"]
        rid = self.running()
        response = self.client.post("/api/upload", json={**self.sample, "acc_x": .42, "request_id": rid})
        self.assertEqual(response.status_code, 201)
        saved = response.get_json()
        self.assertEqual(saved["request_id"], rid)
        self.assertEqual(saved["status"], "SUCCESS")
        self.assertGreater(saved["id"], old)
        self.client.post("/api/upload", json={**self.sample, "acc_x": .88, "request_id": None})
        task = self.task(rid)
        self.assertEqual(task["status"], "SUCCESS")
        self.assertEqual(task["result_sample_id"], saved["id"])
        self.assertEqual(task["result"]["id"], saved["id"])
        self.assertEqual(task["result"]["acc_x"], .42)
        self.assertEqual(task["result"]["timestamp"], self.sample["timestamp"])
        self.assertEqual(self.count(), 3)
        self.assertIsNotNone(task["finished_at"])

    def test_old_and_null_request_id_uploads_remain_compatible(self):
        rid = self.running()
        for extra in ({}, {"request_id": None}):
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, **extra}).status_code, 201)
        self.assertEqual(self.count(), 2)
        self.assertEqual(self.task(rid)["status"], "RUNNING")
        for value in ("", "wrong", True, 42, {}, []):
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": value}).status_code, 400)
        self.assertEqual(self.count(), 2)

    def test_receipt_validation_ownership_and_idempotence(self):
        rid = self.create()
        self.assertEqual(self.receipt(rid).status_code, 409)
        self.client.get("/api/device/command?device=ESP32_S3_EYE")
        self.assertEqual(self.receipt(rid, device="OTHER").status_code, 409)
        for payload in ({}, [], {"device": "ESP32_S3_EYE", "status": "SUCCESS"},
                        {"device": "ESP32_S3_EYE", "status": "FAILED"},
                        {"device": "ESP32_S3_EYE", "status": "RUNNING", "error": "bad"}):
            self.assertEqual(self.client.post(f"/api/device/task/{rid}/status", json=payload).status_code, 400)
        self.assertEqual(self.client.post(f"/api/device/task/{rid}/status", data="text").status_code, 415)
        self.assertEqual(self.receipt(str(uuid4())).status_code, 404)
        self.assertEqual(self.receipt(rid).status_code, 200)
        before = self.task(rid)
        self.assertEqual(self.receipt(rid).status_code, 200)
        self.assertEqual(self.task(rid), before)
        self.assertEqual(self.receipt(rid, "FAILED", error="sensor_error").status_code, 200)
        self.assertEqual(self.receipt(rid, "FAILED", error="sensor_error").status_code, 200)
        self.assertEqual(self.receipt(rid).status_code, 409)
        self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": rid}).status_code, 409)
        self.assertEqual(self.count(), 0)

    def test_upload_requires_running_task_and_correct_device(self):
        rid = self.create()
        for expected in ("PENDING", "SENT"):
            self.assertEqual(self.task(rid)["status"], expected)
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": rid}).status_code, 409)
            self.client.get("/api/device/command?device=ESP32_S3_EYE")
        self.receipt(rid)
        self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": rid, "device": "OTHER"}).status_code, 409)
        self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": str(uuid4())}).status_code, 404)
        self.assertEqual(self.count(), 0)

    def test_retries_are_idempotent_concurrently_and_after_restart(self):
        rid = self.running()
        payload = {**self.sample, "request_id": rid}
        def upload(_):
            with self.app.test_client() as client:
                response = client.post("/api/upload", json=payload)
                self.assertEqual(response.status_code, 201)
                return response.get_json()["id"]
        with patch.object(self.app.extensions["telemetry"], "publish") as publish:
            with ThreadPoolExecutor(max_workers=6) as pool:
                ids = list(pool.map(upload, range(12)))
            self.assertEqual(publish.call_count, 1)
            self.assertNotIn("request_id", publish.call_args.args[0]["sample"])
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(self.count(), 1)
        restarted = create_app(self.config)
        self.assertEqual(restarted.test_client().post("/api/upload", json=payload).get_json()["id"], ids[0])
        self.assertEqual(self.client.post("/api/upload", json={**payload, "acc_x": .99}).status_code, 409)
        self.assertEqual(self.receipt(rid, "FAILED", error="lost_response").status_code, 409)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.task(rid)["status"], "SUCCESS")

    def test_task_update_failure_rolls_back_sample_counter_and_telemetry(self):
        self.client.post("/api/upload", json=self.sample)
        rid = self.running()
        with self.app.app_context(), database.get_db() as db:
            db.execute("""CREATE TRIGGER reject_success BEFORE UPDATE ON tasks WHEN NEW.status='SUCCESS'
                          BEGIN SELECT RAISE(ABORT, 'isolated rollback test'); END""")
        with patch.object(self.app.extensions["telemetry"], "publish") as publish, self.assertLogs(self.app.logger, level="ERROR"):
            self.assertEqual(self.client.post("/api/upload", json={**self.sample, "request_id": rid}).status_code, 503)
            publish.assert_not_called()
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.task(rid)["status"], "RUNNING")
        self.assertIsNone(self.task(rid)["result_sample_id"])
        with self.app.app_context(), database.get_db() as db:
            db.execute("DROP TRIGGER reject_success")
        result = self.client.post("/api/upload", json={**self.sample, "request_id": rid}).get_json()
        self.assertEqual(result["id"], 2)
        self.assertEqual(self.count(), 2)


if __name__ == "__main__":
    unittest.main()
