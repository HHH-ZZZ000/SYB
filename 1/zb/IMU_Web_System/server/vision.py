"""Restricted image inference and append-only human feedback over Week 7 images."""
import hashlib
import json
import math
import os
import threading
import time
from uuid import uuid4

from flask import current_app, jsonify, request

if __package__:
    from .database import get_db, TaskConflict
    from .images import image_path, validate_jpeg, RETAIN_SECONDS
    from .tasks import validate_request_id, get_task
    from . import vision_model as model
else:
    from database import get_db, TaskConflict
    from images import image_path, validate_jpeg, RETAIN_SECONDS
    from tasks import validate_request_id, get_task
    import vision_model as model

HUMAN_LABELS = {"usable", "unusable", "occluded", "unknown"}


def body_fields(required, optional=()):
    body = request.get_json()
    if not isinstance(body, dict) or set(body) - set(required) - set(optional) or set(required) - set(body):
        raise ValueError("Invalid vision parameters.")
    return body


def describe(row):
    result = dict(row)
    result.pop("image_path", None)  # Never expose a local filesystem path.
    result["policy"] = json.loads(result.pop("policy_json"))
    result["raw_output"] = json.loads(result.pop("raw_json"))
    result["rejected"] = result["status"] == "unknown"
    result["score_semantics"] = model.SCORE_SEMANTICS
    result["limitation"] = model.LIMITATION
    result["label_source"] = "application_quality_band_not_model_class"
    result["correction_labels"] = sorted(HUMAN_LABELS)
    descriptions = {
        "quality_good": "画质参考：失真较少；是否满足你的用途仍需人工确认。",
        "quality_poor": "画质参考：失真较多，建议重新拍摄或人工确认。",
        "unknown": "当前基线无法给出明确画质建议，请重新拍摄或人工确认。",
    }
    result["message"] = descriptions.get(result["label"], "视觉模型不可用或推理失败，未生成可确认的判断。")
    result["message"] += " " + model.LIMITATION
    return result


def source_image(body):
    """Bind all client identifiers to one successful task, then read exact bytes."""
    if type(body["image_record_id"]) is not int or body["image_record_id"] <= 0:
        raise ValueError("Invalid image_record_id.")
    validate_request_id(body["image_task_id"])
    validate_request_id(body["request_id"])
    captured = body["capture_time"]
    if type(captured) not in (int, float) or not math.isfinite(captured):
        raise ValueError("Invalid capture_time.")
    db = get_db()
    with db:
        # Retention and reading the input share this short transaction. Model
        # computation holds no SQLite write lock and uses these exact bytes.
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("""SELECT i.* FROM image_records i JOIN tasks t ON t.request_id = i.task_id
            WHERE i.id = ? AND t.status = 'SUCCESS' AND t.action = 'image_capture'
            AND t.result_image_id = i.id AND t.device = i.device""", (body["image_record_id"],)).fetchone()
        if row is None:
            raise LookupError("Image result not found.")
        if (row["task_id"], row["device"], row["capture_time"]) != (body["image_task_id"], body["device"], captured):
            raise TaskConflict("Image/task/device/time mismatch.")
        if not row["path"]:
            raise ValueError("image_unavailable")
        try:
            data = image_path(row["path"]).read_bytes()
        except OSError:
            raise ValueError("image_unavailable") from None
        validate_jpeg(data)
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("image_invalid")
        db.execute("UPDATE image_records SET retain_until = MAX(retain_until, ?) WHERE id = ?",
                   (time.time() + RETAIN_SECONDS, row["id"]))
    return row, data


def register_vision(app):
    # Explicit adjustable UI policy, not a claimed teacher/model confidence
    # threshold. The wide middle band abstains; each result snapshots this policy.
    app.config.setdefault("VISION_GOOD_MAX", os.environ.get("IMU_VISION_GOOD_MAX", "30"))
    app.config.setdefault("VISION_POOR_MIN", os.environ.get("IMU_VISION_POOR_MIN", "60"))
    app.config.setdefault("VISION_MODEL_DIRECTORY", model.MODEL_DIRECTORY)
    gate = threading.Lock()

    @app.get("/api/vision/images/<int:image_id>")
    def explicit_image(image_id):
        # Explicit record selection only. There is intentionally no "latest" route.
        row = get_db().execute("SELECT task_id FROM image_records WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise LookupError("Image record not found.")
        return jsonify(get_task(row["task_id"]))

    @app.post("/api/vision/infer")
    def infer_image():
        body = body_fields({"request_id", "image_record_id", "image_task_id", "device", "capture_time"})
        row, data = source_image(body)
        db = get_db()
        previous = db.execute("SELECT * FROM vision_inferences WHERE request_id = ? AND image_record_id = ?",
                              (body["request_id"], row["id"])).fetchone()
        if previous:
            return jsonify(describe(previous))
        if not gate.acquire(blocking=False):
            return jsonify(error="model_busy"), 503
        try:
            # Recheck under the gate for simultaneous retries of the same request.
            previous = db.execute("SELECT * FROM vision_inferences WHERE request_id = ? AND image_record_id = ?",
                                  (body["request_id"], row["id"])).fetchone()
            if previous:
                return jsonify(describe(previous))
            policy = {"name": "quality-bands-v1", "basis": "adjustable_uncalibrated_application_policy",
                      "good_max": None, "poor_min": None}
            raw = {}; label = score = None; status = "failed"; reason = "model_failed"
            try:
                good, poor = float(app.config["VISION_GOOD_MAX"]), float(app.config["VISION_POOR_MIN"])
                if not 0 <= good < poor <= 100:
                    raise ValueError("Invalid quality-band configuration")
                policy.update(good_max=good, poor_min=poor)
                raw = model.predict(data, app.config["VISION_MODEL_DIRECTORY"])
                score = raw["score"]
                label, status, reason = model.decide(raw, good, poor)
            except model.ModelUnavailable as error:
                reason = str(error)
            except Exception:
                # No guessed label/score on a dependency, configuration or model error.
                raw = {}; label = score = None; status = "failed"; reason = "model_failed"
                current_app.logger.warning("Vision inference failed for image %s", row["id"])
            inference_id = str(uuid4())
            with db:
                db.execute("""INSERT INTO vision_inferences VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (inference_id, body["request_id"], row["id"], row["task_id"], row["device"],
                     row["capture_time"], row["sha256"], row["path"], model.MODEL_NAME, model.MODEL_VERSION,
                     time.time(), label, score, status, reason, json.dumps(policy), json.dumps(raw, allow_nan=False)))
            return jsonify(describe(db.execute("SELECT * FROM vision_inferences WHERE inference_id = ?",
                                               (inference_id,)).fetchone())), 201
        finally:
            gate.release()

    @app.get("/api/vision/inferences/<inference_id>")
    def get_inference(inference_id):
        validate_request_id(inference_id)
        db = get_db()
        row = db.execute("SELECT * FROM vision_inferences WHERE inference_id = ?", (inference_id,)).fetchone()
        if row is None:
            raise LookupError("Inference not found.")
        result = describe(row)
        result["feedback"] = [dict(f) for f in db.execute("""SELECT f.*, t.result_image_id AS new_image_record_id,
            v.inference_id AS new_inference_id FROM vision_feedback f
            LEFT JOIN tasks t ON t.request_id = f.new_task_id
            LEFT JOIN vision_inferences v ON v.image_task_id = f.new_task_id
            WHERE f.inference_id = ? ORDER BY f.feedback_time""", (inference_id,))]
        return jsonify(result)

    @app.post("/api/vision/feedback")
    def feedback():
        body = body_fields({"inference_id", "kind"}, {"corrected_label", "request_id", "new_task_id"})
        validate_request_id(body["inference_id"])
        db = get_db()
        with db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM vision_inferences WHERE inference_id = ?", (body["inference_id"],)).fetchone()
            if row is None:
                raise LookupError("Inference not found.")
            if body["kind"] == "correction":
                if set(body) != {"inference_id", "kind", "corrected_label"} or body["corrected_label"] not in HUMAN_LABELS:
                    raise ValueError("Invalid human label.")
            elif body["kind"] == "retake":
                if set(body) != {"inference_id", "kind", "request_id", "new_task_id"}:
                    raise ValueError("Invalid retake reference.")
                validate_request_id(body["request_id"]); validate_request_id(body["new_task_id"])
                task = db.execute("SELECT * FROM tasks WHERE request_id = ?", (body["new_task_id"],)).fetchone()
                if not task or task["device"] != row["device"] or task["action"] != "image_capture" or task["request_id"] == row["image_task_id"] or task["created_at"] < row["inference_time"] or task["interaction_request_id"] != body["request_id"]:
                    raise TaskConflict("Retake must refer to a new image task for this device and request.")
                previous = db.execute("SELECT * FROM vision_feedback WHERE new_task_id = ?", (body["new_task_id"],)).fetchone()
                if previous:
                    if previous["inference_id"] != row["inference_id"]:
                        raise TaskConflict("Retake already linked to another inference.")
                    return jsonify(dict(previous))
            else:
                raise ValueError("Unknown feedback kind.")
            record = {"feedback_id": str(uuid4()), "inference_id": row["inference_id"], "kind": body["kind"],
                      "original_label": row["label"], "original_score": row["score"],
                      "corrected_label": body.get("corrected_label"), "feedback_time": time.time(),
                      "request_id": body.get("request_id"), "new_task_id": body.get("new_task_id")}
            db.execute("INSERT INTO vision_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(record.values()))
        return jsonify(record), 201
