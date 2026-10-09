"""Camera UI state tests use only an isolated DB and synthetic device outcomes."""
import time
import unittest
from test_images import ImageTests, DEVICE
from database import get_db


class CameraUITests(unittest.TestCase):
    setUp = ImageTests.setUp
    online = ImageTests.online
    create = ImageTests.create
    upload = ImageTests.upload

    def camera(self):
        return self.client.get('/api/status').get_json()['camera']

    def test_no_frames_with_successful_capture_is_on_demand(self):
        self.assertEqual(self.camera()['mode'], 'unknown')
        task = self.create(); self.upload(task)
        state = self.camera()
        self.assertEqual(state['mode'], 'on_demand')
        self.assertFalse(state['preview_enabled'])
        self.assertEqual(state['last_capture']['request_id'], task)
        self.assertEqual(self.client.get('/api/devices').get_json()['devices'][0]['camera']['mode'], 'on_demand')

    def test_camera_unavailable_and_single_capture_failure_are_distinct(self):
        for error, expected in [('camera_unavailable', 'camera_unavailable'), ('image_invalid', 'capture_failed'),
                                ('camera_clock_unavailable', 'capture_failed')]:
            task = self.create()
            self.client.post(f'/api/device/task/{task}/status', json={'device': DEVICE, 'status': 'FAILED', 'error': error})
            self.assertEqual(self.camera()['mode'], expected)
        task = self.create(); self.upload(task)
        self.assertEqual(self.camera()['mode'], 'on_demand')

    def test_device_offline_takes_priority_and_cannot_enable_preview(self):
        task = self.create(); self.upload(task)
        with self.app.app_context(), get_db() as db:
            db.execute('UPDATE sensor_data SET received_at = ?', (time.time()-30,))
        self.assertEqual(self.camera()['mode'], 'device_offline')
        self.assertEqual(self.client.post('/api/camera/preview', json={'enabled': True}).status_code, 409)
        self.assertEqual(self.client.post('/api/camera/preview', json={'enabled': False}).status_code, 200)

    def test_preview_switch_rejects_urls_and_non_booleans(self):
        for body in ({'enabled': 'true'}, {'enabled': 1}, {'enabled': True, 'url': 'http://127.0.0.1'}, {}):
            self.assertEqual(self.client.post('/api/camera/preview', json=body).status_code, 400)
        camera = self.app.extensions['camera']
        camera.discover('192.168.1.15')
        self.assertIsNone(camera._thread)  # Discovery while disabled must not start a stream.
        self.assertEqual(camera._url, 'http://192.168.1.15:81/stream')


if __name__ == '__main__': unittest.main()
