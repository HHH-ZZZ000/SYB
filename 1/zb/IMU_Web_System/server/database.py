"""SQLite persistence: request-scoped connections and atomic sample writes."""

import sqlite3
import threading
from pathlib import Path

from flask import current_app, g


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=5)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA busy_timeout = 5000")
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
            if version > 3:
                raise RuntimeError("Database schema is newer than this server; migration stopped.")
            types = {"id": "INTEGER", "device": "TEXT", "sensor": "TEXT", "timestamp": "TEXT",
                     "acc_x": "REAL", "acc_y": "REAL", "acc_z": "REAL", "received_at": "REAL",
                     "gyro_x": "REAL", "gyro_y": "REAL", "gyro_z": "REAL"}
            known = (columns == legacy_columns and version == 2) or (columns == expected and version == 3)
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
            db.execute("PRAGMA user_version = 3")
            db.commit()
        except Exception:
            db.rollback()
            raise


def insert_sample(sample, received_at):
    db = get_db()
    # The context manager commits on success and rolls back on failure.
    with current_app.extensions["sample_lock"]:
        with db:
            db.execute("BEGIN IMMEDIATE")
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
            cached = current_app.extensions["sample_counts"].get(sample["device"])
            total = cached[1] + 1 if cached and cached[0] == previous_id else db.execute(
                "SELECT COUNT(*) FROM sensor_data WHERE device = ?", (sample["device"],)
            ).fetchone()[0]
        # Update only after a successful commit. Refresh from SQLite when another
        # writer has advanced the latest id; normal uploads never rescan history.
        current_app.extensions["sample_counts"][sample["device"]] = (cursor.lastrowid, total)
    return cursor.lastrowid


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
