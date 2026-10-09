"""Local HTTP fixture for JS tool integration tests, never the production DB/hardware."""
import json
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import jsonify, request
from werkzeug.serving import make_server, WSGIRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from app import create_app


class QuietHandler(WSGIRequestHandler):
    def log_request(self, *args, **kwargs):
        pass


temp = tempfile.TemporaryDirectory(prefix="imu-assistant-http-")
app = create_app({"TESTING": True, "DATABASE": str(Path(temp.name) / "test.db"),
                  "ASSISTANT_DEVICE_ALIASES": {"1号设备": "ESP32_S3_EYE"}})
sample = {"device": "ESP32_S3_EYE", "sensor": "QMA6100P", "acc_x": 0.1, "acc_y": -0.2, "acc_z": 0.9}


@app.post("/__fixture__/respond")
def respond():
    # A simulated device follows the existing claim -> RUNNING -> upload protocol.
    body = request.get_json()
    with app.test_client() as client:
        rid = client.get("/api/device/command?device=ESP32_S3_EYE").get_json()["request_id"]
        if rid != body["request_id"]:
            return jsonify(error="Fixture task mismatch"), 409
        client.post(f"/api/device/task/{rid}/status", json={"device": sample["device"], "status": "RUNNING"})
        if body.get("fail"):
            return client.post(f"/api/device/task/{rid}/status", json={"device": sample["device"], "status": "FAILED", "error": "sensor_error"})
        timestamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
        result = client.post("/api/upload", json={**sample, "acc_x": 0.42, "timestamp": timestamp, "request_id": rid}).get_json()
        # A newer periodic sample must never replace the task-associated result.
        client.post("/api/upload", json={**sample, "acc_x": 0.88, "timestamp": timestamp})
        return jsonify(result)


with app.test_client() as client:
    client.post("/api/upload", json={**sample, "timestamp": "2026-01-01 08:00:00"})

server = make_server("127.0.0.1", 0, app, threaded=True, request_handler=QuietHandler)
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
    temp.cleanup()
