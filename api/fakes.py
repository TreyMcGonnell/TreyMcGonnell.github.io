"""Test doubles: a tiny word tokenizer and a worker that emits schema-valid frames without a model."""
from __future__ import annotations

import base64
import re
import threading
import time
from collections.abc import Iterator

from .config import attention_layers, lens_layers
from .prompt import PromptBuild

SPECIALS = ["<|begin_of_text|>", "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>", "<|end_of_text|>"]
_SPLIT = re.compile("(" + "|".join(re.escape(s) for s in SPECIALS) + r"| ?[A-Za-z0-9']+| ?[^A-Za-z0-9'\s]|\s+)")


class FakeTokenizer:
    """Deterministic, reversible: every special token, word (with its leading space), symbol or whitespace run is one token."""

    def __init__(self):
        self.vocab: dict[str, int] = {s: 128000 + i for i, s in enumerate(SPECIALS)}
        self.inv: dict[int, str] = {v: k for k, v in self.vocab.items()}
        self.all_special_ids = list(self.inv)
        self.eos_token_id = self.vocab["<|eot_id|>"]
        self.vocab_size = 128256

    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        out = []
        for piece in _SPLIT.findall(text):
            if piece not in self.vocab:
                tid = len(self.vocab) - len(SPECIALS) + 1
                self.vocab[piece] = tid
                self.inv[tid] = piece
            out.append(self.vocab[piece])
        return out

    def decode(self, ids, skip_special_tokens: bool = False) -> str:
        return "".join(self.inv[i] for i in ids if not (skip_special_tokens and i >= 128000))


class FakeWorker:
    """Behaves like the GPU worker: loads after `load_s` seconds, then streams a fixed answer."""

    ANSWER = ["Sample", " answer", " from", " the", " fake", " worker", "."]

    def __init__(self, tokenizer: FakeTokenizer, *, load_s: float = 0.0, layers: int = 28, per_layer: int = 14,
                 fail_after: int | None = None, token_delay_s: float = 0.0):
        self.tok, self.load_s, self.layers, self.per_layer = tokenizer, load_s, layers, per_layer
        self.fail_after, self.token_delay_s = fail_after, token_delay_s
        self._ready = threading.Event()
        self._started = False
        self.warm_calls = 0
        self.error = None

    def is_ready(self) -> bool:
        return self._ready.is_set()

    def warm(self) -> None:
        self.warm_calls += 1
        if self._started:
            return
        self._started = True
        if self.load_s <= 0:
            self._ready.set()
        else:
            threading.Timer(self.load_s, self._ready.set).start()

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def meta(self, temperature: float = 0.7) -> dict:
        return {"v": 1, "model": "fake", "layers": self.layers, "hidden": 64, "mlp": 128, "vocab": 128256,
                "temperature": temperature, "neurons_per_layer": self.per_layer, "lens_layers": lens_layers(self.layers)}

    def stream(self, build: PromptBuild, *, seed: int | None = None) -> Iterator[tuple[str, dict]]:
        yield "prefill", {"ms": 12.5, "tokens": build.total}
        sources = sorted(set(build.positions_src))
        for i, text in enumerate(self.ANSWER):
            if self.fail_after is not None and i == self.fail_after:
                raise RuntimeError("simulated worker crash")
            if self.token_delay_s:
                time.sleep(self.token_delay_s)
            share = 1.0 / (len(sources) + 1)
            looking = [{"src": s, "w": round(share, 4)} for s in sources] + [{"src": "answer", "w": round(1 - share * len(sources), 4)}]
            yield "token", {
                "i": i, "id": 1000 + i, "text": text, "p": 0.6,
                "topk": [{"text": text, "p": 0.6}, {"text": " other", "p": 0.2}, {"text": " word", "p": 0.1}],
                "neurons": base64.b64encode(bytes((i * 7 + k) % 256 for k in range(self.layers * self.per_layer))).decode(),
                "top_neuron": {"layer": 20 if self.layers >= 20 else self.layers, "index": 4821 % 128, "row": 3},
                "attention": [{"text": " Trey", "src": "bio", "w": 0.4}],
                "looking_at": looking,
                "logit_lens": [{"layer": layer, "text": text} for layer in lens_layers(self.layers)],
            }
        yield "done", {"tokens": len(self.ANSWER), "ms": 50.0, "sources": [{"src": s, "share": 0.2} for s in sources]}


__all__ = ["FakeTokenizer", "FakeWorker", "attention_layers"]
