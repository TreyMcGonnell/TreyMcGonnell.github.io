"""Simulate visitors against the real gateway and rate limiter (test A5, I7), with a stand-in model and a fake clock.

    python scripts/simulate_limits.py            # production limits: 10 per 10 min, 60 per day per visitor, 400 per day
    python scripts/simulate_limits.py --serve --window-max 2   # serve it on :8000 with small limits, for checking the site

Nothing here touches the live server, Supermemory or the GPU.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from api.config import Settings  # noqa: E402
from api.fakes import FakeTokenizer, FakeWorker  # noqa: E402
from api.gateway import create_app  # noqa: E402
from api.ratelimit import MemoryStore, limiter_from_settings  # noqa: E402


class Clock:
    def __init__(self, t: float):
        self.t = t

    def __call__(self) -> float:
        return self.t


def build(settings: Settings, clock=None):
    tok = FakeTokenizer()
    worker = FakeWorker(tok)
    limiter = limiter_from_settings(MemoryStore(), settings, salt="simulation", **({"clock": clock} if clock else {}))
    return create_app(settings=settings, tokenizer=tok, worker=worker, retriever=None, limiter=limiter,
                      bio="Simulation bio.", meta=worker.meta(settings.temperature))


def simulate() -> bool:
    s = Settings()
    clock = Clock(1_796_385_600.0)  # 2026-12-04, mid-day UTC: after the temporary allowance, so the normal limits apply
    app = build(s, clock)
    visitors: dict[str, TestClient] = {}

    def ask(ip: str, headers: dict | None = None):
        if ip not in visitors:
            visitors[ip] = TestClient(app, client=(ip, 50000))
        r = visitors[ip].post("/api/chat", json={"q": "What is Trey studying?"}, headers=headers or {})
        if r.status_code == 200:
            r.read()
        return r

    results, ok = [], True

    def check(name: str, r, expect: int, reason: str | None = None):
        nonlocal ok
        body = r.json() if r.status_code != 200 else {}
        passed = r.status_code == expect and (reason is None or body.get("reason") == reason)
        ok &= passed
        results.append((("PASS" if passed else "FAIL"), name, r.status_code, body.get("message", "(answered)"),
                        r.headers.get("Retry-After", "")))

    a = "203.0.113.10"
    for _ in range(10):
        assert ask(a).status_code == 200
    check("Visitor A asks an 11th question within 10 minutes", ask(a), 429, "window")
    check("Visitor A fakes another address (X-Forwarded-For)", ask(a, {"X-Forwarded-For": "198.51.100.7"}), 429, "window")
    check("Visitor B asks meanwhile (counted separately)", ask("203.0.113.20"), 200)
    clock.t += s.rate_window_s + 1
    check("Visitor A, 10 minutes later", ask(a), 200)

    for _ in range(s.rate_day_max_ip - 11):  # spread out so the 10-minute limit isn't the one that trips
        clock.t += 61
        assert ask(a).status_code == 200
    clock.t += 61
    check(f"Visitor A asks question {s.rate_day_max_ip + 1} today", ask(a), 429, "ip_day")

    used = s.rate_day_max_ip + 1  # visitor A's 60 plus visitor B's 1
    n = 0
    while used < s.rate_day_max_global:
        ip = f"192.0.2.{n // 50}{n % 50:02d}"  # many visitors, 50 questions each at most
        n += 1
        for _ in range(min(9, s.rate_day_max_global - used)):
            assert ask(ip).status_code == 200
            used += 1
        clock.t += 1
    check(f"A new visitor after the site's {s.rate_day_max_global} questions today", ask("203.0.113.99"), 429, "global_day")

    clock.t += 86_400
    check("Visitor A the next day", ask(a), 200)

    # The temporary allowance: a shared campus network before the end of Nov 30 (Eastern), then normal limits again.
    from datetime import datetime

    clock2 = Clock(datetime.fromisoformat("2026-11-25T15:00:00+00:00").timestamp())
    app2 = build(s, clock2)
    campus = TestClient(app2, client=("192.0.2.200", 50000))

    def ask_campus():
        r = campus.post("/api/chat", json={"q": "What is Trey studying?"})
        if r.status_code == 200:
            r.read()
        return r

    answered = 0
    for _ in range(s.promo_window_max):
        answered += ask_campus().status_code == 200
        clock2.t += 30  # a question every 30 seconds from the same network
    check(f"Shared campus network, Nov 25: {answered} questions in under an hour", campus.get("/api/health"), 200)
    ok &= answered == s.promo_window_max
    check(f"Shared campus network, question {s.promo_window_max + 1} within the hour", ask_campus(), 429, "window")
    clock2.t = datetime.fromisoformat(s.promo_until).timestamp() + 3600  # Dec 1, after the cutoff
    for _ in range(s.rate_window_max):
        assert ask_campus().status_code == 200
    check(f"Same network on Dec 1, question {s.rate_window_max + 1} in 10 minutes", ask_campus(), 429, "window")

    width = max(len(r[1]) for r in results)
    for res, name, status, message, retry in results:
        print(f"[{res}] {name:<{width}}  {status}  {('Retry-After ' + retry + ' s  ') if retry else ''}{message}")
    print("all limits behave as expected" if ok else "SOME LIMITS DID NOT BEHAVE AS EXPECTED")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true", help="serve the stand-in gateway on 127.0.0.1:8000")
    ap.add_argument("--window-max", type=int)
    ap.add_argument("--day-max-ip", type=int)
    ap.add_argument("--day-max-global", type=int)
    args = ap.parse_args()
    if not args.serve:
        sys.exit(0 if simulate() else 1)
    import uvicorn

    s = Settings()
    s = replace(s, rate_window_max=args.window_max or s.rate_window_max, rate_day_max_ip=args.day_max_ip or s.rate_day_max_ip,
                rate_day_max_global=args.day_max_global or s.rate_day_max_global)
    print(f"stand-in gateway with limits: {s.rate_window_max} per 10 min, {s.rate_day_max_ip} per day, {s.rate_day_max_global} site-wide")
    uvicorn.run(build(s), host="127.0.0.1", port=8000, log_level="warning")


if __name__ == "__main__":
    main()
