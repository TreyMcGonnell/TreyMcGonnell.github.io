"""Local development server: the gateway plus a GPU worker in one process.

    python -m api.serve_local            # http://127.0.0.1:8000
    CHAT_ENABLED=false python -m api.serve_local

Uses Supermemory when SUPERMEMORY_API_KEY is set, otherwise a local index over content/.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import uvicorn
from transformers import AutoConfig, AutoTokenizer

from .config import Settings, lens_layers
from .gateway import create_app
from .local import make_retriever, model_path, read_bio, resolve
from .qalog import QALog
from .ratelimit import MemoryStore, RateLimiter
from .worker import LocalWorker


def build_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    path = model_path(settings)
    tokenizer = AutoTokenizer.from_pretrained(path)
    cfg = AutoConfig.from_pretrained(path)
    data_dir = resolve(settings.data_dir)
    per_layer = settings.neurons_per_layer
    meta = {"v": 1, "model": settings.model_name, "layers": cfg.num_hidden_layers, "hidden": cfg.hidden_size,
            "mlp": cfg.intermediate_size, "vocab": cfg.vocab_size, "temperature": settings.temperature,
            "neurons_per_layer": per_layer, "lens_layers": lens_layers(cfg.num_hidden_layers)}
    embed, scale = None, 1.0
    if (data_dir / "embed_preview.npy").exists():
        embed = np.load(data_dir / "embed_preview.npy")
        scale = float(json.loads((data_dir / "embed_preview.json").read_text())["scale"])
    worker = LocalWorker(path, str(data_dir), settings, tokenizer=tokenizer)
    limiter = RateLimiter(MemoryStore(), salt=settings.log_salt, window_s=settings.rate_window_s,
                          window_max=settings.rate_window_max, day_max_ip=settings.rate_day_max_ip,
                          day_max_global=settings.rate_day_max_global, warm_per_minute=settings.warm_per_minute)
    app = create_app(settings=settings, tokenizer=tokenizer, worker=worker, retriever=make_retriever(settings),
                     limiter=limiter, bio=read_bio(settings), meta=meta, embed_preview=embed, embed_scale=scale,
                     qa_log=QALog(resolve(settings.log_path), settings.log_retention_days),
                     chat_enabled=lambda: os.environ.get("CHAT_ENABLED", "true").lower() not in ("0", "false", "off"))
    if os.environ.get("PRELOAD", "").lower() in ("1", "true"):
        worker.warm()
    return app


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()


__all__ = ["build_app", "Path"]
