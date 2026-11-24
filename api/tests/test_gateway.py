"""Backend launch tests that need no model: A1, A2, A5-A8, B1 (gateway frames), I5, I7, J1, J2, J4, J5."""
import threading
import time

import jsonschema
import pytest
from fastapi.testclient import TestClient

from api.config import Settings
from api.fakes import FakeTokenizer, FakeWorker
from api.memory import Passage, retrieve
from api.prompt import build_prompt
from api.ratelimit import MemoryStore, RateLimiter

from .conftest import BIO, SCHEMA, parse_sse


def ask(client, q="What has Trey built?", **kw):
    r = client.post("/api/chat", json={"q": q}, **kw)
    return r, (parse_sse(r.text) if r.status_code == 200 else [])


# ---------------- A1: prompt builder ----------------
def test_a1_sections_in_order_and_offsets_cover_every_token():
    tok = FakeTokenizer()
    notes = [Passage("projects/a.md", "A", "Trey built thing A.", 0.9), Passage("notes/b.md", "B", "Trey likes B.", 0.5)]
    b = build_prompt(tok, BIO, notes, "What has Trey built?")
    kinds = [s.kind for s in b.sections]
    assert kinds == ["rules", "bio", "note", "note", "question"]
    assert sum(s.tokens for s in b.sections) == b.total == len(b.positions_src)
    for s in b.sections:
        positions = [i for i, src in enumerate(b.positions_src) if src == s.source]
        assert len(positions) == s.tokens and positions[0] == s.start
    assert b.total <= 2048


def test_a1_prompt_never_exceeds_budget():
    tok = FakeTokenizer()
    huge = " ".join(f"word{i}" for i in range(5000))
    notes = [Passage(f"notes/n{i}.md", "N", huge, 0.9 - i * 0.1) for i in range(3)]
    b = build_prompt(tok, huge, notes, "What has Trey built?", limit=2048)
    assert b.total <= 2048
    assert b.positions_src[-1] == "rules" and "question" in b.positions_src


# ---------------- A2: retrieval ----------------
class SlowRetriever:
    def search(self, q, limit):
        time.sleep(1.0)
        return [Passage("notes/x.md", "X", "x", 0.9)]


class FixedRetriever:
    def search(self, q, limit):
        return [Passage(f"notes/{i}.md", str(i), "text", s) for i, s in enumerate([0.9, 0.8, 0.7, 0.6, 0.05])][:limit]


def test_a2_only_top_three_above_threshold_are_used():
    r = retrieve(FixedRetriever(), "q", limit=4, use=3, threshold=0.5, timeout_s=1.0)
    assert [p.file for p in r.used] == ["notes/0.md", "notes/1.md", "notes/2.md"]
    assert [x["used"] for x in r.results] == [True, True, True, False]


def test_a2_timeout_falls_back_to_bio_and_reports_error():
    r = retrieve(SlowRetriever(), "q", limit=4, use=3, threshold=0.1, timeout_s=0.2)
    assert r.used == [] and r.error == "Couldn't reach Trey's notes"


# ---------------- B1: every streamed event matches the schema ----------------
def test_b1_stream_validates_against_schema(make_app):
    app, _ = make_app()
    with TestClient(app) as c:
        r, events = ask(c)
    assert r.status_code == 200
    names = [e for e, _ in events]
    assert names[0] == "meta" and "retrieval" in names and "prompt" in names and "token" in names and "done" in names
    for ev, data in events:
        jsonschema.validate({"event": ev, "data": data}, SCHEMA)


def test_retrieval_highlights_and_notes_enter_the_prompt(make_app):
    app, _ = make_app()
    with TestClient(app) as c:
        _, events = ask(c, "What scam detection tool did Trey build?")
    retrieval = dict(events)["retrieval"]
    top = retrieval["results"][0]
    assert top["file"] == "projects/sample-detector.md" and top["used"] and top["highlights"]
    prompt = dict(events)["prompt"]
    assert any(s["source"] == "note:projects/sample-detector.md" for s in prompt["sections"])


# ---------------- A5: rate limits ----------------
def test_a5_eleventh_question_in_ten_minutes_is_refused(make_app, clock):
    app, _ = make_app()
    with TestClient(app) as c:
        for _ in range(10):
            assert ask(c)[0].status_code == 200
        r, _ = ask(c)
        assert r.status_code == 429 and r.json()["code"] == "rate_limited" and r.json()["retry_after"] > 0
        assert r.json()["reason"] == "window" and "10 questions in the last 10 minutes" in r.json()["message"]
        assert r.headers["Retry-After"] == str(r.json()["retry_after"])
        clock.t += 601
        assert ask(c)[0].status_code == 200


def test_a5_ips_are_counted_separately_and_daily_caps_hold(clock):
    lim = RateLimiter(MemoryStore(), salt="s", window_s=600, window_max=100, day_max_ip=3, day_max_global=5,
                      warm_per_minute=6, clock=clock)
    assert all(lim.check_chat("1.1.1.1").ok for _ in range(3))
    assert not lim.check_chat("1.1.1.1").ok  # per-IP daily cap
    assert lim.check_chat("2.2.2.2").ok and lim.check_chat("2.2.2.2").ok
    assert not lim.check_chat("3.3.3.3").ok  # site-wide daily cap (5) reached


def test_warm_is_limited_to_six_per_minute(make_app):
    app, _ = make_app()
    with TestClient(app) as c:
        codes = [c.post("/api/warm").status_code for _ in range(7)]
    assert codes == [200] * 6 + [429]


# ---------------- A6: input checks ----------------
@pytest.mark.parametrize("payload", [{"q": ""}, {"q": "   "}, {"q": "x" * 301}, {"q": 42}, {"x": "y"}, ["q"]])
def test_a6_bad_input_is_400(make_app, payload):
    app, _ = make_app()
    with TestClient(app) as c:
        r = c.post("/api/chat", json=payload)
    assert r.status_code == 400 and r.json()["code"] == "bad_input"


def test_a6_control_characters_are_stripped(make_app, tmp_path):
    app, _ = make_app()
    with TestClient(app) as c:
        r, events = ask(c, "What\x00 has\x1b Trey built?")
    assert r.status_code == 200
    prompt = dict(events)["prompt"]
    question = next(s for s in prompt["sections"] if s["kind"] == "question")
    assert "\x00" not in "".join(question["sample"]) and "\x1b" not in "".join(question["sample"])


# ---------------- A7: CORS ----------------
@pytest.mark.parametrize("origin,allowed", [("https://treymcgonnell.github.io", True), ("http://localhost:5173", True),
                                            ("https://evil.example", False), ("http://localhost:4173", False)])
def test_a7_cors_only_for_the_site(make_app, origin, allowed):
    app, _ = make_app()
    with TestClient(app) as c:
        pre = c.options("/api/chat", headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "content-type"})
        get = c.get("/api/health", headers={"Origin": origin})
    assert (pre.headers.get("access-control-allow-origin") == origin) is allowed
    assert (get.headers.get("access-control-allow-origin") == origin) is allowed


# ---------------- A8 / J4: kill switch ----------------
def test_a8_j4_kill_switch_turns_chat_off_without_a_deploy(make_app):
    flag = {"on": True}
    app, _ = make_app(chat_enabled=lambda: flag["on"])
    with TestClient(app) as c:
        assert ask(c)[0].status_code == 200
        flag["on"] = False
        r, _ = ask(c)
        assert r.status_code == 503 and r.json()["code"] == "chat_disabled"
        assert c.get("/api/health").json()["chat_enabled"] is False


# ---------------- I5: logs ----------------
def test_i5_log_has_no_ip_and_purges_after_30_days(make_app, clock, tmp_path):
    app, _ = make_app()
    with TestClient(app) as c:
        ask(c)
    from api.qalog import QALog
    log = QALog(tmp_path / "qa.jsonl", clock=clock)
    entries = log.entries()
    assert entries and all(set(e) == {"ts", "question", "answer", "ms", "sources"} for e in entries)
    assert "testclient" not in (tmp_path / "qa.jsonl").read_text()
    clock.t += 31 * 86400
    log.purge()
    assert log.entries() == []


# ---------------- I7: spoofed X-Forwarded-For ----------------
def test_i7_spoofed_forwarded_header_does_not_reset_limits(make_app):
    app, _ = make_app()
    with TestClient(app) as c:
        for i in range(10):
            ask(c, headers={"X-Forwarded-For": f"10.0.0.{i}"})
        r, _ = ask(c, headers={"X-Forwarded-For": "10.9.9.9"})
    assert r.status_code == 429


# ---------------- J1: Supermemory down ----------------
class BrokenRetriever:
    def search(self, q, limit):
        raise ConnectionError("down")


def test_j1_memory_down_answers_from_bio(make_app):
    app, _ = make_app(retriever=BrokenRetriever())
    with TestClient(app) as c:
        r, events = ask(c)
    d = dict(events)
    assert d["retrieval"]["error"] == "Couldn't reach Trey's notes"
    assert [s["kind"] for s in d["prompt"]["sections"]] == ["rules", "bio", "question"]
    assert "done" in d


# ---------------- J2: worker crash mid-answer ----------------
def test_j2_crash_mid_answer_sends_error_after_partial_tokens(make_app):
    tok = FakeTokenizer()
    app, _ = make_app(tokenizer=tok, worker=FakeWorker(tok, fail_after=3))
    with TestClient(app) as c:
        _, events = ask(c)
    names = [e for e, _ in events]
    assert names.count("token") == 3 and names[-1] == "error" and dict(events)["error"]["code"] == "model_error"


# ---------------- cold start: the question waits for the model ----------------
def test_cold_question_streams_waking_status_then_answers(make_app):
    tok = FakeTokenizer()
    app, worker = make_app(tokenizer=tok, worker=FakeWorker(tok, load_s=1.6))
    with TestClient(app) as c:
        assert c.get("/api/health").json()["gpu_ready"] is False
        _, events = ask(c)
    phases = [d["phase"] for e, d in events if e == "status"]
    assert "waking" in phases and phases[-1] == "done" and worker.warm_calls >= 1


# ---------------- J5: three visitors at once ----------------
def test_j5_three_at_once_are_queued_and_none_dropped(make_app):
    tok = FakeTokenizer()
    app, _ = make_app(tokenizer=tok, worker=FakeWorker(tok, token_delay_s=0.25))
    results = []
    with TestClient(app) as c:
        def go(i):
            results.append(ask(c, headers={"X-Test": str(i)})[1])
        threads = [threading.Thread(target=go, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
            time.sleep(0.05)
        for t in threads:
            t.join(timeout=30)
    assert len(results) == 3
    assert all(any(e == "done" for e, _ in r) for r in results)
    queued = [d for r in results for e, d in r if e == "status" and d["phase"] == "queued"]
    assert queued and all(d["queue_pos"] >= 1 for d in queued)


# ---------------- tokenize ----------------
def test_tokenize_returns_pieces_and_rejects_long_input(make_app):
    app, _ = make_app()
    with TestClient(app) as c:
        r = c.get("/api/tokenize", params={"q": "What projects has Trey built"})
        assert r.status_code == 200 and r.json()["count"] == len(r.json()["pieces"]) > 0
        assert c.get("/api/tokenize", params={"q": "x" * 301}).status_code == 400


def test_health_reports_version_and_schema(make_app):
    app, _ = make_app(settings=Settings())
    with TestClient(app) as c:
        h = c.get("/api/health").json()
    assert h["schema_v"] == 1 and h["version"] and h["chat_enabled"] is True


def test_a5_each_limit_says_why_and_when():
    from api.gateway import limit_message, wait_text

    assert wait_text(30) == "less than a minute" and wait_text(420) == "7 minutes" and wait_text(5 * 3600) == "about 5 hours"
    assert "10 questions in the last 10 minutes" in limit_message("window", 420, 10, 600) and "7 minutes" in limit_message("window", 420, 10, 600)
    assert "100 questions in the last hour" in limit_message("window", 420, 100, 3600)
    assert "today's limit of 60 questions" in limit_message("ip_day", 5 * 3600, 60)
    assert "answered as many questions as it can today" in limit_message("global_day", 3600, 400)


def test_a5_temporary_allowance_runs_until_its_date_then_ends_on_its_own(clock):
    from api.ratelimit import Promo

    until = clock.t + 7 * 86400
    lim = RateLimiter(MemoryStore(), salt="s", window_s=600, window_max=10, day_max_ip=60, day_max_global=1000,
                      warm_per_minute=6, clock=clock, promo=Promo(until, 3600, 100, 400, 60))
    assert all(lim.check_chat("10.0.0.1").ok for _ in range(100))  # 100 in an hour from one address
    d = lim.check_chat("10.0.0.1")
    assert not d.ok and d.reason == "window" and d.limit == 100 and d.window_s == 3600
    clock.t = until + 86400  # after the end date
    assert all(lim.check_chat("10.0.0.2").ok for _ in range(10))
    d = lim.check_chat("10.0.0.2")
    assert not d.ok and d.limit == 10 and d.window_s == 600


def test_production_settings_include_the_allowance_until_december_first():
    from datetime import datetime

    from api.config import Settings
    from api.ratelimit import limiter_from_settings

    lim = limiter_from_settings(MemoryStore(), Settings())
    assert lim.promo is not None and datetime.fromtimestamp(lim.promo.until).isoformat() >= "2026-11-30"
    assert lim.limits(datetime.fromisoformat("2026-11-25T12:00:00+00:00").timestamp())[:2] == (3600, 100)
    assert lim.limits(datetime.fromisoformat("2026-12-01T06:00:00+00:00").timestamp())[:2] == (600, 10)
