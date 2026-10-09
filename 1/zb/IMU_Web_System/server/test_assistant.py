"""Assistant intent tests use an isolated database; parsing must never dispatch."""
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from app import create_app
from assistant import interpret, BEIJING
import database


class AssistantIntentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="imu-assistant-")
        self.addCleanup(self.temp.cleanup)
        self.app = create_app({"TESTING": True, "DATABASE": str(Path(self.temp.name) / "test.db"),
                               "ASSISTANT_DEVICE_ALIASES": {}})
        self.client = self.app.test_client()
        self.device = "ESP32_S3_EYE"

    def parse(self, message, context=None):
        response = self.client.post("/api/assistant/interpret", json={"message": message, "context": context or {}})
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_query_phrases_never_create_tasks(self):
        for phrase in ("查看上次数据", "看看刚才采集的结果", "查询历史数据", "看看刚才的数据"):
            result = self.parse(phrase, {"device": self.device})
            self.assertEqual(result["intent"], "query_existing", phrase)
            self.assertEqual(result["status"], "ready")
        with self.app.app_context():
            self.assertEqual(database.get_db().execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_collection_phrases_are_structured_not_executed_by_parser(self):
        for phrase in ("重新采集一次", "获取最新数据", "现在再采一遍", "现在采集一次"):
            result = self.parse(phrase, {"device": self.device})
            self.assertEqual(result["intent"], "collect_new", phrase)
        with self.app.app_context():
            self.assertEqual(database.get_db().execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_missing_device_even_with_only_one_device_requires_clarification(self):
        result = self.parse("重新采集一次")
        self.assertEqual(result["status"], "clarify")
        self.assertIsNone(result["parameters"])
        self.assertIsNone(result["context"]["device"])
        resolved = self.parse("ESP32-S3-EYE", result["context"])
        self.assertEqual(resolved["intent"], "collect_new")
        self.assertEqual(resolved["parameters"]["device"], self.device)

    def test_explicit_device_replaces_context_and_unknown_is_not_ignored(self):
        self.assertEqual(self.parse("查看设备NOT_FOUND的数据", {"device": self.device})["status"], "invalid")
        self.assertEqual(self.parse("重新采集MISSING-2", {"device": self.device})["status"], "invalid")

    def test_device_numbers_are_only_resolved_by_explicit_configuration(self):
        self.assertEqual(self.parse("重新采集1号设备")["status"], "clarify")
        self.app.config["ASSISTANT_DEVICE_ALIASES"] = {"1号设备": self.device}
        for phrase in ("重新采集1号设备", "查看1号设备之前的数据"):
            result = self.parse(phrase)
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["parameters"]["device"], self.device)

    def test_multiple_devices_do_not_choose_first_or_context(self):
        inventory = [{"device": self.device}, {"device": "DEV2"}]
        result = interpret("重新采集ESP32-S3-EYE和DEV2", {"device": self.device}, inventory)
        self.assertEqual(result["status"], "clarify")
        self.assertIsNone(result["context"]["device"])

    def test_negation_ambiguous_actions_and_help_never_collect(self):
        for phrase in ("不要重新采集", "查看上次数据还是重新采集一次", "怎么重新采集", "连续采集", "明天重新采集一次"):
            result = self.parse(phrase, {"device": self.device})
            self.assertNotEqual(result["status"], "ready", phrase)
        result = self.parse("不要重新采集，查看上次数据", {"device": self.device})
        self.assertEqual(result["intent"], "query_existing")

    def test_unsupported_conditions_do_not_dispatch(self):
        for phrase in ("重新采集温度", "查看1楼设备的数据", "重新采集昨天的数据", "查下午的数据"):
            result = self.parse(phrase, {"device": self.device})
            self.assertEqual(result["status"], "clarify", phrase)

    def test_beijing_range_recent_window_and_history_limit(self):
        now = datetime(2026, 9, 27, 12, 0, tzinfo=BEIJING)
        inventory = [{"device": self.device}]
        result = interpret("查询昨天最近10条数据", {"device": self.device}, inventory, now=now)
        self.assertEqual(result["parameters"]["start"], "2026-09-26 00:00:00")
        self.assertEqual(result["parameters"]["end"], "2026-09-26 23:59:59.999999")
        self.assertEqual(result["parameters"]["limit"], 10)
        result = interpret("查询最近10分钟的数据", {"device": self.device}, inventory, now=now)
        self.assertEqual(result["parameters"]["start"], "2026-09-27 11:50:00")
        for phrase in ("查询2026-09-29到2026-09-20数据", "查询2026-02-31数据", "查询最近101条数据"):
            self.assertEqual(self.parse(phrase, {"device": self.device})["status"], "clarify")

    def test_history_filters_survive_missing_device_clarification(self):
        result = self.parse("查询2026-09-24的历史数据")
        resolved = self.parse("ESP32-S3-EYE", result["context"])
        self.assertEqual(resolved["parameters"]["start"], "2026-09-24 00:00:00")
        self.assertEqual(resolved["parameters"]["mode"], "history")

    def test_inventory_failure_is_real_http_error_not_normal_result(self):
        import sqlite3
        with patch("database.get_db", side_effect=sqlite3.OperationalError("isolated fixture")), self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.post("/api/assistant/interpret", json={"message": "重新采集一次"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("error", response.get_json())

    def test_invalid_bodies_and_context_are_rejected(self):
        for body in ([], {"message": ""}, {"message": "x" * 501}, {"message": "查看上次数据", "context": {"device": []}},
                     {"message": "确认", "context": {"pending": {"intent": "collect_new"}}}):
            self.assertEqual(self.client.post("/api/assistant/interpret", json=body).status_code, 400)

    def test_pending_collection_is_not_executed_by_unrelated_reply(self):
        pending = self.parse("重新采集一次")["context"]
        pending["device"] = self.device
        self.assertEqual(self.parse("你好", pending)["status"], "clarify")
        self.assertEqual(self.parse("确认", pending)["intent"], "collect_new")

    def test_alias_clarification_preserves_date_and_mode(self):
        pending = self.parse("查看1号设备2026-09-24的历史数据")["context"]
        resolved = self.parse("ESP32-S3-EYE", pending)
        self.assertEqual(resolved["parameters"]["mode"], "history")
        self.assertEqual(resolved["parameters"]["start"], "2026-09-24 00:00:00")

    def test_date_clarification_and_open_ended_range(self):
        pending = self.parse("查询下午的数据", {"device": self.device})["context"]
        resolved = self.parse("2026-09-24", pending)
        self.assertEqual(resolved["status"], "ready")
        self.assertEqual(resolved["parameters"]["mode"], "history")
        params = self.parse("查询2026-09-24之前的数据", {"device": self.device})["parameters"]
        self.assertEqual(params["start"], "")
        self.assertEqual(params["end"], "2026-09-24 23:59:59.999999")

    def test_sensor_model_is_not_misread_as_a_device(self):
        self.assertEqual(self.parse("查询QMA6100P数据", {"device": self.device})["status"], "ready")
        self.assertEqual(self.parse("重新采集两次", {"device": self.device})["status"], "clarify")

    def test_negated_conditional_and_reported_actions_are_not_authorization(self):
        for phrase in ("不重新采集", "如果设备在线就重新采集一次", "是否重新采集一次", "已经重新采集一次", "禁止重新采集", "还没重新采集"):
            self.assertEqual(self.parse(phrase, {"device": self.device})["status"], "clarify", phrase)
        self.assertEqual(self.parse("不重新采集，查看上次数据", {"device": self.device})["intent"], "query_existing")
        pending = self.parse("重新采集一次")["context"]
        self.assertEqual(self.parse("不重新采集，ESP32-S3-EYE", pending)["status"], "clarify")

    def test_time_qualifiers_are_not_silently_dropped(self):
        for phrase in ("查询今天下午的数据", "查询2026-09-24上午的数据", "查询最近一小时数据"):
            self.assertEqual(self.parse(phrase, {"device": self.device})["status"], "clarify", phrase)


if __name__ == "__main__":
    unittest.main()
