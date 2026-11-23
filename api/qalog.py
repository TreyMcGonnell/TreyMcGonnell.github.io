"""Question/answer log for quality review: no IP addresses, entries older than the retention window are purged."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class QALog:
    def __init__(self, path: str | Path, retention_days: int = 30, clock=time.time):
        self.path = Path(path)
        self.retention_s = retention_days * 86400
        self.clock = clock
        self._lock = threading.Lock()

    def write(self, *, question: str, answer: str, ms: float, sources: list[dict]) -> None:
        entry = {"ts": round(self.clock(), 3), "question": question, "answer": answer, "ms": ms, "sources": sources}
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self.purge()

    def purge(self) -> None:
        if not self.path.exists():
            return
        cutoff = self.clock() - self.retention_s
        lines = self.path.read_text(encoding="utf-8").splitlines()
        keep = [ln for ln in lines if ln.strip() and json.loads(ln).get("ts", 0) >= cutoff]
        if len(keep) != len(lines):
            self.path.write_text("".join(ln + "\n" for ln in keep), encoding="utf-8")

    def entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(ln) for ln in self.path.read_text(encoding="utf-8").splitlines() if ln.strip()]
