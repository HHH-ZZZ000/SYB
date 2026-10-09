"""Only the Web entry may canonicalize same-machine HTTP access."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import socket

from app import create_app


class WebEntryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.app = create_app({"TESTING": True, "DATABASE": str(Path(temp.name) / "test.db")})
        self.client = self.app.test_client()
        local = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.3.15", 0))]
        self.addresses = patch("app.socket.getaddrinfo", return_value=local)
        self.addresses.start()
        self.addCleanup(self.addresses.stop)

    def get(self, path="/", peer="192.168.3.15", base="http://192.168.3.15:5000", headers=None):
        response = self.client.get(path, base_url=base, environ_overrides={"REMOTE_ADDR": peer}, headers=headers)
        self.addCleanup(response.close)
        return response

    def test_local_lan_entry_redirects_same_port_and_query_without_cache(self):
        response = self.get("/?view=normal")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "http://localhost:5000/?view=normal")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_canonical_and_https_entries_do_not_loop(self):
        for base in ("http://localhost:5000", "http://127.0.0.1:5000", "https://monitor.example:5443"):
            self.assertEqual(self.get(base=base).status_code, 200)

    def test_remote_clients_are_never_sent_to_their_own_localhost(self):
        self.assertEqual(self.get(peer="192.168.3.14").status_code, 200)

    def test_proxy_headers_do_not_allow_local_misclassification(self):
        for headers in ({"Forwarded": "for=192.168.3.14"}, {"X-Forwarded-For": "192.168.3.14"}, {"X-Forwarded-Proto": "https"}):
            self.assertEqual(self.get(peer="127.0.0.1", headers=headers).status_code, 200)

    def test_address_lookup_failure_does_not_break_web(self):
        with patch("app.socket.getaddrinfo", side_effect=OSError("unavailable")):
            self.assertEqual(self.get().status_code, 200)

    def test_device_api_and_assets_never_redirect(self):
        for path in ("/api/time", "/api/devices", "/static/assistant.css"):
            self.assertEqual(self.get(path).status_code, 200)


if __name__ == "__main__":
    unittest.main()
