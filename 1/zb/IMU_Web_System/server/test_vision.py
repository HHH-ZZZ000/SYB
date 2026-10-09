"""Week 8 isolated API tests. Injected scores test policy, NOT real model accuracy."""
import json
import sqlite3
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from test_images import ImageTests, DEVICE, jpeg
from database import get_db, SCHEMA_VERSION
from assistant import interpret
import vision_model


class VisionTests(unittest.TestCase):
    setUp = ImageTests.setUp
    online = ImageTests.online
    create = ImageTests.create
    upload = ImageTests.upload
    task = ImageTests.task

    def image(self):
        task = self.create(); self.upload(task)
        return self.task(task)["result"]

    def infer(self, image, score=12., **overrides):
        body = {"request_id": str(uuid4()), "image_record_id": image["id"], "image_task_id": image["task_id"],
                "device": image["device"], "capture_time": image["capture_time"], **overrides}
        with patch("vision_model.predict", return_value={"score": score, "runtime": "simulated-test", "reason": None}):
            return self.client.post("/api/vision/infer", json=body)

    def test_policy_bands_unknown_and_score_semantics(self):
        image = self.image()
        for score, label in [(10., "quality_good"), (45., "unknown"), (80., "quality_poor"), (None, "unknown")]:
            result = self.infer(image, score).get_json()
            self.assertEqual(result["label"], label)
            self.assertEqual(result["score"], score)
            self.assertEqual(result["rejected"], label == "unknown")
            self.assertIn("越低越好", result["score_semantics"])
            self.assertEqual(result["policy"]["basis"], "adjustable_uncalibrated_application_policy")

    def test_correction_preserves_original_prediction_and_version(self):
        result = self.infer(self.image(), 90.).get_json()
        before = self.client.get('/api/vision/inferences/'+result["inference_id"]).get_json()
        for label in ("usable", "unknown"):
            reply = self.client.post('/api/vision/feedback', json={"inference_id": result["inference_id"], "kind": "correction", "corrected_label": label})
            self.assertEqual(reply.status_code, 201)
            self.assertEqual(reply.get_json()["original_score"], 90.)
        after = self.client.get('/api/vision/inferences/'+result["inference_id"]).get_json()
        self.assertEqual(len(after.pop("feedback")), 2)
        before.pop("feedback")
        self.assertEqual(before, after)
        self.assertEqual(after["model_version"], vision_model.MODEL_VERSION)

    def test_retake_separate_image_task_inference_and_feedback(self):
        old = self.infer(self.image()).get_json()
        interaction = str(uuid4()); new_task = self.create(interaction)
        link = {"inference_id": old["inference_id"], "kind": "retake", "request_id": interaction, "new_task_id": new_task}
        self.assertEqual(self.client.post('/api/vision/feedback', json=link).status_code, 201)
        # This same task can complete even after the browser stops waiting.
        self.upload(new_task)
        fresh = self.infer(self.task(new_task)["result"], request_id=interaction).get_json()
        for key in ("inference_id", "image_record_id", "image_task_id"):
            self.assertNotEqual(old[key], fresh[key])
        feedback = self.client.get('/api/vision/inferences/'+old["inference_id"]).get_json()["feedback"][0]
        self.assertEqual(feedback["new_image_record_id"], fresh["image_record_id"])
        self.assertEqual(feedback["new_inference_id"], fresh["inference_id"])

    def test_wrong_old_image_task_device_time_and_path_rejected(self):
        old, new = self.image(), self.image()
        for change in ({"image_task_id": old["task_id"]}, {"device": "OTHER"}, {"capture_time": new["capture_time"]-100}, {"image_path": "elsewhere.jpg"}):
            self.assertIn(self.infer(new, **change).status_code, (400, 409))
        with self.app.app_context():
            self.assertEqual(get_db().execute('SELECT count(*) FROM vision_inferences').fetchone()[0], 0)

    def test_explicit_record_selection_never_uses_latest(self):
        old, new = self.image(), self.image()
        response = self.client.get('/api/vision/images/'+str(old["id"]))
        self.assertEqual(response.get_json()["result"]["id"], old["id"])
        self.assertNotEqual(response.get_json()["result_image_id"], new["id"])
        self.assertEqual(self.client.get('/api/vision/images/999').status_code, 404)
        parsed = interpret("分析图片记录 2", {"device": DEVICE}, [{"device": DEVICE}])
        self.assertEqual(parsed["parameters"]["image_record_id"], 2)
        missing = interpret("分析图片记录 2", {}, [{"device": DEVICE}])
        continued = interpret("确认", {"device": DEVICE, "pending": missing["context"]["pending"]}, [{"device": DEVICE}])
        self.assertEqual(continued["parameters"]["image_record_id"], 2)
        self.assertNotEqual(interpret("分析图片 2 和图片 3", {"device": DEVICE}, [{"device": DEVICE}])["status"], "ready")

    def test_invalid_missing_and_expired_image_no_prediction(self):
        image = self.image()
        path = Path(self.temp.name)/"images"/(image["task_id"]+'.jpg')
        path.write_bytes(jpeg("red"))
        self.assertEqual(self.infer(image).status_code, 400)
        path.unlink()
        self.assertEqual(self.infer(image).status_code, 400)

    def test_unavailable_and_failure_no_fake_score(self):
        image = self.image()
        body = {"image_record_id": image["id"], "image_task_id": image["task_id"], "device": DEVICE, "capture_time": image["capture_time"]}
        for error in (vision_model.ModelUnavailable("model_unavailable"), RuntimeError("test failure")):
            with patch("vision_model.predict", side_effect=error):
                result = self.client.post('/api/vision/infer', json={**body, "request_id": str(uuid4())}).get_json()
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["score"]); self.assertIsNone(result["label"])
        # Bad configuration is a failure, not a fallback invented threshold.
        self.app.config["VISION_GOOD_MAX"] = "wrong"
        result = self.client.post('/api/vision/infer', json={**body, "request_id": str(uuid4())}).get_json()
        self.assertEqual(result["status"], "failed")

    def test_idempotence_and_retention_lease(self):
        image = self.image(); request_id = str(uuid4())
        first = self.infer(image, request_id=request_id).get_json()
        second = self.infer(image, 90., request_id=request_id).get_json()
        self.assertEqual(first, second)
        with self.app.app_context():
            lease = get_db().execute('SELECT retain_until FROM image_records WHERE id=?', (image["id"],)).fetchone()[0]
            self.assertGreater(lease, time.time()+590)

    def test_only_supported_human_labels_and_new_retake(self):
        old = self.infer(self.image()).get_json()
        self.assertEqual(self.client.post('/api/vision/feedback', json={"inference_id": old["inference_id"], "kind": "correction", "corrected_label": "person_safe"}).status_code, 400)
        self.assertEqual(self.client.post('/api/vision/feedback', json={"inference_id": old["inference_id"], "kind": "retake", "new_task_id": old["image_task_id"], "request_id": old["request_id"]}).status_code, 409)

    def test_parser_existing_fresh_missing_and_negated(self):
        devices = [{"device": DEVICE}]
        for text in ("分析刚才拍的图片", "这张图片能用吗？", "分析这张图片"):
            result = interpret(text, {"device": DEVICE}, devices)
            self.assertEqual(result["intent"], "vision_analyze")
            self.assertEqual(result["parameters"]["mode"], "image_existing")
        result = interpret("看看当前画面是否可用", {"device": DEVICE}, devices)
        self.assertEqual(result["parameters"]["mode"], "image_fresh")
        result = interpret("看看当前画面是否可用", {}, devices)
        self.assertEqual(result["status"], "clarify")
        self.assertEqual(interpret("确认", {"device": DEVICE, "pending": result["context"]["pending"]}, devices)["parameters"]["mode"], "image_fresh")
        for text in ("不要分析这张图片", "不分析当前图片", "当前画面不可用", "如果当前画面不可用就拍照", "分析昨天的照片", "分析所有图片", "分析刚才和当前图片"):
            self.assertNotEqual(interpret(text, {"device": DEVICE}, devices)["status"], "ready", text)

    def test_additive_v6_migration_preserves_image(self):
        image = self.image()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DROP TABLE vision_feedback'); db.execute('DROP TABLE vision_inferences'); db.execute('PRAGMA user_version=6')
        from app import create_app
        upgraded = create_app({"TESTING": True, "DATABASE": str(self.path)})
        with upgraded.app_context():
            self.assertEqual(get_db().execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(get_db().execute('SELECT sha256 FROM image_records WHERE id=?', (image["id"],)).fetchone()[0], image["sha256"])


class RealBaselineTests(unittest.TestCase):
    def test_real_degenerate_pixels_reject_and_missing_weights_fail(self):
        # Real model feature computation on a generated uniform JPEG, not hardware.
        raw = vision_model.predict(jpeg("black"))
        self.assertIsNone(raw["score"])
        self.assertEqual(vision_model.decide(raw, 30, 60)[0], "unknown")
        with self.assertRaises(vision_model.ModelUnavailable):
            vision_model.predict(jpeg(), Path('missing-test-model-directory'))


if __name__ == '__main__': unittest.main()
