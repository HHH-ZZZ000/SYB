"""On-demand JPEG results. No frame cache, background capture or image analysis."""
import hashlib
import math
import os
import secrets
import time
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile

from flask import current_app, jsonify, request, send_file
from PIL import Image, UnidentifiedImageError

if __package__:
    from .database import get_db, TaskConflict
    from .tasks import validate_request_id
else:
    from database import get_db, TaskConflict
    from tasks import validate_request_id

MAX_IMAGE_BYTES = 256 * 1024
RETAIN_SECONDS = 600  # Protect newly returned/currently viewed results for ten minutes.


def validate_jpeg(data):
    if not 512 <= len(data) <= MAX_IMAGE_BYTES or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise ValueError("image_invalid")
    try:
        with Image.open(BytesIO(data), formats=["JPEG"]) as image:
            if not (16 <= image.width <= 1600 and 16 <= image.height <= 1200):
                raise ValueError("image_invalid")
            image.verify()
        # open()/verify() alone do not decode all JPEG pixels. Truncation is not allowed.
        with Image.open(BytesIO(data), formats=["JPEG"]) as image:
            image.load()
            return image.size
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError("image_invalid") from error


def image_path(name):
    root = Path(current_app.config["IMAGE_DIRECTORY"]).resolve()
    path = (root / name).resolve()
    if path.parent != root or path.suffix != ".jpg":
        raise ValueError("Invalid image path.")
    return path


def stored_image_state(record):
    """Do not advertise an expired/missing/corrupted file as an available result."""
    if not record["path"]:
        return "unavailable"
    try:
        data = image_path(record["path"]).read_bytes()
    except OSError:
        return "unavailable"
    try:
        validate_jpeg(data)
        return "success" if hashlib.sha256(data).hexdigest() == record["sha256"] else "invalid"
    except ValueError:
        return "invalid"


def cleanup_images(now=None):
    """Keep latest N per device plus short viewing leases; preserve audit rows."""
    now = time.time() if now is None else now
    db = get_db()
    with db:
        db.execute("BEGIN IMMEDIATE")
        old = db.execute("""
            SELECT i.id, i.path FROM image_records i JOIN tasks t ON t.request_id = i.task_id
            WHERE i.path IS NOT NULL AND i.retain_until < ? AND t.status = 'SUCCESS'
            AND i.id NOT IN (SELECT id FROM image_records WHERE device = i.device
                             ORDER BY id DESC LIMIT ?)
        """, (now, current_app.config["IMAGE_RETAIN_COUNT"])).fetchall()
        for row in old:
            try:
                image_path(row["path"]).unlink(missing_ok=True)
            except OSError:
                current_app.logger.warning("Image retention retry needed for record %s", row["id"])
                continue
            db.execute("UPDATE image_records SET path = NULL, purged_at = ? WHERE id = ?", (now, row["id"]))


def register_images(app):
    if not app.config.get("IMAGE_DIRECTORY"):
        app.config["IMAGE_DIRECTORY"] = str(Path(app.config["DATABASE"]).resolve().parent / "images")
    Path(app.config["IMAGE_DIRECTORY"]).mkdir(parents=True, exist_ok=True)
    app.extensions["image_cleanup"] = cleanup_images

    @app.post("/api/device/task/<task_id>/image")
    def upload_image(task_id):
        validate_request_id(task_id)
        token = app.config.get("TEST_RUN_TOKEN")
        test_header = request.headers.get("X-IMU-Test-Run")
        if token is not None or test_header is not None:
            if not (token and test_header and secrets.compare_digest(token, test_header)):
                return jsonify(error="Synthetic uploads require their isolated instance."), 403
        if request.mimetype != "image/jpeg":
            return jsonify(error="Content-Type must be image/jpeg."), 415
        # Only this binary endpoint gets a larger limit; JSON APIs keep 8 KiB.
        request.max_content_length = MAX_IMAGE_BYTES + 1
        device = request.headers.get("X-Device-ID")
        try:
            capture_time = int(request.headers.get("X-Capture-Time-Ms", "")) / 1000
        except (ValueError, OverflowError):
            raise ValueError("Invalid capture time.") from None
        if not math.isfinite(capture_time):
            raise ValueError("Invalid capture time.")
        # Bound the actual read too, including requests without Content-Length.
        data = request.stream.read(MAX_IMAGE_BYTES + 1)
        digest = hashlib.sha256(data).hexdigest()
        db = get_db()
        written = None
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                task = db.execute("SELECT * FROM tasks WHERE request_id = ?", (task_id,)).fetchone()
                if task is None:
                    raise LookupError("Task not found.")
                if task["device"] != device or task["action"] != "image_capture":
                    raise TaskConflict("Image task/device mismatch.")
                if task["status"] == "SUCCESS":
                    saved = db.execute("SELECT * FROM image_records WHERE id = ?", (task["result_image_id"],)).fetchone()
                    if not saved or saved["sha256"] != digest or saved["capture_time"] != capture_time:
                        raise TaskConflict("Task already has a different image.")
                    return jsonify(ok=True, request_id=task_id, status="SUCCESS", image_record_id=saved["id"]), 200
                if task["status"] != "RUNNING":
                    raise TaskConflict("An image upload requires this task to be RUNNING.")
                started = db.execute("SELECT started_at FROM task_running_times WHERE request_id = ?", (task_id,)).fetchone()
                received = time.time()
                # Existing /api/time synchronizes whole seconds; allow 2 s clock
                # quantization but never associate by latest image or device alone.
                try:
                    if not started or capture_time < started[0] - 2 or capture_time > received + 2:
                        raise ValueError("image_invalid")
                    width, height = validate_jpeg(data)
                except ValueError:
                    db.execute("UPDATE tasks SET status='FAILED', error='image_invalid', finished_at=? WHERE request_id=?",
                               (max(received, task["sent_at"]), task_id))
                    return jsonify(error="image_invalid", request_id=task_id, status="FAILED"), 422
                path = image_path(task_id + ".jpg")
                with NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as file:
                    temporary = Path(file.name)
                    try:
                        file.write(data)
                        file.flush()
                        os.fsync(file.fileno())
                    except Exception:
                        file.close()
                        temporary.unlink(missing_ok=True)
                        raise
                try:
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
                written = path
                cursor = db.execute("""INSERT INTO image_records
                    (task_id, device, capture_time, received_at, path, sha256, byte_length, width, height, retain_until)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (task_id, device, capture_time, received, path.name, digest, len(data), width, height, received + RETAIN_SECONDS))
                record_id = cursor.lastrowid
                db.execute("UPDATE tasks SET status='SUCCESS', result_image_id=?, finished_at=?, error=NULL WHERE request_id=?",
                           (record_id, max(received, task["sent_at"]), task_id))
        except Exception:
            if written:
                written.unlink(missing_ok=True)
            raise
        cleanup_images()
        return jsonify(ok=True, request_id=task_id, status="SUCCESS", image_record_id=record_id), 201

    @app.get("/api/images/<int:record_id>")
    def get_image(record_id):
        db = get_db()
        with db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM image_records WHERE id = ?", (record_id,)).fetchone()
            if row is None:
                raise LookupError("Image record not found.")
            if not row["path"]:
                return jsonify(error="Image expired under retention policy; task metadata retained."), 410
            path = image_path(row["path"])
            try:
                data = path.read_bytes()
                validate_jpeg(data)
                if hashlib.sha256(data).hexdigest() != row["sha256"]:
                    raise ValueError("image_invalid")
            except (OSError, ValueError):
                return jsonify(error="Stored image unavailable or invalid."), 410
            db.execute("UPDATE image_records SET retain_until = ? WHERE id = ?", (time.time() + RETAIN_SECONDS, record_id))
        return send_file(BytesIO(data), mimetype="image/jpeg", download_name=f"capture-{record_id}.jpg", max_age=0)
