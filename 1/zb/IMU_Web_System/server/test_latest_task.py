"""Read-only latest-task view for tasks created by Web or the device button."""

import tempfile
import unittest
from pathlib import Path

from app import create_app


class LatestTaskTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="imu-latest-task-")
        self.addCleanup(self.directory.cleanup)
        self.app = create_app({"TESTING": True, "DATABASE": str(Path(self.directory.name) / "tasks.db")})
        self.client = self.app.test_client()

    def create(self, device="ESP32_S3_EYE"):
        response = self.client.post("/api/task/create", json={"device": device, "action": "capture_once"})
        self.assertEqual(response.status_code, 201)
        return response.get_json()["request_id"]

    def test_latest_is_read_only_device_scoped_and_uses_associated_result(self):
        endpoint = "/api/task/latest?device=ESP32_S3_EYE"
        self.assertEqual(self.client.get(endpoint).get_json(), {"task": None})
        first = self.create()
        other = self.create("OTHER")
        latest = self.create()
        self.assertEqual(self.client.get(endpoint).get_json()["task"]["request_id"], latest)
        self.assertEqual(self.client.get("/api/task/latest?device=OTHER").get_json()["task"]["request_id"], other)
        self.assertEqual(self.client.get("/api/task/latest?device=bad/device").status_code, 400)
        self.assertEqual(self.client.get(endpoint).headers["Cache-Control"], "no-store")
        # Reading this projection cannot claim commands or change PENDING.
        self.assertEqual(self.client.get(f"/api/task/{latest}").get_json()["status"], "PENDING")
        self.assertEqual(self.client.get(f"/api/task/{first}").get_json()["status"], "PENDING")
        self.client.get("/api/device/command?device=ESP32_S3_EYE")
        self.client.post(f"/api/device/task/{latest}/status", json={"device": "ESP32_S3_EYE", "status": "RUNNING"})
        upload = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": 0.1, "acc_y": 0.2,
                  "acc_z": 0.9, "timestamp": "2026-09-23 12:00:00", "request_id": latest}
        sample_id = self.client.post("/api/upload", json=upload).get_json()["id"]
        self.client.post("/api/upload", json={**upload, "request_id": None, "acc_x": 0.8})
        task = self.client.get(endpoint).get_json()["task"]
        self.assertEqual(task["request_id"], latest)
        self.assertEqual(task["status"], "SUCCESS")
        self.assertEqual(task["result_sample_id"], sample_id)
        self.assertEqual(task["result"]["id"], sample_id)
        self.assertEqual(task["result"]["acc_x"], 0.1)


if __name__ == "__main__":
    unittest.main()
