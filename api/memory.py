"""Retrieval of Trey's notes.

Production uses Supermemory. Local development (no API key) uses a small TF-IDF index over the
local content folder with the same interface, so the rest of the pipeline is identical.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .prompt import Passage

_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")
STOPWORDS = frozenset(
    "a an and are as at be but by can did do does for from has have he her his how i in is it its me my of on or "
    "our she so than that the their them they this to was we were what when where which who whom why will with "
    "you your about tell trey trey's".split()
)
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="retrieval")


class Retriever(Protocol):
    def search(self, query: str, limit: int) -> list[Passage]: ...


IRREGULAR = {"built": "build", "made": "make", "wrote": "write", "written": "write", "studies": "study", "studying": "study",
              "student": "study", "students": "study", "did": "do", "done": "do", "taught": "teach", "ran": "run"}
# Small query expansion so the local stand-in behaves a bit like semantic search (Supermemory does this properly).
EXPAND = {"build": ["project"], "make": ["project"], "create": ["project"], "work": ["project"], "develop": ["project"],
          "study": ["school", "university", "major"], "school": ["university"], "video": ["youtube"], "club": ["activity"],
          "hire": ["skill", "project"], "skill": ["tool", "language"]}


def stem(word: str) -> str:
    w = word.lower()
    if w in IRREGULAR:
        return IRREGULAR[w]
    for suf, rep in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)] + rep
    return w


def terms(text: str, expand: bool = False) -> list[str]:
    out = [stem(w) for w in _WORD.findall(text) if w.lower() not in STOPWORDS and len(w) > 1]
    if expand:
        out += [e for t in list(out) for e in EXPAND.get(t, [])]
    return out


def highlights(question: str, snippet: str) -> list[list[int]]:
    """Character ranges in `snippet` of words that also appear (stemmed) in the question."""
    wanted = set(terms(question))
    return [[m.start(), m.end()] for m in _WORD.finditer(snippet)
            if m.group(0).lower() not in STOPWORDS and stem(m.group(0)) in wanted]


def _strip_frontmatter(text: str) -> tuple[dict, str]:
    meta: dict = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip('"')
            text = text[end + 4 :]
    return meta, text.strip()


def _chunks(body: str, max_words: int = 110) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip() and not p.strip().startswith("#")]
    out, cur = [], []
    for p in paras:
        words = p.split()
        if cur and len(cur) + len(words) > max_words:
            out.append(" ".join(cur))
            cur = []
        cur.extend(words)
    if cur:
        out.append(" ".join(cur))
    return out


class LocalRetriever:
    """TF-IDF over content/notes/*.md and content/projects/*.md (development stand-in for Supermemory)."""

    def __init__(self, content_dir: str | Path):
        self.docs: list[tuple[str, str, str, Counter]] = []  # file, title, text, term counts
        root = Path(content_dir)
        for sub in ("notes", "projects"):
            for path in sorted((root / sub).glob("*.md")):
                meta, body = _strip_frontmatter(path.read_text(encoding="utf-8"))
                title = meta.get("title") or path.stem.replace("-", " ").title()
                rel = f"{sub}/{path.name}"
                category = "project" if sub == "projects" else "note"
                for chunk in _chunks(body) or [body]:
                    self.docs.append((rel, title, chunk, Counter(terms(f"{category} {title} {chunk}"))))
        n = max(1, len(self.docs))
        df: Counter = Counter()
        for *_, tf in self.docs:
            df.update(set(tf))
        self.idf = {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}

    def _vec(self, tf: Counter) -> dict[str, float]:
        v = {t: (1 + math.log(c)) * self.idf.get(t, 0.0) for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    def search(self, query: str, limit: int) -> list[Passage]:
        qv = self._vec(Counter(terms(query, expand=True)))
        scored = []
        for file, title, text, tf in self.docs:
            dv = self._vec(tf)
            s = sum(qv.get(t, 0.0) * w for t, w in dv.items())
            scored.append((s, file, title, text))
        scored.sort(key=lambda x: -x[0])
        best: dict[str, Passage] = {}
        for s, file, title, text in scored:
            if file not in best:
                # square root spreads short-query cosine scores into a readable 0..1 match strength
                best[file] = Passage(file=file, title=title, text=text, score=round(min(1.0, math.sqrt(max(0.0, s))), 3))
            if len(best) >= limit:
                break
        return list(best.values())


def _doc_name(doc: dict) -> str:
    """A readable name for a document added by hand: its title, or the `title:` line of pasted frontmatter."""
    title = (doc.get("title") or "").strip()
    m = re.search(r"^title:\s*(.+)$", title, flags=re.M)
    name = (m.group(1) if m else title.splitlines()[0] if title else "").strip().strip("-").strip()
    return name[:60]


class SupermemoryRetriever:
    """Supermemory v5 search over the trey-lm namespace, in "chunks" mode so passages are Trey's own words
    (not summaries). Chunks are grouped back into one passage per file, best match first."""

    def __init__(self, api_key: str, base_url: str, namespace: str, threshold: float = 0.6, margin: float = 0.08, transport=None):
        import httpx

        self.client = httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=5.0, transport=transport)
        self.namespace = namespace
        self.threshold, self.margin = threshold, margin

    def search(self, query: str, limit: int) -> list[Passage]:
        r = self.client.post(f"/ns/{self.namespace}/search",
                             json={"query": query, "limit": limit * 3, "searchMode": "chunks", "threshold": 0,
                                   "include": {"documents": True}})
        r.raise_for_status()
        by_file: dict[str, Passage] = {}
        for item in r.json().get("results", []):
            text = item.get("chunk") or ""
            if not isinstance(text, str) or not text.strip():
                continue
            doc = (item.get("included") or {}).get("document") or {}
            meta = item.get("metadata") or doc.get("metadata") or {}
            # synced files carry their path; documents added by hand in the Supermemory app are named by their title
            file = meta.get("file") or _doc_name(doc) or item.get("id", "note")
            score = float(item.get("similarity", 0.0))
            if file not in by_file:
                by_file[file] = Passage(file=file, title=meta.get("title") or file, text=text.strip(), score=score)
            elif len(by_file[file].text) < 700:  # a second chunk from the same file adds context
                by_file[file].text += " " + text.strip()
        return sorted(by_file.values(), key=lambda p: -p.score)[:limit]


@dataclass
class RetrievalResult:
    results: list[dict]
    used: list[Passage]
    error: str | None = None

    def event(self) -> dict:
        data: dict = {"results": self.results}
        if self.error:
            data["error"] = self.error
        return data


def retrieve(retriever: Retriever | None, question: str, *, limit: int, use: int, threshold: float, timeout_s: float) -> RetrievalResult:
    """Search with a hard timeout. Only the top `use` results above `threshold` go into the prompt."""
    if retriever is None:
        return RetrievalResult(results=[], used=[], error="Couldn't reach Trey's notes")
    future = _pool.submit(retriever.search, question, limit)
    try:
        found = future.result(timeout=timeout_s)
    except FutureTimeout:
        return RetrievalResult(results=[], used=[], error="Couldn't reach Trey's notes")
    except Exception:  # network or API failure: answer from the bio alone
        return RetrievalResult(results=[], used=[], error="Couldn't reach Trey's notes")
    # Zero-score results aren't matches; listing them would show unrelated notes as if they were candidates.
    found = sorted((p for p in found if p.score > 0), key=lambda p: -p.score)[:limit]
    # A retriever may carry its own scale (Supermemory's similarities differ from the local TF-IDF scores).
    floor = getattr(retriever, "threshold", None) or threshold
    margin = getattr(retriever, "margin", None) or 1.0
    top = found[0].score if found else 0.0
    used = [p for p in found if p.score >= floor and p.score >= top - margin][:use]
    results = []
    for p in found:
        snippet = p.text[:280]
        results.append(
            {
                "file": p.file,
                "title": p.title,
                "score": round(float(min(1.0, max(0.0, p.score))), 3),
                "used": p in used,
                "snippet": snippet,
                "highlights": highlights(question, snippet),
            }
        )
    return RetrievalResult(results=results, used=used)
