"""SQLite persistence: request-scoped connections and atomic sample writes."""

import sqlite3
import threading
import time
from pathlib import Path

from flask import current_app, g

SCHEMA_VERSION = 7

class TaskConflict(ValueError):
    """A valid request conflicts with a task's owner, state or saved result."""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=5)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA busy_timeout = 5000")
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_app(app):
    app.teardown_appcontext(close_db)
    # One lock also keeps commit order and WebSocket publication order aligned.
    app.extensions["sample_lock"] = threading.RLock()
    app.extensions["sample_counts"] = {}
    Path(app.config["DATABASE"]).resolve().parent.mkdir(parents=True, exist_ok=True)
    with app.app_context():
        db = get_db()
        db.execute("PRAGMA journal_mode = WAL")
        legacy_columns = {"id", "device", "sensor", "acc_x", "acc_y", "acc_z", "timestamp", "received_at"}
        gyro_columns = {"gyro_x", "gyro_y", "gyro_z"}
        expected = legacy_columns | gyro_columns
        # Serialize schema inspection and migration with writers. Never relabel old
        # six-axis records as QMA6100P data or silently discard a nonempty legacy DB.
        db.execute("BEGIN IMMEDIATE")
        try:
            column_info = db.execute("PRAGMA table_info(sensor_data)").fetchall()
            columns = {row[1] for row in column_info}
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError("Database schema is newer than this server; migration stopped.")
            types = {"id": "INTEGER", "device": "TEXT", "sensor": "TEXT", "timestamp": "TEXT",
                     "acc_x": "REAL", "acc_y": "REAL", "acc_z": "REAL", "received_at": "REAL",
                     "gyro_x": "REAL", "gyro_y": "REAL", "gyro_z": "REAL"}
            known = (columns == legacy_columns and version == 2) or (columns == expected and version in (3, 4, 5, 6, 7))
            known = known and all(
                row[2].upper() == types.get(row[1])
                and row[3] == int(row[1] not in gyro_columns | {"id"})
                and row[4] is None and row[5] == int(row[1] == "id")
                for row in column_info
            )
            if columns:
                table_sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sensor_data'").fetchone()[0]
                known = known and "check(sensor='qma6100p')" in "".join(table_sql.lower().split())
            if columns and not known:
                if db.execute("SELECT COUNT(*) FROM sensor_data").fetchone()[0]:
                    raise RuntimeError("Legacy sensor_data is not empty; migration stopped without changing data. Back up and review the legacy database first.")
                db.execute("DROP TABLE sensor_data")
                columns = set()
            if columns == legacy_columns:
                # SQLite adds nullable columns in place: existing ids and readings
                # are untouched, and unavailable gyroscope readings remain NULL.
                for axis in ("gyro_x", "gyro_y", "gyro_z"):
                    db.execute(f"ALTER TABLE sensor_data ADD COLUMN {axis} REAL")
                columns = expected
            db.execute("""
            CREATE TABLE IF NOT EXISTS sensor_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device TEXT NOT NULL,
                sensor TEXT NOT NULL CHECK(sensor = 'QMA6100P'),
                acc_x REAL NOT NULL,
                acc_y REAL NOT NULL,
                acc_z REAL NOT NULL,
                timestamp TEXT NOT NULL,
                received_at REAL NOT NULL,
                gyro_x REAL,
                gyro_y REAL,
                gyro_z REAL
            )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS idx_sensor_device_id ON sensor_data(device, id)")
            db.execute("""
                CREATE TABLE IF NOT EXISTS image_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL UNIQUE,
                    device TEXT NOT NULL,
                    capture_time REAL NOT NULL,
                    received_at REAL NOT NULL,
                    path TEXT UNIQUE,
                    sha256 TEXT NOT NULL,
                    byte_length INTEGER NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    retain_until REAL NOT NULL,
                    purged_at REAL
                )
            """)
            # Extend the existing task table atomically. Preserve every old ID,
            # result and RUNNING deadline; sensor_data is not rebuilt or reset.
            task_columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
            migrating_tasks = bool(task_columns and "result_image_id" not in task_columns)
            running = []
            if migrating_tasks:
                if db.execute("SELECT 1 FROM sqlite_master WHERE name='task_running_times'").fetchone():
                    running = list(db.execute("SELECT request_id, started_at FROM task_running_times"))
                    db.execute("DROP TABLE task_running_times")
                db.execute("ALTER TABLE tasks RENAME TO tasks_v5")
            # Add task storage in the same migration transaction. Existing v3
            # sensor rows, columns and their autoincrement sequence stay intact.
            db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL UNIQUE,
                device TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('capture_once', 'image_capture')),
                status TEXT NOT NULL CHECK(status IN
                    ('PENDING', 'SENT', 'RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT')),
                created_at REAL NOT NULL,
                sent_at REAL,
                finished_at REAL,
                error TEXT,
                result_sample_id INTEGER UNIQUE REFERENCES sensor_data(id),
                result_image_id INTEGER UNIQUE REFERENCES image_records(id),
                interaction_request_id TEXT,
                CHECK(sent_at IS NULL OR sent_at >= created_at),
                CHECK(finished_at IS NULL OR finished_at >= COALESCE(sent_at, created_at)),
                CHECK(status NOT IN ('SENT', 'RUNNING', 'SUCCESS') OR sent_at IS NOT NULL),
                CHECK(status <> 'PENDING' OR sent_at IS NULL),
                CHECK((status IN ('SUCCESS', 'FAILED', 'TIMEOUT')) = (finished_at IS NOT NULL)),
                CHECK((status = 'SUCCESS') = (result_sample_id IS NOT NULL OR result_image_id IS NOT NULL)),
                CHECK(result_sample_id IS NULL OR action = 'capture_once'),
                CHECK(result_image_id IS NULL OR action = 'image_capture'),
                CHECK((status IN ('FAILED', 'TIMEOUT')) = (error IS NOT NULL))
            )
            """)
            if migrating_tasks:
                db.execute("""INSERT INTO tasks
                    (id, request_id, device, action, status, created_at, sent_at, finished_at, error, result_sample_id)
                    SELECT id, request_id, device, action, status, created_at, sent_at, finished_at, error, result_sample_id
                    FROM tasks_v5""")
                db.execute("DROP TABLE tasks_v5")
            db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_device_status_id ON tasks(device, status, id)")
            # Keep tasks and its public timestamps unchanged. RUNNING needs its
            # own durable start time so the 60-second deadline survives restarts.
            db.execute("""
            CREATE TABLE IF NOT EXISTS task_running_times (
                request_id TEXT PRIMARY KEY REFERENCES tasks(request_id) ON DELETE CASCADE,
                started_at REAL NOT NULL
            )
            """)
            if running:
                db.executemany("INSERT INTO task_running_times VALUES (?, ?)", running)
            if version < 5:
                # Older databases never recorded entry into RUNNING. Give those
                # in-flight tasks a full grace period from this migration.
                db.execute("""
                    INSERT OR IGNORE INTO task_running_times (request_id, started_at)
                    SELECT request_id, MAX(?, sent_at) FROM tasks WHERE status = 'RUNNING'
                """, (time.time(),))
            # Week 8 is additive: original predictions are immutable. Feedback
            # references them separately, including the task created by a retake.
            db.execute("""CREATE TABLE IF NOT EXISTS vision_inferences (
                inference_id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                image_record_id INTEGER NOT NULL REFERENCES image_records(id),
                image_task_id TEXT NOT NULL REFERENCES tasks(request_id),
                device TEXT NOT NULL,
                capture_time REAL NOT NULL,
                image_sha256 TEXT NOT NULL,
                image_path TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                inference_time REAL NOT NULL,
                label TEXT,
                score REAL,
                status TEXT NOT NULL CHECK(status IN ('accepted', 'unknown', 'failed')),
                reason TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                UNIQUE(request_id, image_record_id)
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS vision_feedback (
                feedback_id TEXT PRIMARY KEY,
                inference_id TEXT NOT NULL REFERENCES vision_inferences(inference_id),
                kind TEXT NOT NULL CHECK(kind IN ('correction', 'retake')),
                original_label TEXT,
                original_score REAL,
                corrected_label TEXT,
                feedback_time REAL NOT NULL,
                request_id TEXT,
                new_task_id TEXT UNIQUE REFERENCES tasks(request_id),
                CHECK((kind = 'correction' AND corrected_label IS NOT NULL AND new_task_id IS NULL)
                    OR (kind = 'retake' AND corrected_label IS NULL AND new_task_id IS NOT NULL))
            )""")
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            db.commit()
        except Exception:
            db.rollback()
            raise


def insert_sample(sample, received_at, *, return_created=False):
    db = get_db()
    # The context manager commits on success and rolls back on failure.
    with current_app.extensions["sample_lock"]:
        with db:
            db.execute("BEGIN IMMEDIATE")
            request_id = sample.get("request_id")
            task = None
            if request_id is not None:
                task = db.execute("SELECT * FROM tasks WHERE request_id = ?", (request_id,)).fetchone()
                if task is None:
                    raise LookupError("Task not found.")
                if task["device"] != sample["device"]:
                    raise TaskConflict("Task belongs to another device.")
                if task["action"] != "capture_once":
                    raise TaskConflict("An image task cannot be completed by a sensor sample.")
                if task["status"] == "SUCCESS":
                    saved = db.execute("SELECT * FROM sensor_data WHERE id = ?", (task["result_sample_id"],)).fetchone()
                    fields = ("device", "sensor", "acc_x", "acc_y", "acc_z", "timestamp", "gyro_x", "gyro_y", "gyro_z")
                    if saved is None or any(saved[key] != sample.get(key) for key in fields):
                        raise TaskConflict("Task already completed with different data.")
                    return (saved["id"], False) if return_created else saved["id"]
                if task["status"] != "RUNNING":
                    raise TaskConflict("A task upload requires RUNNING status.")
            previous = db.execute(
                "SELECT id FROM sensor_data WHERE device = ? ORDER BY id DESC LIMIT 1",
                (sample["device"],),
            ).fetchone()
            previous_id = previous[0] if previous else None
            cursor = db.execute("""
                INSERT INTO sensor_data
                    (device, sensor, acc_x, acc_y, acc_z, timestamp, received_at,
                     gyro_x, gyro_y, gyro_z)
                VALUES (:device, :sensor, :acc_x, :acc_y, :acc_z,
                        :timestamp, :received_at, :gyro_x, :gyro_y, :gyro_z)
            """, {"gyro_x": None, "gyro_y": None, "gyro_z": None, **sample, "received_at": received_at})
            if task is not None:
                # Commit the new reading and its task result together; failures
                # below roll back both, before counters or telemetry are updated.
                db.execute("""
                    UPDATE tasks SET status = 'SUCCESS', result_sample_id = ?, finished_at = ?, error = NULL
                    WHERE request_id = ? AND status = 'RUNNING'
                """, (cursor.lastrowid, max(received_at, task["sent_at"]), request_id))
            cached = current_app.extensions["sample_counts"].get(sample["device"])
            total = cached[1] + 1 if cached and cached[0] == previous_id else db.execute(
                "SELECT COUNT(*) FROM sensor_data WHERE device = ?", (sample["device"],)
            ).fetchone()[0]
        # Update only after a successful commit. Refresh from SQLite when another
        # writer has advanced the latest id; normal uploads never rescan history.
        current_app.extensions["sample_counts"][sample["device"]] = (cursor.lastrowid, total)
    return (cursor.lastrowid, True) if return_created else cursor.lastrowid


def get_latest(device):
    db = get_db()
    # Both reads share one snapshot, so the count matches the returned latest row.
    with current_app.extensions["sample_lock"]:
        db.execute("BEGIN")
        try:
            row = db.execute(
                "SELECT * FROM sensor_data WHERE device = ? ORDER BY id DESC LIMIT 1", (device,)
            ).fetchone()
            latest_id = row["id"] if row else None
            cached = current_app.extensions["sample_counts"].get(device)
            total = cached[1] if cached and cached[0] == latest_id else db.execute(
                "SELECT COUNT(*) FROM sensor_data WHERE device = ?", (device,)
            ).fetchone()[0]
            current_app.extensions["sample_counts"][device] = (latest_id, total)
        finally:
            db.rollback()
    return row, total


def get_history(device, limit, after_id=None):
    db = get_db()
    if after_id is None:
        rows = db.execute(
            "SELECT * FROM sensor_data WHERE device = ? ORDER BY id DESC LIMIT ?",
            (device, limit),
        ).fetchall()
        return list(reversed(rows)), False
    rows = db.execute(
        "SELECT * FROM sensor_data WHERE device = ? AND id > ? ORDER BY id ASC LIMIT ?",
        (device, after_id, limit + 1),
    ).fetchall()
    return rows[:limit], len(rows) > limit
