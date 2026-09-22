"""Per-application, bounded delivery of committed sensor samples."""

import queue
import threading


class Subscriber:
    def __init__(self, device, capacity):
        self.device = device
        self.messages = queue.Queue(maxsize=capacity)
        self.overrun = threading.Event()


class TelemetryHub:
    def __init__(self, capacity=64, max_clients=16):
        self.capacity = capacity
        self.max_clients = max_clients
        self._lock = threading.Lock()
        self._subscribers = set()

    def subscribe(self, device):
        with self._lock:
            if len(self._subscribers) >= self.max_clients:
                return None
            subscriber = Subscriber(device, self.capacity)
            self._subscribers.add(subscriber)
            return subscriber

    def unsubscribe(self, subscriber):
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, message):
        # No socket operation or waiting here: a slow viewer cannot delay HTTP
        # ingestion. An overrun forces reconnect + history cursor recovery.
        with self._lock:
            for subscriber in self._subscribers:
                if subscriber.device != message["sample"]["device"] or subscriber.overrun.is_set():
                    continue
                try:
                    subscriber.messages.put_nowait(message)
                except queue.Full:
                    subscriber.overrun.set()
