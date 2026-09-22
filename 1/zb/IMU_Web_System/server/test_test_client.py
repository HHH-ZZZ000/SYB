"""Isolation and actual HTTP checks for the opt-in synthetic test tool."""

import argparse
import contextlib
import io
import os
import socket
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_client import IsolatedTestServer, make_sample, parse_port, verify_rejections


class TestToolIsolationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="imu-client-tests-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        qa_patch = patch("test_client.QA_ROOT", self.root / "isolated")
        qa_patch.start()
        self.addCleanup(qa_patch.stop)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]

    def start_server(self):
        server = IsolatedTestServer(self.port)
        self.addCleanup(server.stop)
        server.start()
        return server

    def test_production_port_and_unowned_requests_are_refused(self):
        for value in ["5000", "0", "80", "65536", "http://127.0.0.1:5000"]:
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                parse_port(value)
        with self.assertRaises(RuntimeError):
            IsolatedTestServer(self.port).request("/api/upload", make_sample(0))

    def test_inherited_production_database_is_never_written(self):
        production = self.root / "production-sentinel.db"
        db = sqlite3.connect(production)
        db.execute("CREATE TABLE sentinel (value TEXT)")
        db.execute("INSERT INTO sentinel VALUES ('must remain unchanged')")
        db.commit()
        db.close()
        original = production.read_bytes()
        with patch.dict(os.environ, {"IMU_DATABASE": str(production)}):
            server = self.start_server()
            self.assertEqual(server.request("/api/upload", make_sample(0), expected=201)["id"], 1)
            self.assertEqual(server.request("/api/latest")["total_samples"], 1)
        self.assertEqual(production.read_bytes(), original)
        self.assertNotEqual(server.database.resolve(), production.resolve())

    def test_test_page_is_marked_and_rejections_do_not_create_rows(self):
        server = self.start_server()
        with server.http.open(server.base_url, timeout=5) as response:
            page = response.read().decode()
            self.assertEqual(response.headers["X-IMU-Test-Run"], server.token)
            self.assertIn("[测试数据]", page)
            self.assertIn("隔离测试工具 / 模拟数据", page)
        verify_rejections(server)
        self.assertEqual(server.request("/api/latest")["total_samples"], 0)

    def test_occupied_port_is_not_reused_as_upload_destination(self):
        server = self.start_server()
        second = IsolatedTestServer(self.port)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(RuntimeError):
            second.start()
        self.assertIsNone(second.server)
        self.assertEqual(server.request("/api/latest")["total_samples"], 0)

    def test_real_http_history_and_restart_use_same_isolated_database(self):
        server = self.start_server()
        for index in range(3):
            server.request("/api/upload", make_sample(index), expected=201)
        rows = server.request("/api/history")["samples"]
        self.assertEqual([row["id"] for row in rows], [1, 2, 3])
        server.stop()
        server.start()
        self.assertEqual(server.request("/api/latest")["total_samples"], 3)
        self.assertEqual(server.request("/api/history")["samples"], rows)

    def test_redirects_and_foreign_server_markers_are_refused(self):
        server = self.start_server()

        @server.app.get("/api/redirect-test")
        def redirect_test():
            return "", 302, {"Location": "/api/should-not-be-reached"}

        visited = []

        @server.app.get("/api/should-not-be-reached")
        def destination():
            visited.append(True)
            return {"ok": True}

        with self.assertRaises(RuntimeError):
            server.request("/api/redirect-test")
        self.assertEqual(visited, [])
        with patch.object(server, "token", "wrong-instance"):
            # Replace the actual response marker to emulate an unrelated service.
            with patch.object(server.app, "after_request_funcs", {None: [lambda response: response]}):
                with self.assertRaises(RuntimeError):
                    server.request("/api/latest")


if __name__ == "__main__":
    unittest.main()
