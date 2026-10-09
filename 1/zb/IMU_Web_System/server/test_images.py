"""Week 7 tests: isolated synthetic JPEGs; never claims real hardware coverage."""
import hashlib
import sqlite3
import tempfile
import time
import unittest
from io import BytesIO
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from PIL import Image
from app import create_app
from database import get_db
from images import cleanup_images, validate_jpeg
from assistant import interpret

DEVICE = "ESP32_S3_EYE"


def jpeg(color="blue"):
    out = BytesIO()
    Image.new("RGB", (320, 240), color).save(out, format="JPEG")
    return out.getvalue()


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.db"
        self.app = create_app({"TESTING": True, "DATABASE": str(self.path), "IMAGE_RETAIN_COUNT": 2})
        self.client = self.app.test_client()
        self.online()

    def online(self):
        result = self.client.post("/api/upload", json={"device": DEVICE, "sensor": "QMA6100P",
            "acc_x": .1, "acc_y": -.2, "acc_z": .9, "timestamp": "2026-09-29 12:00:00"})
        self.assertEqual(result.status_code, 201)

    def create(self, interaction=None):
        payload = {"device": DEVICE, "action": "image_capture"}
        if interaction: payload["interaction_request_id"] = interaction
        response = self.client.post("/api/task/create", json=payload)
        self.assertEqual(response.status_code, 201, response.get_json())
        task_id = response.get_json()["request_id"]
        command = self.client.get("/api/device/command", query_string={"device": DEVICE}).get_json()
        self.assertEqual(command, {"command": "image_capture", "request_id": task_id})
        self.assertEqual(self.client.post(f"/api/device/task/{task_id}/status", json={"device": DEVICE, "status": "RUNNING"}).status_code, 200)
        return task_id

    def upload(self, task_id, data=None, captured=None, device=DEVICE):
        return self.client.post(f"/api/device/task/{task_id}/image", data=jpeg() if data is None else data,
            headers={"Content-Type": "image/jpeg", "X-Device-ID": device,
                     "X-Capture-Time-Ms": str(captured or round(time.time() * 1000))})

    def task(self, task_id):
        return self.client.get(f"/api/task/{task_id}").get_json()

    def test_success_exact_task_device_time_jpeg_and_retry(self):
        interaction = str(uuid4())
        task_id = self.create(interaction)
        captured = round(time.time() * 1000)
        result = self.upload(task_id, captured=captured)
        self.assertEqual(result.status_code, 201)
        task = self.task(task_id)
        self.assertNotEqual(task_id, interaction)
        self.assertEqual(task["interaction_request_id"], interaction)
        self.assertEqual(task["image_status"], "success")
        self.assertEqual(task["result_image_id"], result.get_json()["image_record_id"])
        record = task["result"]
        self.assertEqual((record["task_id"], record["device"], record["capture_time"]), (task_id, DEVICE, captured/1000))
        image = self.client.get(record["url"])
        self.assertEqual(image.status_code, 200)
        self.assertEqual(validate_jpeg(image.data), (320, 240))
        self.assertEqual(hashlib.sha256(image.data).hexdigest(), record["sha256"])
        self.assertEqual(self.upload(task_id, captured=captured).status_code, 200)
        self.assertEqual(self.upload(task_id, jpeg("red"), captured).status_code, 409)
        self.assertEqual(len(list((Path(self.temp.name)/"images").glob("*.jpg"))), 1)

    def test_camera_unavailable_does_not_reuse_previous_image(self):
        previous = self.create(); self.upload(previous)
        task_id = self.create()
        result = self.client.post(f"/api/device/task/{task_id}/status", json={"device": DEVICE, "status": "FAILED", "error": "camera_unavailable"})
        self.assertEqual(result.status_code, 200)
        task = self.task(task_id)
        self.assertEqual(task["image_status"], "unavailable")
        self.assertIsNone(task["result_image_id"])
        self.assertNotIn("result", task)
        self.assertEqual(self.task(previous)["status"], "SUCCESS")

    def test_offline_fast_no_task(self):
        with self.app.app_context(), get_db() as db:
            db.execute("UPDATE sensor_data SET received_at = ?", (time.time()-30,))
        started = time.perf_counter()
        response = self.client.post("/api/task/create", json={"device": DEVICE, "action": "image_capture"})
        self.assertLess(time.perf_counter()-started, 1)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"], "device_offline")
        with self.app.app_context(): self.assertEqual(get_db().execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_empty_truncated_oversized_and_old_time_fail(self):
        for data in (b"", b"\xff\xd8broken\xff\xd9", jpeg()[:600]+b"\xff\xd9", jpeg()[:-2], b"x"*(256*1024+1)):
            with self.subTest(bytes=len(data)):
                task_id = self.create()
                self.assertEqual(self.upload(task_id, data).status_code, 422)
                self.assertEqual(self.task(task_id)["image_status"], "invalid")
                self.assertIsNone(self.task(task_id)["result_image_id"])
        task_id = self.create()
        self.assertEqual(self.upload(task_id, captured=round((time.time()-60)*1000)).status_code, 422)

    def test_cross_device_and_imu_cannot_finish_image_task(self):
        task_id = self.create()
        self.assertEqual(self.upload(task_id, device="OTHER").status_code, 409)
        response = self.client.post("/api/upload", json={"device": DEVICE, "sensor": "QMA6100P", "acc_x": .1,
            "acc_y": .2, "acc_z": .9, "timestamp": "2026-09-29 12:00:00", "request_id": task_id})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.task(task_id)["status"], "RUNNING")

    def test_late_upload_still_saved_for_original_interaction(self):
        # Browser cancellation does not cancel firmware. Server keeps only X's
        # association, not any subsequent interaction's ID (frontend tested separately).
        old_interaction = str(uuid4())
        task_id = self.create(old_interaction)
        self.assertEqual(self.upload(task_id).status_code, 201)
        self.assertEqual(self.task(task_id)["interaction_request_id"], old_interaction)

    def test_retention_keeps_recent_and_viewed_records_and_audit(self):
        ids = []
        for _ in range(4):
            task_id = self.create(); self.upload(task_id); ids.append(task_id)
        with self.app.app_context():
            db = get_db()
            with db:
                db.execute("UPDATE image_records SET retain_until = 0")
                # Oldest record is currently being viewed: do not delete it.
                db.execute("UPDATE image_records SET retain_until = ? WHERE task_id = ?", (time.time()+600, ids[0]))
            cleanup_images()
        self.assertEqual(self.client.get(self.task(ids[0])["result"]["url"]).status_code, 200)
        expired = self.task(ids[1])
        self.assertEqual(expired["image_status"], "unavailable")
        self.assertIsNone(expired["result"]["url"])
        self.assertEqual(self.client.get(f"/api/images/{expired['result_image_id']}").status_code, 410)
        self.assertEqual(expired["status"], "SUCCESS")  # historical execution evidence retained
        self.assertEqual(len(list((Path(self.temp.name)/"images").glob("*.jpg"))), 3)

    def test_tampered_file_is_not_served_as_valid(self):
        task_id = self.create(); self.upload(task_id)
        path = Path(self.temp.name)/"images"/(task_id+".jpg")
        path.write_bytes(jpeg("red"))
        task = self.task(task_id)
        self.assertEqual(task["image_status"], "invalid")
        self.assertIsNone(task["result"]["url"])
        self.assertEqual(self.client.get(f"/api/images/{task['result_image_id']}").status_code, 410)

    def test_image_intents_and_clarification(self):
        devices = [{"device": DEVICE}]
        for text in ("看一下现在的环境", "拍一张照片", "获取当前画面", "拍一张现在的环境图"):
            result = interpret(text, {"device": DEVICE}, devices)
            self.assertEqual((result["status"], result["intent"], result["parameters"]["data_type"]), ("ready", "image_capture", "image"))
        missing = interpret("拍一张照片", {}, devices)
        self.assertEqual(missing["status"], "clarify")
        self.assertEqual(interpret("确认", {"device": DEVICE, "pending": missing["context"]["pending"]}, devices)["intent"], "image_capture")
        for text in ("不要拍照", "不拍照", "不是拍一张照片", "如果我想拍一张照片", "上次的照片", "拍两张照片", "拍一张照片并重新采集一次"):
            self.assertNotEqual(interpret(text, {"device": DEVICE}, devices)["status"], "ready")

    def test_v5_migration_preserves_samples_tasks_and_running_deadlines(self):
        legacy = Path(self.temp.name)/"v5.db"
        from test_tasks import V3_SCHEMA
        with closing(sqlite3.connect(legacy)) as db, db:
            db.execute(V3_SCHEMA)
            db.execute("INSERT INTO sensor_data VALUES (1, ?, 'QMA6100P', .1, .2, .9, '2026-09-29 12:00:00', 1000, NULL, NULL, NULL)", (DEVICE,))
            db.execute("""CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
                device TEXT NOT NULL, action TEXT NOT NULL CHECK(action='capture_once'), status TEXT NOT NULL,
                created_at REAL NOT NULL, sent_at REAL, finished_at REAL, error TEXT,
                result_sample_id INTEGER UNIQUE REFERENCES sensor_data(id))""")
            db.execute("CREATE TABLE task_running_times(request_id TEXT PRIMARY KEY REFERENCES tasks(request_id) ON DELETE CASCADE, started_at REAL NOT NULL)")
            old_id = str(uuid4())
            db.execute("INSERT INTO tasks VALUES (1, ?, ?, 'capture_once', 'RUNNING', 998, 999, NULL, NULL, NULL)", (old_id, DEVICE))
            db.execute("INSERT INTO task_running_times VALUES (?, 1000)", (old_id,))
            db.execute("PRAGMA user_version=5")
        migrated = create_app({"TESTING": True, "DATABASE": str(legacy)})
        with migrated.app_context():
            db = get_db()
            self.assertEqual(db.execute("SELECT count(*) FROM sensor_data").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT request_id, started_at FROM task_running_times").fetchone()[:], (old_id, 1000))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 6)
        self.assertEqual(migrated.test_client().get(f"/api/task/{old_id}").get_json()["status"], "RUNNING")


if __name__ == "__main__": unittest.main()
