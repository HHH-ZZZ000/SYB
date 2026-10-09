"""Platform queries use temporary databases; no production samples are written."""
import csv
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app import create_app


class PlatformRecordsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='imu-platform-')
        self.addCleanup(self.temp.cleanup)
        self.app = create_app({'TESTING': True, 'DATABASE': str(Path(self.temp.name)/'test.db')})
        self.client = self.app.test_client()
        self.sample = {'device': 'ESP32_S3_EYE', 'sensor': 'QMA6100P', 'acc_x': .1, 'acc_y': -.2, 'acc_z': .95, 'timestamp': '2026-09-26 08:00:00'}
        for offset in range(45):
            with patch('app.time.time', return_value=1790380800 + offset):
                self.assertEqual(self.client.post('/api/upload', json=self.sample).status_code, 201)

    def test_legacy_history_keeps_ascending_cursor_contract(self):
        page = self.client.get('/api/history?limit=3&after_id=2').get_json()
        self.assertEqual([s['id'] for s in page['samples']], [3, 4, 5])
        self.assertTrue(page['has_more'])

    def test_pagination_and_both_sort_orders(self):
        result = self.client.get('/api/records?page=2&page_size=20').get_json()
        self.assertEqual(result['total'], 45)
        self.assertEqual([r['id'] for r in result['samples']], list(range(25, 5, -1)))
        result = self.client.get('/api/records?order=asc&page_size=3').get_json()
        self.assertEqual([r['id'] for r in result['samples']], [1, 2, 3])

    def test_beijing_time_filters_are_inclusive(self):
        from datetime import datetime, timedelta, timezone
        base = datetime.fromtimestamp(1790380800, timezone(timedelta(hours=8)))
        query = {'start': (base+timedelta(seconds=4)).isoformat()[:19], 'end': (base+timedelta(seconds=6)).isoformat()[:19], 'order':'asc'}
        result = self.client.get('/api/records', query_string=query).get_json()
        self.assertEqual([r['id'] for r in result['samples']], [5, 6, 7])
        export = self.client.get('/api/records/export', query_string=query)
        rows = list(csv.reader(io.StringIO(export.data.decode('utf-8-sig'))))
        self.assertEqual([int(row[0]) for row in rows[1:]], [5, 6, 7])

    def test_export_includes_all_pages_and_no_mock_fields(self):
        response = self.client.get('/api/records/export?order=asc')
        self.assertIn('attachment', response.headers['Content-Disposition'])
        self.assertTrue(response.data.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.reader(io.StringIO(response.data.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 46)
        self.assertEqual(rows[1][5:], ['0.1', '-0.2', '0.95'])
        self.assertEqual(rows[-1][0], '45')

    def test_devices_and_queries_are_isolated(self):
        self.client.post('/api/upload', json={**self.sample, 'device':'SECOND_BOARD'})
        devices = self.client.get('/api/devices').get_json()['devices']
        self.assertEqual({d['device']:d['total_samples'] for d in devices}, {'ESP32_S3_EYE':45,'SECOND_BOARD':1})
        self.assertEqual(devices[1]['camera']['status'], 'offline')
        rows = self.client.get('/api/records?device=SECOND_BOARD').get_json()
        self.assertEqual(rows['total'], 1)

    def test_invalid_filters_are_rejected(self):
        for query in ['page=0','page=-1','page_size=101','order=drop','start=2026-99-99','start=2026-09-27T00:00&end=2026-09-26T00:00','start=2026-09-26T00:00Z','device=%27%20OR%201=1']:
            with self.subTest(query=query):
                self.assertEqual(self.client.get('/api/records?'+query).status_code, 400)

    def test_empty_filter_and_out_of_range_page(self):
        self.assertEqual(self.client.get('/api/records?start=2099-01-01T00:00').get_json()['total'], 0)
        self.assertEqual(self.client.get('/api/records?page=100').get_json()['samples'], [])

    def test_csv_neutralizes_formula_device_names(self):
        self.client.post('/api/upload', json={**self.sample, 'device':'-board'})
        response = self.client.get('/api/records/export?device=-board')
        rows = list(csv.reader(io.StringIO(response.data.decode('utf-8-sig'))))
        self.assertEqual(rows[1][1], "'-board")

    def test_modules_are_served_without_build_step(self):
        index = self.client.get('/').text
        self.assertIn('type="module"', index)
        for path in ['app.js','router.js','pages/Dashboard.js','pages/DeviceMonitor.js','pages/RealTimeData.js','pages/HistoryData.js','pages/CameraManage.js','pages/Settings.js','vendor/echarts.min.js']:
            response = self.client.get('/static/'+path)
            self.assertEqual(response.status_code, 200, path)
            response.close()
