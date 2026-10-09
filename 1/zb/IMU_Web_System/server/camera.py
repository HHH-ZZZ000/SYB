"""One real MJPEG upstream, one bounded latest-frame cache, no database writes."""

import ipaddress
from io import BytesIO
from http.client import HTTPException
import threading
import time
from collections import deque
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from PIL import Image

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
))
BOUNDARY = b"imu-camera-frame"
MAX_FRAME_BYTES = 256 * 1024


def private_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ValueError, TypeError):
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


def validate_camera_url(value, allow_loopback=False):
    parts = urlsplit(value)
    try:
        address = ipaddress.IPv4Address(parts.hostname or "")
        port = parts.port or 80
    except ValueError:
        raise ValueError("Camera URL must use a private IPv4 address.") from None
    valid_host = private_ipv4(str(address)) or (allow_loopback and address.is_loopback)
    if (parts.scheme != "http" or not valid_host or not 1 <= port <= 65535
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or not parts.path.startswith("/")):
        raise ValueError("Camera URL must be a plain HTTP URL on a trusted LAN IPv4 address.")
    return value


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def jpeg_frames(stream, max_bytes=MAX_FRAME_BYTES):
    """Read fragmented multipart data with strictly bounded frame/preamble sizes.

    The ESP camera emits JPEG directly. SOI/EOI framing is independent of its
    multipart boundary string or Content-Length header. Garbage/oversize frames
    terminate this connection instead of allowing an unbounded buffer.
    """
    buffer = bytearray()
    skipped = 0
    in_frame = False
    read = getattr(stream, "read1", stream.read)
    while True:
        chunk = read(8192)
        if not chunk:
            raise EOFError("Camera stream ended.")
        buffer.extend(chunk)
        while True:
            if not in_frame:
                start = buffer.find(b"\xff\xd8")
                if start < 0:
                    skipped += max(0, len(buffer) - 1)
                    del buffer[:-1]
                    if skipped > 65536:
                        raise ValueError("Camera stream has no JPEG start marker.")
                    break
                skipped += start
                if skipped > 65536:
                    raise ValueError("Camera stream preamble is too large.")
                del buffer[:start]
                in_frame = True
            end = buffer.find(b"\xff\xd9", 2)
            if end < 0:
                if len(buffer) > max_bytes:
                    raise ValueError("Camera JPEG exceeds the bounded frame size.")
                break
            if end + 2 > max_bytes:
                raise ValueError("Camera JPEG exceeds the bounded frame size.")
            frame = bytes(buffer[:end + 2])
            del buffer[:end + 2]
            in_frame = False
            skipped = 0
            # A truncated image containing a new SOI is not a valid whole frame.
            if len(frame) < 4 or b"\xff\xd8" in frame[2:]:
                raise ValueError("Camera sent an invalid JPEG frame.")
            yield frame


class CameraStream:
    def __init__(self, *, enabled=True, url=None, allow_loopback=False,
                 timeout=2.0, retry_seconds=2.0, stale_seconds=3.0, max_clients=8):
        self.enabled = enabled
        self._configured = bool(url)
        self._allow_loopback = allow_loopback
        self._url = validate_camera_url(url, allow_loopback) if url else None
        self._timeout = timeout
        self._retry_seconds = retry_seconds
        self._stale_seconds = stale_seconds
        self._max_clients = max_clients
        self._condition = threading.Condition()
        self._switch_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._frame = None
        self._sequence = 0
        self._last_frame_at = None
        self._last_frame_mono = None
        self._times = deque(maxlen=60)
        self._healthy = False
        self._connecting = False
        self._clients = 0
        self._generation = 0
        self._size = (None, None)
        self._http = build_opener(ProxyHandler({}), NoRedirect())

    def discover(self, address):
        if self._configured or not private_ipv4(address):
            return
        with self._condition:
            url = f"http://{address}:81/stream"
            if url != self._url:
                self._url = url
                self._frame = None
                self._last_frame_at = None
                self._last_frame_mono = None
                self._times.clear()
                self._healthy = False
        self.start()

    def set_enabled(self, enabled):
        """Explicit preview switch; disabling closes the device connection too."""
        with self._switch_lock:
            if enabled == self.enabled:
                return
            self.enabled = False
            self._generation += 1
            self.stop()
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("Previous preview connection is still closing.")
            with self._condition:
                self._thread = None
                self._frame = self._last_frame_at = self._last_frame_mono = None
                self._times.clear()
                self._size = (None, None)
                self._connecting = False
                self._stop.clear()
                self.enabled = enabled
            self.start()

    def start(self):
        with self._condition:
            if not self.enabled or not self._url or self._stop.is_set():
                return
            if self._thread is None:
                self._connecting = True
                self._thread = threading.Thread(target=self._run, name="imu-camera-upstream", daemon=True)
                self._thread.start()

    def stop(self):
        self._stop.set()
        with self._condition:
            self._healthy = False
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=self._timeout + self._retry_seconds + 1)

    def _run(self):
        while not self._stop.is_set():
            with self._condition:
                url = self._url
                self._connecting = self._last_frame_at is None
            try:
                req = Request(url, headers={"Accept": "multipart/x-mixed-replace"})
                with self._http.open(req, timeout=self._timeout) as response:
                    if response.status != 200 or response.headers.get_content_type() != "multipart/x-mixed-replace":
                        raise ValueError("Camera did not return an MJPEG stream.")
                    for frame in jpeg_frames(response):
                        with Image.open(BytesIO(frame)) as decoded:
                            if decoded.format != "JPEG":
                                raise ValueError("Invalid preview frame.")
                            decoded.load()
                            size = decoded.size
                        with self._condition:
                            if self._stop.is_set() or url != self._url:
                                break
                            self._frame = frame
                            self._size = size
                            self._sequence += 1
                            self._last_frame_at = time.time()
                            self._last_frame_mono = time.monotonic()
                            self._times.append(self._last_frame_mono)
                            self._healthy = True
                            self._connecting = False
                            self._condition.notify_all()
            except (OSError, ValueError, EOFError, HTTPException):
                # Retrying the independent camera task never changes sensor state.
                pass
            finally:
                with self._condition:
                    self._healthy = False
                    self._connecting = False
                    self._condition.notify_all()
            self._stop.wait(self._retry_seconds)

    def status(self):
        self.start()
        with self._condition:
            age = None if self._last_frame_mono is None else max(0, time.monotonic() - self._last_frame_mono)
            online = self._healthy and age is not None and age <= self._stale_seconds
            span = self._times[-1] - self._times[0] if len(self._times) > 1 else 0
            return {
                "status": "online" if online else "connecting" if self._connecting else "offline",
                "preview_enabled": self.enabled,
                "preview_available": True,
                "fps": round((len(self._times) - 1) / span, 1) if online and span > 0 else None,
                "last_frame_at_ms": round(self._last_frame_at * 1000) if self._last_frame_at else None,
                "frame_age_ms": round(age * 1000) if age is not None else None,
                "width": self._size[0], "height": self._size[1],
            }

    def subscribe(self):
        if self.status()["status"] != "online":
            return None
        with self._condition:
            if self._clients >= self._max_clients:
                return None
            self._clients += 1
            return CameraViewer(self)


class CameraViewer:
    """A slow browser skips old video frames instead of building a backlog."""
    def __init__(self, camera):
        self.camera = camera
        self.generation = camera._generation
        self.sequence = -1
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        camera = self.camera
        with camera._condition:
            while not self.closed:
                age = None if camera._last_frame_mono is None else time.monotonic() - camera._last_frame_mono
                if (self.generation != camera._generation or camera._stop.is_set() or not camera._healthy or age is None
                        or age > camera._stale_seconds):
                    self.close()
                    break
                if self.sequence != camera._sequence:
                    frame = camera._frame
                    self.sequence = camera._sequence
                    timestamp = round(camera._last_frame_at * 1000)
                    return (b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + str(len(frame)).encode("ascii") + b"\r\nX-Frame-Time-Ms: "
                            + str(timestamp).encode("ascii") + b"\r\n\r\n" + frame + b"\r\n")
                camera._condition.wait(timeout=min(1, camera._stale_seconds))
        raise StopIteration

    def close(self):
        with self.camera._condition:
            if not self.closed:
                self.closed = True
                self.camera._clients -= 1
                self.camera._condition.notify_all()
