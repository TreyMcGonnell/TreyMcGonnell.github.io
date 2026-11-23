import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from api.config import Settings  # noqa: E402
from api.fakes import FakeTokenizer, FakeWorker  # noqa: E402
from api.gateway import create_app  # noqa: E402
from api.memory import LocalRetriever  # noqa: E402
from api.qalog import QALog  # noqa: E402
from api.ratelimit import MemoryStore, RateLimiter  # noqa: E402

SCHEMA = json.loads((ROOT / "protocol" / "frame.schema.json").read_text(encoding="utf-8"))

NOTES = {
    "notes/sample-clubs.md": "---\ntitle: Sample clubs note\n---\nSAMPLE CONTENT. Trey is in the sample robotics club and the sample data club.",
    "projects/sample-detector.md": "---\ntitle: Sample scam detector\n---\nSAMPLE CONTENT. Trey built a sample scam detection tool in Python that flags risky messages.",
    "projects/sample-dashboard.md": "---\ntitle: Sample dashboard\n---\nSAMPLE CONTENT. A sample dashboard for campus bus times built with JavaScript.",
}
BIO = "SAMPLE BIO. Trey is a sample data science student at a sample university."


@pytest.fixture
def content_dir(tmp_path):
    for rel, text in NOTES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return tmp_path


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def make_app(content_dir, clock, tmp_path):
    def _make(**kw):
        settings = kw.pop("settings", Settings(retrieval_threshold=0.05))
        tok = kw.pop("tokenizer", FakeTokenizer())
        worker = kw.pop("worker", FakeWorker(tok))
        limiter = kw.pop("limiter", RateLimiter(MemoryStore(), salt="t", window_s=600, window_max=10, day_max_ip=60,
                                                day_max_global=400, warm_per_minute=6, clock=clock))
        retriever = kw.pop("retriever", LocalRetriever(content_dir))
        qa_log = kw.pop("qa_log", QALog(tmp_path / "qa.jsonl", clock=clock))
        app = create_app(settings=settings, tokenizer=tok, worker=worker, retriever=retriever, limiter=limiter, bio=BIO,
                         meta=worker.meta(settings.temperature), qa_log=qa_log, **kw)
        return app, worker
    return _make


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        ev, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if ev:
            out.append((ev, data))
    return out
