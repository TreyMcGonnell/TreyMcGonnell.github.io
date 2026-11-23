"""Shared wiring for local runs (dev server, scripts): model files, tokenizer, content, retriever."""
from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("USE_TF", "0")  # a system-wide TensorFlow install would otherwise be imported by transformers
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

from .config import Settings  # noqa: E402
from .memory import LocalRetriever, SupermemoryRetriever

ROOT = Path(__file__).resolve().parents[1]


def resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


DEFAULT_MODEL_DIR = Path.home() / ".cache" / "trey-lm" / "llama-3.2-3b-instruct"


def _download(settings: Settings, patterns: list[str]) -> str:
    # A plain folder (local_dir) instead of the symlinked HF cache: symlinks need extra privileges on Windows.
    from huggingface_hub import snapshot_download

    target = Path(os.environ.get("MODEL_PATH") or DEFAULT_MODEL_DIR)
    snapshot_download(settings.model_id, local_dir=str(target), allow_patterns=patterns)
    return str(target)


def model_path(settings: Settings) -> str:
    """Folder with the model files, outside the repo. Downloads on first use."""
    target = Path(os.environ.get("MODEL_PATH") or DEFAULT_MODEL_DIR)
    if any(target.glob("*.safetensors")) and (target / "config.json").exists():
        return str(target)
    return _download(settings, ["*.json", "*.safetensors"])


def tokenizer_path(settings: Settings) -> str:
    target = Path(os.environ.get("MODEL_PATH") or DEFAULT_MODEL_DIR)
    if (target / "tokenizer.json").exists():
        return str(target)
    return _download(settings, ["*.json"])


def read_bio(settings: Settings) -> str:
    p = resolve(settings.content_dir) / "trey.md"
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    if text.startswith("---"):
        end = text.find("\n---", 3)
        text = text[end + 4 :] if end != -1 else text
    return text.strip()


def make_retriever(settings: Settings):
    if settings.supermemory_api_key:
        return SupermemoryRetriever(settings.supermemory_api_key, settings.supermemory_base_url, settings.supermemory_container,
                                    threshold=settings.supermemory_threshold, margin=settings.supermemory_margin)
    content = resolve(settings.content_dir)
    return LocalRetriever(content) if content.exists() else None
