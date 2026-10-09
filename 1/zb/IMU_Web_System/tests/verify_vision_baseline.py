"""Real model / simulated-device verification in a temporary database.

Usage: .venv/Scripts/python tests/verify_vision_baseline.py INPUT_JPEG OUTPUT_JSON
INPUT_JPEG is an explicit public test photo, not a live camera input. Derived
blur/cover/constant images below are labelled as such, never as physical captures.
"""
import json
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from app import create_app

original = Image.open(sys.argv[1]).convert("RGB")
half = original.copy(); ImageDraw.Draw(half).rectangle((0, 0, original.width // 2, original.height), fill="black")
covered = original.copy(); ImageDraw.Draw(covered).rectangle((0, 0, round(original.width * .85), original.height), fill="black")
samples = [("public_photo", original), ("derived_blur", original.filter(ImageFilter.GaussianBlur(8))),
           ("derived_85_percent_cover", covered), ("generated_black", Image.new("RGB", original.size, "black")),
           ("derived_half_cover_counterexample", half)]
report = {"scope": "REAL BRISQUE inference; SIMULATED device uploads in TEMPORARY database; not hardware acceptance",
          "input": str(Path(sys.argv[1]).resolve()), "samples": []}
with tempfile.TemporaryDirectory(prefix="imu-vision-real-model-") as directory:
    app = create_app({"TESTING": True, "DATABASE": str(Path(directory) / "test.db")})
    client = app.test_client(); device = "VISION_TEST_ONLY"; previous = None
    for name, picture in samples:
        client.post('/api/upload', json={"device": device, "sensor": "QMA6100P", "acc_x": .1, "acc_y": .2, "acc_z": .9, "timestamp": "2026-09-30 00:00:00"})
        interaction = str(uuid4())
        task = client.post('/api/task/create', json={"device": device, "action": "image_capture", "interaction_request_id": interaction}).get_json()["request_id"]
        assert client.get('/api/device/command', query_string={"device": device}).get_json()["request_id"] == task
        assert client.post(f'/api/device/task/{task}/status', json={"device": device, "status": "RUNNING"}).status_code == 200
        if previous:
            assert client.post('/api/vision/feedback', json={"inference_id": previous["inference_id"], "kind": "retake", "request_id": interaction, "new_task_id": task}).status_code == 201
        out = BytesIO(); picture.save(out, format="JPEG", quality=90)
        assert client.post(f'/api/device/task/{task}/image', data=out.getvalue(), headers={"Content-Type": "image/jpeg", "X-Device-ID": device, "X-Capture-Time-Ms": str(round(time.time()*1000))}).status_code == 201
        image = client.get('/api/task/'+task).get_json()["result"]
        reply = client.post('/api/vision/infer', json={"request_id": interaction, "image_record_id": image["id"], "image_task_id": task, "device": device, "capture_time": image["capture_time"]})
        assert reply.status_code == 201
        result = reply.get_json()
        assert result["status"] in ('accepted', 'unknown')
        assert result["raw_output"]["runtime"] == '4.10.0'
        if previous:
            assert result["inference_id"] != previous["inference_id"] and result["image_record_id"] != previous["image_record_id"] and result["image_task_id"] != previous["image_task_id"]
            assert result["capture_time"] > previous["capture_time"]
        previous = result
        if name == 'derived_half_cover_counterexample':
            # Explicit test annotation: half of the intended scene was removed.
            # This is NOT a BRISQUE high-confidence classification: no such output exists.
            correction = client.post('/api/vision/feedback', json={"inference_id": result["inference_id"], "kind": "correction", "corrected_label": "unusable"})
            assert correction.status_code == 201
            saved = client.get('/api/vision/inferences/'+result["inference_id"]).get_json()
            assert saved["label"] == result["label"] and saved["score"] == result["score"]
            assert saved["feedback"][0]["corrected_label"] == 'unusable'
            result["verified_feedback"] = saved["feedback"]
        report["samples"].append({"name": name, "result": result})
        print(name, result["label"], result["score"], result["reason"])
Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
