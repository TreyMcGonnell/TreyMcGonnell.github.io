"""Where the model runs. The gateway only sees this interface, so local GPU, Modal GPU and test fakes are interchangeable.

Nothing here imports torch at module level: the gateway image on Modal ships without it so it starts fast.
"""
from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import TYPE_CHECKING, Protocol

from .config import Settings
from .prompt import PromptBuild

if TYPE_CHECKING:
    from .inference import ModelRunner, NeuronSet

EVENT = tuple[str, dict]


class Worker(Protocol):
    def is_ready(self) -> bool: ...
    def warm(self) -> None: ...
    def wait_ready(self, timeout: float) -> bool: ...
    def stream(self, build: PromptBuild, *, seed: int | None = None) -> Iterator[EVENT]: ...


class LocalWorker:
    """Loads the model in a background thread on first warm-up and runs it in-process (local GPU)."""

    def __init__(self, model_path: str, data_dir: str, settings: Settings, tokenizer=None):
        self.model_path, self.data_dir, self.settings, self.tokenizer = model_path, data_dir, settings, tokenizer
        self.runner: ModelRunner | None = None
        self.neurons: NeuronSet | None = None
        self.error: str | None = None
        self._ready = threading.Event()
        self._started = False
        self._lock = threading.Lock()

    def is_ready(self) -> bool:
        return self._ready.is_set()

    def warm(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            self.error = None
        threading.Thread(target=self._load, name="model-load", daemon=True).start()

    def _load(self) -> None:
        from .inference import ModelRunner, NeuronSet

        try:
            if not NeuronSet.exists(self.data_dir):
                raise RuntimeError(f"No neuron calibration in {self.data_dir}. Run scripts/pick_neurons.py first.")
            self.neurons = NeuronSet.load(self.data_dir)
            self.runner = ModelRunner(self.model_path, tokenizer=self.tokenizer)
            self._ready.set()
        except Exception as exc:  # surfaced through /api/health and chat errors
            self.error = str(exc)
            with self._lock:
                self._started = False

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def stream(self, build: PromptBuild, *, seed: int | None = None) -> Iterator[EVENT]:
        assert self.runner is not None and self.neurons is not None
        s = self.settings
        yield from self.runner.stream(build, self.neurons, temperature=s.temperature, top_p=s.top_p,
                                      max_new_tokens=s.max_new_tokens, seed=seed)
