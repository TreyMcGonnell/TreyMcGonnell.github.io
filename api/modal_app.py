"""Production deployment on Modal: a CPU gateway (FastAPI) in front of one GPU worker.

    modal run api/modal_app.py::download_model     # once: copies the weights into the trey-lm-models volume
    modal deploy api/modal_app.py                  # CI does this on every push to main that touches api/

Expects, next to this repo at deploy time (CI checks them out; never committed here):
    content/   the private trey-lm-content repo (trey.md, notes/, projects/)
    api/data/  calibration output (neurons.npz, neuron_labels.json, embed_preview.npy/.json)
Secrets (Modal secret "trey-lm"): SUPERMEMORY_API_KEY, LOG_SALT (HF_TOKEN only if you switch to the gated meta-llama repo).
Kill switch: `python scripts/chat_switch.py off` (takes effect within about 10 s; `on` to restore).

Modal's API evolves; check decorator arguments against the current docs when first deploying (handoff M1).
"""
from __future__ import annotations

import time
from dataclasses import replace

import modal

APP = "trey-lm"
MODEL_DIR = "/models/llama-3.2-3b-instruct"

app = modal.App(APP)
models = modal.Volume.from_name("trey-lm-models", create_if_missing=True)
state = modal.Dict.from_name("trey-lm-state", create_if_missing=True)
secret = modal.Secret.from_name("trey-lm")

base = modal.Image.debian_slim(python_version="3.11")
gateway_image = (
    base.pip_install("fastapi>=0.115", "pydantic>=2.9", "transformers>=4.46,<5", "tokenizers", "numpy", "httpx", "jsonschema")
    .add_local_dir("content", "/content", copy=True)
    .add_local_dir("api/data", "/data", copy=True)
    .add_local_python_source("api")
)
worker_image = (
    base.pip_install("torch==2.5.1", "transformers>=4.46,<5", "accelerate", "safetensors", "numpy", "huggingface_hub")
    .add_local_dir("api/data", "/data", copy=True)
    .add_local_python_source("api")
)


@app.function(image=worker_image, volumes={"/models": models}, secrets=[secret], timeout=3600)
def download_model(repo_id: str = "unsloth/Llama-3.2-3B-Instruct") -> None:  # same weights as meta-llama, no gated download
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id, local_dir=MODEL_DIR, allow_patterns=["*.json", "*.safetensors"])
    models.commit()


@app.cls(image=worker_image, gpu="T4", volumes={"/models": models}, secrets=[secret], scaledown_window=300,
         max_containers=1, enable_memory_snapshot=True, timeout=600, memory=12288, cpu=2.0)
class Worker:
    @modal.enter(snap=True)
    def load_on_cpu(self):
        import torch

        from api.inference import ModelRunner, NeuronSet

        self.neurons = NeuronSet.load("/data")
        # float16 already on the CPU: half the memory to snapshot, and the T4 has no fast bfloat16
        self.runner = ModelRunner(MODEL_DIR, device="cpu", dtype=torch.float16)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        self.runner.to("cuda")
        state["gpu_ready"] = True

    @modal.exit()
    def goodbye(self):
        state["gpu_ready"] = False

    @modal.method()
    def ping(self) -> bool:
        return True

    @modal.method()
    def stream(self, ids: list[int], positions_src: list[str], seed: int | None, temperature: float, top_p: float,
               max_new_tokens: int):
        from api.prompt import PromptBuild

        build = PromptBuild(ids=ids, positions_src=positions_src, sections=[], notes_used=[])
        yield from self.runner.stream(build, self.neurons, temperature=temperature, top_p=top_p,
                                      max_new_tokens=max_new_tokens, seed=seed)


class Cached:
    """A Modal Dict value read at most once per `ttl` seconds (each read is a network round trip)."""

    def __init__(self, key: str, default, ttl: float):
        self.key, self.default, self.ttl = key, default, ttl
        self.value, self.at = default, -1e9

    def get(self):
        if time.monotonic() - self.at > self.ttl:
            try:
                self.value = state.get(self.key, self.default)
            except Exception:
                pass  # keep the last known value if the Dict is briefly unreachable
            self.at = time.monotonic()
        return self.value

    def set_local(self, value) -> None:
        self.value, self.at = value, time.monotonic()


GPU_READY = Cached("gpu_ready", False, ttl=2.0)
CHAT_ENABLED = Cached("chat_enabled", "true", ttl=10.0)  # the kill switch takes effect within 10 s


class RemoteWorker:
    """The gateway's view of the GPU class."""

    def __init__(self, settings):
        self.settings = settings
        self.error = None

    def is_ready(self) -> bool:
        return bool(GPU_READY.get())

    def warm(self) -> None:
        Worker().ping.spawn()

    def wait_ready(self, timeout: float) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.is_ready():
                return True
            time.sleep(0.25)
        return self.is_ready()

    def stream(self, build, *, seed=None):
        s = self.settings
        for event, data in Worker().stream.remote_gen(build.ids, build.positions_src, seed, s.temperature, s.top_p,
                                                       s.max_new_tokens):
            if event == "prefill":
                GPU_READY.set_local(True)  # it answered, so it is awake
            yield event, data


class ModalDictStore:
    """Rate-limit counters: kept in memory (one gateway container) and copied to a Modal Dict in the background,
    so a restarted gateway picks up where it left off. Each key is read from the Dict once per container."""

    def __init__(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor

        self.local: dict = {}
        self.lock = threading.Lock()
        self.writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ratelimit-dict")

    def get(self, key, default=None):
        with self.lock:
            if key in self.local:
                return self.local[key]
        try:
            value = state.get(f"rl:{key}", default)
        except Exception:
            value = default
        with self.lock:
            return self.local.setdefault(key, value)

    def put(self, key, value):
        with self.lock:
            self.local[key] = value
        self.writer.submit(state.put, f"rl:{key}", value)


# One gateway container (32 requests at once) keeps the one-at-a-time GPU queue and its positions accurate.
@app.function(image=gateway_image, volumes={"/models": models}, secrets=[secret], scaledown_window=600, max_containers=1,
              cpu=1.0, memory=2048)
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def gateway():
    import json
    import os
    from pathlib import Path

    import numpy as np
    from transformers import AutoConfig, AutoTokenizer

    from api.config import Settings, lens_layers
    from api.gateway import create_app
    from api.local import make_retriever, read_bio
    from api.qalog import QALog
    from api.ratelimit import limiter_from_settings

    settings = replace(Settings.from_env(), content_dir="/content", data_dir="/data", log_path="/models/logs/qa-log.jsonl")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    cfg = AutoConfig.from_pretrained(MODEL_DIR)
    meta = {"v": 1, "model": settings.model_name, "layers": cfg.num_hidden_layers, "hidden": cfg.hidden_size,
            "mlp": cfg.intermediate_size, "vocab": cfg.vocab_size, "temperature": settings.temperature,
            "neurons_per_layer": settings.neurons_per_layer, "lens_layers": lens_layers(cfg.num_hidden_layers)}
    embed, scale = None, 1.0
    if Path("/data/embed_preview.npy").exists():
        embed = np.load("/data/embed_preview.npy")
        scale = float(json.loads(Path("/data/embed_preview.json").read_text())["scale"])
    limiter = limiter_from_settings(ModalDictStore(), settings, salt=os.environ.get("LOG_SALT", settings.log_salt))
    return create_app(settings=settings, tokenizer=tokenizer, worker=RemoteWorker(settings), retriever=make_retriever(settings),
                      limiter=limiter, bio=read_bio(settings), meta=meta, embed_preview=embed, embed_scale=scale,
                      qa_log=QALog(settings.log_path, settings.log_retention_days),
                      chat_enabled=lambda: str(CHAT_ENABLED.get()).lower() not in ("false", "0", "off"))
