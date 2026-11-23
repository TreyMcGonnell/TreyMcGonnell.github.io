"""Per-IP and site-wide limits. IPs are never stored: keys are salted hashes, and the salt changes daily."""
from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class Store(Protocol):
    def get(self, key: str, default=None): ...
    def put(self, key: str, value) -> None: ...


class MemoryStore:
    def __init__(self):
        self._d: dict = {}

    def get(self, key, default=None):
        return self._d.get(key, default)

    def put(self, key, value):
        self._d[key] = value


@dataclass
class Decision:
    ok: bool
    retry_after: int = 0
    reason: str = ""


class RateLimiter:
    def __init__(self, store: Store, *, salt: str, window_s: int, window_max: int, day_max_ip: int,
                 day_max_global: int, warm_per_minute: int, clock: Callable[[], float] = time.time):
        self.store, self.salt, self.clock = store, salt, clock
        self.window_s, self.window_max = window_s, window_max
        self.day_max_ip, self.day_max_global, self.warm_per_minute = day_max_ip, day_max_global, warm_per_minute
        self._lock = threading.Lock()

    def _day(self, now: float) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(now))

    def key(self, ip: str, now: float | None = None) -> str:
        now = self.clock() if now is None else now
        return hashlib.sha256(f"{self.salt}|{self._day(now)}|{ip}".encode()).hexdigest()[:32]

    def _until_tomorrow(self, now: float) -> int:
        return int(86400 - (now % 86400)) + 1

    def check_chat(self, ip: str) -> Decision:
        with self._lock:
            now = self.clock()
            k, day = self.key(ip, now), self._day(now)
            recent = [t for t in self.store.get(f"w:{k}", []) if now - t < self.window_s]
            if len(recent) >= self.window_max:
                return Decision(False, int(self.window_s - (now - recent[0])) + 1, "window")
            ip_day = self.store.get(f"d:{k}", 0)
            if ip_day >= self.day_max_ip:
                return Decision(False, self._until_tomorrow(now), "ip_day")
            glob = self.store.get(f"g:{day}", 0)
            if glob >= self.day_max_global:
                return Decision(False, self._until_tomorrow(now), "global_day")
            recent.append(now)
            self.store.put(f"w:{k}", recent)
            self.store.put(f"d:{k}", ip_day + 1)
            self.store.put(f"g:{day}", glob + 1)
            return Decision(True)

    def check_warm(self, ip: str) -> Decision:
        with self._lock:
            now = self.clock()
            k = self.key(ip, now)
            recent = [t for t in self.store.get(f"warm:{k}", []) if now - t < 60]
            if len(recent) >= self.warm_per_minute:
                return Decision(False, int(60 - (now - recent[0])) + 1, "warm")
            recent.append(now)
            self.store.put(f"warm:{k}", recent)
            return Decision(True)
