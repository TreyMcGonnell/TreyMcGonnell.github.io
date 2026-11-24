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
    limit: int = 0  # the limit that was reached, for the visitor-facing message
    window_s: int = 0


@dataclass(frozen=True)
class Promo:
    """A temporary, more generous allowance per address that ends on its own at `until` (Unix time)."""
    until: float
    window_s: int
    window_max: int
    day_max_ip: int
    warm_per_minute: int


class RateLimiter:
    def __init__(self, store: Store, *, salt: str, window_s: int, window_max: int, day_max_ip: int,
                 day_max_global: int, warm_per_minute: int, clock: Callable[[], float] = time.time,
                 promo: Promo | None = None):
        self.store, self.salt, self.clock = store, salt, clock
        self.window_s, self.window_max = window_s, window_max
        self.day_max_ip, self.day_max_global, self.warm_per_minute = day_max_ip, day_max_global, warm_per_minute
        self.promo = promo
        self._lock = threading.Lock()

    def limits(self, now: float) -> tuple[int, int, int, int]:
        """(window_s, window_max, day_max_ip, warm_per_minute) in force at `now`. The site-wide daily cap never changes."""
        p = self.promo
        if p and now < p.until:
            return p.window_s, p.window_max, p.day_max_ip, p.warm_per_minute
        return self.window_s, self.window_max, self.day_max_ip, self.warm_per_minute

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
            window_s, window_max, day_max_ip, _ = self.limits(now)
            k, day = self.key(ip, now), self._day(now)
            recent = [t for t in self.store.get(f"w:{k}", []) if now - t < window_s]
            if len(recent) >= window_max:
                return Decision(False, int(window_s - (now - recent[0])) + 1, "window", window_max, window_s)
            ip_day = self.store.get(f"d:{k}", 0)
            if ip_day >= day_max_ip:
                return Decision(False, self._until_tomorrow(now), "ip_day", day_max_ip)
            glob = self.store.get(f"g:{day}", 0)
            if glob >= self.day_max_global:
                return Decision(False, self._until_tomorrow(now), "global_day", self.day_max_global)
            recent.append(now)
            self.store.put(f"w:{k}", recent)
            self.store.put(f"d:{k}", ip_day + 1)
            self.store.put(f"g:{day}", glob + 1)
            return Decision(True)

    def check_warm(self, ip: str) -> Decision:
        with self._lock:
            now = self.clock()
            warm_per_minute = self.limits(now)[3]
            k = self.key(ip, now)
            recent = [t for t in self.store.get(f"warm:{k}", []) if now - t < 60]
            if len(recent) >= warm_per_minute:
                return Decision(False, int(60 - (now - recent[0])) + 1, "warm")
            recent.append(now)
            self.store.put(f"warm:{k}", recent)
            return Decision(True)


def limiter_from_settings(store: Store, settings, *, salt: str | None = None, clock: Callable[[], float] = time.time) -> RateLimiter:
    """The limiter every server uses, including any temporary allowance that is still running."""
    from datetime import datetime

    promo = None
    if settings.promo_until:
        promo = Promo(until=datetime.fromisoformat(settings.promo_until).timestamp(), window_s=settings.promo_window_s,
                      window_max=settings.promo_window_max, day_max_ip=settings.promo_day_max_ip,
                      warm_per_minute=settings.promo_warm_per_minute)
    return RateLimiter(store, salt=salt or settings.log_salt, window_s=settings.rate_window_s, window_max=settings.rate_window_max,
                       day_max_ip=settings.rate_day_max_ip, day_max_global=settings.rate_day_max_global,
                       warm_per_minute=settings.warm_per_minute, clock=clock, promo=promo)
