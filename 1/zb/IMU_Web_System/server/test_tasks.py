"""Task/command tests; all writes use temporary databases, never the device."""

import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

from app import create_app
import database
import tasks


V3_SCHEMA = """CREATE TABLE sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT NOT NULL, sensor TEXT NOT NULL CHECK(sensor = 'QMA6100P'),
    acc_x REAL NOT NULL, acc_y REAL NOT NULL, acc_z REAL NOT NULL,
    timestamp TEXT NOT NULL, received_at REAL NOT NULL,
    gyro_x REAL, gyro_y REAL, gyro_z REAL
)"""


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="imu-task-tests-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "tasks.db"
        self.config = {"TESTING": True, "DATABASE": str(self.path)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.payload = {"device": "ESP32-S3-EYE", "action": "capture_once"}

    def create(self, at=2000000000.0):
        with patch("tasks.time.time", return_value=at):
            response = self.client.post("/api/task/create", json=self.payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(set(response.get_json()), {"request_id", "status"})
        self.assertEqual(response.get_json()["status"], "PENDING")
        return response.get_json()["request_id"]

    def transition(self, request_id, status, at=2000000001.0, **kwargs):
        with self.app.app_context(), patch("tasks.time.time", return_value=at):
            return tasks.transition_task(request_id, status, **kwargs)

    def query(self, request_id):
        response = self.client.get("/api/task/" + request_id)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def insert_sample(self, device="ESP32_S3_EYE", at=2000000002.0):
        # Isolated fixture inserted by the test; this is not a device execution.
        with self.app.app_context():
            return database.insert_sample({"device": device, "sensor": "QMA6100P",
                                           "acc_x": .1, "acc_y": .2, "acc_z": .9,
                                           "timestamp": "2026-09-23 12:00:00"}, at)

    def test_create_and_query_pending_without_creating_sensor_data(self):
        request_id = self.create()
        task = self.query(request_id)
        self.assertEqual(task, {"id": 1, "request_id": request_id, "device": "ESP32_S3_EYE",
                               "action": "capture_once", "status": "PENDING", "created_at": 2000000000.0,
                               "sent_at": None, "finished_at": None, "error": None, "result_sample_id": None})
        self.assertEqual(UUID(request_id).version, 4)
        self.assertEqual(self.client.get("/api/latest").get_json()["total_samples"], 0)
        self.assertEqual(self.client.get("/api/task/" + request_id).headers["Cache-Control"], "no-store")

    def test_known_alias_is_normalized_without_rewriting_other_devices(self):
        for device in ("ESP32_S3_EYE", "OTHER-DEVICE"):
            self.payload["device"] = device
            self.assertEqual(self.query(self.create())["device"], device)

    def test_invalid_create_requests_do_not_write_tasks(self):
        invalid = [None, [], "task", 1, {}, {"device": "ESP32-S3-EYE"},
                   {**self.payload, "status": "SUCCESS"}, {**self.payload, "request_id": str(uuid4())}]
        invalid += [{**self.payload, "device": value} for value in (None, True, 123, "", "a/b", "x" * 65, "<script>")]
        invalid += [{**self.payload, "action": value} for value in (None, [], "reboot", "", 1)]
        for payload in invalid:
            with self.subTest(payload=payload):
                response = self.client.post("/api/task/create", data=json.dumps(payload), content_type="application/json")
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post("/api/task/create", data="text").status_code, 415)
        self.assertEqual(self.client.post("/api/task/create", data="{broken", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/api/task/create", json={**self.payload, "extra": "x" * 9000}).status_code, 413)
        with self.app.app_context():
            self.assertEqual(database.get_db().execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_unknown_or_invalid_request_id(self):
        self.assertEqual(self.client.get("/api/task/" + str(uuid4())).status_code, 404)
        for value in ("not-a-uuid", "00000000-0000-0000-0000-000000000000"):
            self.assertEqual(self.client.get("/api/task/" + value).status_code, 400)
        with self.assertRaises(LookupError):
            self.transition(str(uuid4()), "SENT")

    def test_concurrent_creation_uses_unique_uuid4_ids(self):
        def create(_):
            with self.app.test_client() as client:
                response = client.post("/api/task/create", json=self.payload)
                self.assertEqual(response.status_code, 201)
                return response.get_json()["request_id"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(create, range(40)))
        self.assertEqual(len(set(ids)), 40)
        self.assertTrue(all(UUID(value).version == 4 for value in ids))

    def test_uuid_constraint_rejects_collision_without_overwriting_task(self):
        request_id = self.create()
        before = self.query(request_id)
        with patch("tasks.uuid4", return_value=UUID(request_id)), self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.post("/api/task/create", json=self.payload)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.query(request_id), before)

    def test_success_flow_sets_timestamps_and_explicit_result_reference(self):
        request_id = self.create()
        sent = self.transition(request_id, "SENT")
        self.assertEqual(sent["sent_at"], 2000000001.0)
        running = self.transition(request_id, "RUNNING", at=2000000002.0)
        self.assertEqual(running["sent_at"], sent["sent_at"])
        self.assertIsNone(running["finished_at"])
        sample_id = self.insert_sample(at=2000000003.0)
        result = self.transition(request_id, "SUCCESS", at=2000000004.0, result_sample_id=sample_id)
        self.assertEqual(result["finished_at"], 2000000004.0)
        self.assertEqual(result["result_sample_id"], sample_id)
        self.assertEqual(self.query(request_id), result)
        self.assertEqual(self.client.get("/api/latest").get_json()["total_samples"], 1)

    def test_failure_and_timeout_from_each_dispatched_state(self):
        for active in ("SENT", "RUNNING"):
            for terminal in ("FAILED", "TIMEOUT"):
                with self.subTest(active=active, terminal=terminal):
                    request_id = self.create()
                    self.transition(request_id, "SENT")
                    if active == "RUNNING":
                        self.transition(request_id, "RUNNING")
                    result = self.transition(request_id, terminal, error="isolated test failure")
                    self.assertEqual(result["status"], terminal)
                    self.assertEqual(result["error"], "isolated test failure")
                    self.assertIsNotNone(result["finished_at"])
                    self.assertIsNone(result["result_sample_id"])

    def test_illegal_transitions_and_missing_evidence_leave_task_unchanged(self):
        request_id = self.create()
        before = self.query(request_id)
        for status, kwargs in [("RUNNING", {}), ("SUCCESS", {"result_sample_id": 1}), ("UNKNOWN", {}),
                               ("FAILED", {}), ("FAILED", {"error": "not dispatched"}),
                               ("TIMEOUT", {"error": "not dispatched"}), ("TIMEOUT", {"error": " "}),
                               ("FAILED", {"error": "x" * 1025}), ("SENT", {"error": "bad"}),
                               ("SENT", {"result_sample_id": 1})]:
            with self.subTest(status=status, kwargs=kwargs), self.assertRaises(ValueError):
                self.transition(request_id, status, **kwargs)
            self.assertEqual(self.query(request_id), before)

    def test_terminal_states_cannot_be_overwritten(self):
        for terminal in ("SUCCESS", "FAILED", "TIMEOUT"):
            request_id = self.create()
            self.transition(request_id, "SENT")
            self.transition(request_id, "RUNNING")
            evidence = {"result_sample_id": self.insert_sample()} if terminal == "SUCCESS" else {"error": "test error"}
            before = self.transition(request_id, terminal, **evidence)
            for target in tasks.TRANSITIONS:
                kwargs = {"error": "late error"} if target in ("FAILED", "TIMEOUT") else {}
                if target == "SUCCESS":
                    kwargs["result_sample_id"] = 1
                with self.assertRaises(ValueError):
                    self.transition(request_id, target, **kwargs)
                self.assertEqual(self.query(request_id), before)

    def test_success_rejects_missing_old_foreign_and_reused_samples(self):
        old_id = self.insert_sample(at=1999999999.0)
        foreign_id = self.insert_sample(device="OTHER")
        request_id = self.create()
        self.transition(request_id, "SENT")
        before = self.transition(request_id, "RUNNING")
        for sample_id in (None, True, 0, 1.5, 2**63, old_id, foreign_id, 999):
            with self.subTest(sample_id=sample_id), self.assertRaises(ValueError):
                self.transition(request_id, "SUCCESS", result_sample_id=sample_id)
            self.assertEqual(self.query(request_id), before)
        result_id = self.insert_sample()
        self.transition(request_id, "SUCCESS", result_sample_id=result_id)
        another = self.create()
        self.transition(another, "SENT")
        self.transition(another, "RUNNING")
        with self.assertRaises(ValueError):
            self.transition(another, "SUCCESS", result_sample_id=result_id)

    def test_competing_transitions_across_app_instances_preserve_one_terminal_result(self):
        request_id = self.create()
        self.transition(request_id, "SENT")
        other_app = create_app(self.config)
        def finish(args):
            app, status = args
            with app.app_context():
                try:
                    tasks.transition_task(request_id, status, error=status)
                    return status
                except ValueError:
                    return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(finish, [(self.app, "FAILED"), (other_app, "TIMEOUT")]))
        winners = [result for result in results if result]
        self.assertEqual(len(winners), 1)
        self.assertEqual(self.query(request_id)["status"], winners[0])

    def test_restart_preserves_pending_and_finished_tasks(self):
        pending = self.create()
        finished = self.create()
        self.transition(finished, "SENT")
        self.transition(finished, "FAILED", error="test failure")
        expected = [self.query(value) for value in (pending, finished)]
        for _ in range(2):
            restarted = create_app(self.config)
            actual = [restarted.test_client().get("/api/task/" + value).get_json() for value in (pending, finished)]
            self.assertEqual(actual, expected)

    def test_query_and_periodic_upload_do_not_execute_or_complete_a_task(self):
        request_id = self.create()
        before = self.query(request_id)
        response = self.client.post("/api/upload", json={"device": "ESP32_S3_EYE", "sensor": "QMA6100P",
                                                       "acc_x": .1, "acc_y": .2, "acc_z": .9,
                                                       "timestamp": "2026-09-23 12:00:00"})
        self.assertEqual(response.status_code, 201)
        with patch("tasks.time.time", return_value=2000000999.0):
            self.assertEqual(self.query(request_id), before)
        self.assertEqual(self.client.get("/api/device/command").status_code, 400)
        self.assertEqual(self.client.post("/api/task/" + request_id, json={"status": "SUCCESS"}).status_code, 405)

    def test_database_constraints_reject_invalid_status_and_orphan_result(self):
        request_id = self.create()
        with self.app.app_context():
            db = database.get_db()
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            for sql in ("UPDATE tasks SET status = 'INVALID'",
                        "UPDATE tasks SET status = 'SUCCESS', sent_at = created_at, finished_at = created_at, result_sample_id = 999"):
                with self.assertRaises(sqlite3.IntegrityError), db:
                    db.execute(sql)
        self.assertEqual(self.query(request_id)["status"], "PENDING")

    def test_claim_returns_latest_pending_and_never_repeats_it(self):
        older = self.create()
        newer = self.create(at=1999999999.0)  # ID order survives a clock adjustment.
        endpoint = "/api/device/command?device=ESP32_S3_EYE"
        with patch("tasks.time.time", return_value=2000000003.0):
            response = self.client.get(endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"request_id": newer, "command": "capture_once"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        claimed = self.query(newer)
        self.assertEqual(claimed["status"], "SENT")
        self.assertEqual(claimed["sent_at"], 2000000003.0)
        self.assertIsNone(claimed["finished_at"])
        self.assertIsNone(claimed["result_sample_id"])
        self.assertEqual(self.query(older)["status"], "PENDING")
        self.assertEqual(self.client.get(endpoint).get_json()["request_id"], older)
        for _ in range(3):
            self.assertEqual(self.client.get(endpoint).get_json(), {"command": "none"})
        self.assertEqual(self.query(newer), claimed)
        self.assertEqual(self.client.get("/api/latest").get_json()["total_samples"], 0)

    def test_command_requires_one_valid_device_and_does_not_cross_devices(self):
        request_id = self.create()
        for query in ("", "?device=", "?device=a/b", "?device=%3Cscript%3E",
                      "?device=" + "a" * 65, "?device=ESP32_S3_EYE&device=OTHER"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/api/device/command" + query).status_code, 400)
        self.assertEqual(self.client.get("/api/device/command?device=OTHER").get_json(), {"command": "none"})
        self.assertEqual(self.query(request_id)["status"], "PENDING")
        self.payload["device"] = "OTHER"
        other = self.create()
        self.assertEqual(self.client.get("/api/device/command?device=OTHER").get_json()["request_id"], other)
        self.assertEqual(self.query(request_id)["status"], "PENDING")

    def test_head_and_options_probes_do_not_claim_commands(self):
        request_id = self.create()
        endpoint = "/api/device/command?device=ESP32_S3_EYE"
        self.assertEqual(self.client.head(endpoint).status_code, 405)
        self.assertEqual(self.client.options(endpoint).status_code, 200)
        self.assertEqual(self.client.post(endpoint).status_code, 405)
        self.assertEqual(self.query(request_id)["status"], "PENDING")

    def test_concurrent_command_polls_across_apps_deliver_each_task_once(self):
        expected = {self.create() for _ in range(5)}
        other_app = create_app(self.config)
        def poll(index):
            with (self.app if index % 2 else other_app).test_client() as client:
                response = client.get("/api/device/command?device=ESP32_S3_EYE")
                self.assertEqual(response.status_code, 200)
                return response.get_json()
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(poll, range(20)))
        received = [item["request_id"] for item in responses if item["command"] == "capture_once"]
        self.assertEqual(len(received), 5)
        self.assertEqual(set(received), expected)
        self.assertEqual(sum(item == {"command": "none"} for item in responses), 15)
        self.assertTrue(all(self.query(value)["status"] == "SENT" for value in expected))

    def test_sent_command_is_not_redelivered_after_restart(self):
        request_id = self.create()
        endpoint = "/api/device/command?device=ESP32_S3_EYE"
        self.assertEqual(self.client.get(endpoint).get_json()["request_id"], request_id)
        restarted = create_app(self.config)
        self.assertEqual(restarted.test_client().get(endpoint).get_json(), {"command": "none"})
        self.assertEqual(restarted.test_client().get("/api/task/" + request_id).get_json()["status"], "SENT")

    def test_command_claim_skips_all_nonpending_states(self):
        for status in ("SENT", "RUNNING", "SUCCESS", "FAILED", "TIMEOUT"):
            request_id = self.create()
            self.transition(request_id, "SENT")
            if status in ("RUNNING", "SUCCESS"):
                self.transition(request_id, "RUNNING")
            if status == "SUCCESS":
                self.transition(request_id, status, result_sample_id=self.insert_sample())
            elif status in ("FAILED", "TIMEOUT"):
                self.transition(request_id, status, error="test")
        self.assertEqual(self.client.get("/api/device/command?device=ESP32_S3_EYE").get_json(), {"command": "none"})

    def test_claim_update_failure_rolls_back_and_returns_no_command(self):
        request_id = self.create()
        with self.app.app_context():
            with database.get_db() as db:
                db.execute("""CREATE TRIGGER reject_claim BEFORE UPDATE ON tasks
                              BEGIN SELECT RAISE(ABORT, 'isolated claim failure'); END""")
        with self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.get("/api/device/command?device=ESP32_S3_EYE")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("command", response.get_json())
        self.assertEqual(self.query(request_id)["status"], "PENDING")
        self.assertIsNone(self.query(request_id)["sent_at"])

    def v3_database(self, name):
        path = Path(self.directory.name) / name
        with closing(sqlite3.connect(path)) as db, db:
            db.execute(V3_SCHEMA)
            db.execute("PRAGMA user_version = 3")
            rows = [(7, "ESP32_S3_EYE", "QMA6100P", .125, -.25, 1., "2026-09-11 09:30:00", 1789090200., None, None, None),
                    (11, "OTHER", "QMA6100P", -.4, .8, .2, "2026-09-11 09:30:01", 1789090201., 1., 2., 3.)]
            db.executemany("INSERT INTO sensor_data VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        return path, rows

    def test_v3_migration_and_repeated_startup_preserve_all_sensor_values_and_sequence(self):
        path, rows = self.v3_database("v3.db")
        with closing(sqlite3.connect(path)) as db:
            columns = db.execute("PRAGMA table_info(sensor_data)").fetchall()
        for _ in range(2):
            migrated = create_app({**self.config, "DATABASE": str(path)})
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("SELECT * FROM sensor_data ORDER BY id").fetchall(), rows)
            self.assertEqual(db.execute("PRAGMA table_info(sensor_data)").fetchall(), columns)
            self.assertEqual(db.execute("SELECT seq FROM sqlite_sequence WHERE name='sensor_data'").fetchone()[0], 11)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], database.SCHEMA_VERSION)
            self.assertEqual({row[1] for row in db.execute("PRAGMA table_info(tasks)")},
                             {"id", "request_id", "device", "action", "status", "created_at", "sent_at", "finished_at", "error", "result_sample_id", "result_image_id", "interaction_request_id"})
        self.assertEqual(migrated.test_client().post("/api/task/create", json=self.payload).status_code, 201)

    def test_failed_v3_migration_rolls_back_tasks_and_version(self):
        path, rows = self.v3_database("conflict.db")
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE idx_tasks_device_status_id (conflict INTEGER)")
        with self.assertRaises(sqlite3.OperationalError):
            create_app({**self.config, "DATABASE": str(path)})
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT * FROM sensor_data ORDER BY id").fetchall(), rows)
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='tasks'").fetchone())

    def test_newer_database_version_is_rejected_without_changes(self):
        path, rows = self.v3_database("future.db")
        with closing(sqlite3.connect(path)) as db, db:
            db.execute(f"PRAGMA user_version = {database.SCHEMA_VERSION + 1}")
        with self.assertRaises(RuntimeError):
            create_app({**self.config, "DATABASE": str(path)})
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], database.SCHEMA_VERSION + 1)
            self.assertEqual(db.execute("SELECT * FROM sensor_data ORDER BY id").fetchall(), rows)


if __name__ == "__main__":
    unittest.main()
