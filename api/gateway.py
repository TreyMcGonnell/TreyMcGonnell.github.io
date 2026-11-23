"""The HTTP gateway: everything the browser talks to. Runs on CPU; only `worker.stream` needs the GPU."""
from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable, Iterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .memory import Retriever, retrieve
from .prompt import SECRET_RULES, build_prompt
from .qalog import QALog
from .ratelimit import RateLimiter
from .worker import Worker

WAKE_TIMEOUT_S = 180
HOLD_TOKENS = 12  # most tokens ever held back while an answer looks like it might be starting to recite a rule
BLOCKED_MESSAGE = "I stopped that answer because it started repeating my instructions. Ask me about Trey's projects or school."


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))


def rule_ngrams(lines: list[str], n: int = 5) -> set[tuple[str, ...]]:
    """5-word sequences from the secret rule lines, which an honest answer would never contain."""
    grams: set[tuple[str, ...]] = set()
    for line in lines:
        w = _words(line)
        grams |= {tuple(w[i:i + n]) for i in range(len(w) - n + 1)}
    return grams


class LeakGuard:
    """Stops answers that recite the secret rules. Tokens are held back only while the end of the answer could be
    the start of a rule (two or more words in), so ordinary answers stream without delay."""

    def __init__(self, grams: set[tuple[str, ...]], n: int = 5):
        self.grams, self.n = grams, n
        # next_words[j][first j words] = words that can come next in some rule n-gram
        self.next_words: list[dict[tuple[str, ...], set[str]]] = [{} for _ in range(n)]
        for g in grams:
            for j in range(1, n):
                self.next_words[j].setdefault(g[:j], set()).add(g[j])

    def leaks(self, text: str) -> bool:
        w = _words(text)
        return any(tuple(w[i:i + self.n]) in self.grams for i in range(len(w) - self.n + 1))

    def risky(self, text: str) -> bool:
        """True when the last words could be the opening of a rule (the last word may still be incomplete)."""
        w = _words(text)
        if not w:
            return False
        last = w[-1]
        for j in range(1, min(self.n, len(w))):
            nxt = self.next_words[j].get(tuple(w[-j - 1:-1]))
            if nxt and any(c.startswith(last) for c in nxt):
                return True
        return False


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


class GenerationSlot:
    """One answer at a time on the GPU; everyone else waits in line and is told their place."""

    def __init__(self):
        self._cond = threading.Condition()
        self._busy = False
        self._line: list[object] = []

    def join(self) -> object:
        ticket = object()
        with self._cond:
            self._line.append(ticket)
        return ticket

    def position(self, ticket: object) -> int:
        with self._cond:
            return self._line.index(ticket) + 1 + (1 if self._busy else 0)

    def try_acquire(self, ticket: object, wait_s: float) -> bool:
        with self._cond:
            end = time.monotonic() + wait_s
            while self._busy or self._line[0] is not ticket:
                left = end - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(left)
            self._line.pop(0)
            self._busy = True
            return True

    def leave(self, ticket: object) -> None:
        with self._cond:
            if ticket in self._line:
                self._line.remove(ticket)
            self._cond.notify_all()

    def release(self) -> None:
        with self._cond:
            self._busy = False
            self._cond.notify_all()


def _clean(q: str) -> str:
    return "".join(ch for ch in q if ch == "\n" or ch == "\t" or ch.isprintable()).replace("\t", " ").strip()


def create_app(*, settings: Settings, tokenizer, worker: Worker, retriever: Retriever | None, limiter: RateLimiter,
               bio: str, meta: dict, embed_preview=None, embed_scale: float = 1.0, qa_log: QALog | None = None,
               chat_enabled: Callable[[], bool] | None = None, worker_error: Callable[[], str | None] | None = None) -> FastAPI:
    app = FastAPI(title="trey-lm", version=settings.version, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type"], max_age=600)
    slot = GenerationSlot()
    guard = LeakGuard(rule_ngrams(SECRET_RULES))
    is_enabled = chat_enabled or (lambda: settings.chat_enabled)
    get_error = worker_error or (lambda: getattr(worker, "error", None))

    def client_ip(request: Request) -> str:
        # Deliberately ignores X-Forwarded-For: a visitor can set that header to anything (test I7).
        return request.client.host if request.client else "unknown"

    def error(status: int, code: str, message: str, retry_after: int | None = None) -> JSONResponse:
        body = {"code": code, "message": message}
        headers = {}
        if retry_after is not None:
            body["retry_after"] = retry_after
            headers["Retry-After"] = str(retry_after)
        return JSONResponse(body, status_code=status, headers=headers)

    @app.get("/api/health")
    def health():
        return {"chat_enabled": bool(is_enabled()), "gpu_ready": worker.is_ready(), "version": settings.version,
                "schema_v": settings.schema_v, "model_error": get_error()}

    @app.post("/api/warm")
    def warm(request: Request):
        d = limiter.check_warm(client_ip(request))
        if not d.ok:
            return error(429, "rate_limited", "Too many warm-up requests.", d.retry_after)
        if is_enabled():
            worker.warm()
        return {"ok": True, "gpu_ready": worker.is_ready()}

    @app.get("/api/tokenize")
    def tokenize(q: str = ""):
        if len(q) > settings.max_question_chars:
            return error(400, "bad_input", f"Questions are limited to {settings.max_question_chars} characters.")
        ids = list(tokenizer.encode(q, add_special_tokens=False))
        pieces = [tokenizer.decode([i]) for i in ids]
        rows = None
        if embed_preview is not None:
            rows = [[round(float(v), 4) for v in embed_preview[i]] for i in ids[:16]]
        return {"ids": ids, "pieces": pieces, "count": len(ids), "chars": len(q), "vocab": meta["vocab"],
                "hidden": meta["hidden"], "embed_preview": rows, "embed_scale": embed_scale}

    @app.post("/api/chat")
    async def chat(request: Request):
        try:
            body = await request.json()
        except Exception:
            return error(400, "bad_input", "Send JSON like {\"q\": \"your question\"}.")
        q = body.get("q") if isinstance(body, dict) else None
        if not isinstance(q, str):
            return error(400, "bad_input", "The question must be text.")
        q = _clean(q)
        if not q:
            return error(400, "bad_input", "Ask a question first.")
        if len(q) > settings.max_question_chars:
            return error(400, "bad_input", f"Questions are limited to {settings.max_question_chars} characters.")
        if not is_enabled():
            return error(503, "chat_disabled", "The chat is turned off right now. Here's a recorded answer instead.")
        d = limiter.check_chat(client_ip(request))
        if not d.ok:
            minutes = max(1, round(d.retry_after / 60))
            return error(429, "rate_limited", f"You've asked a lot of questions. Try again in {minutes} minutes.", d.retry_after)
        seed = body.get("seed") if isinstance(body.get("seed"), int) else None
        return StreamingResponse(_answer(q, seed), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def _answer(q: str, seed: int | None) -> Iterator[str]:
        t0 = time.monotonic()

        def elapsed() -> int:
            return int((time.monotonic() - t0) * 1000)

        yield sse("meta", {**meta, "temperature": settings.temperature})
        yield sse("status", {"phase": "retrieving", "elapsed_ms": elapsed()})
        found = retrieve(retriever, q, limit=settings.retrieval_limit, use=settings.retrieval_use,
                         threshold=settings.retrieval_threshold, timeout_s=settings.retrieval_timeout_s)
        yield sse("retrieval", found.event())
        build = build_prompt(tokenizer, bio, found.used, q, limit=settings.prompt_token_limit)
        yield sse("prompt", build.event())

        if not worker.is_ready():
            worker.warm()
            wake0 = time.monotonic()
            while not worker.wait_ready(1.0):
                if get_error() or time.monotonic() - wake0 > WAKE_TIMEOUT_S:
                    yield sse("error", {"code": "model_error", "message": "The model couldn't start. Here's a recorded answer instead."})
                    return
                yield sse("status", {"phase": "waking", "elapsed_ms": elapsed()})

        ticket = slot.join()
        try:
            while not slot.try_acquire(ticket, 1.0):
                yield sse("status", {"phase": "queued", "elapsed_ms": elapsed(), "queue_pos": slot.position(ticket)})
        except GeneratorExit:
            slot.leave(ticket)
            raise
        answer, done, held, sent = [], None, [], 0
        try:
            yield sse("status", {"phase": "prefill", "elapsed_ms": elapsed()})
            stream = worker.stream(build, seed=seed)
            for event, data in stream:
                if event != "token":
                    if event == "done":
                        done = data
                        for t in held:  # the answer finished cleanly: release what was held back
                            yield sse("token", t)
                        held = []
                    yield sse(event, data)
                    continue
                answer.append(data["text"])
                if guard.leaks("".join(answer)):
                    stream.close()
                    done = None
                    yield sse("error", {"code": "blocked", "message": BLOCKED_MESSAGE})
                    return
                held.append(data)
                if guard.risky("".join(answer)) and len(held) <= HOLD_TOKENS:
                    continue  # could be the start of a rule: wait for the next words before showing these
                if sent == 0:
                    yield sse("status", {"phase": "generating", "elapsed_ms": elapsed()})
                for t in held:
                    sent += 1
                    yield sse("token", t)
                held = []
            for t in held:  # stream ended without a done event
                yield sse("token", t)
            yield sse("status", {"phase": "done", "elapsed_ms": elapsed()})
        except Exception:
            for t in held:  # keep the partial answer (J2): release what was held back, then report the error
                yield sse("token", t)
            yield sse("error", {"code": "model_error", "message": "Something went wrong while writing. The partial answer is kept; try again."})
        finally:
            slot.leave(ticket)
            slot.release()
            if qa_log is not None and done is not None:
                qa_log.write(question=q, answer="".join(answer), ms=done["ms"], sources=done["sources"])

    return app
