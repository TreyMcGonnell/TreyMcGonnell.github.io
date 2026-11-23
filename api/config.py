"""Runtime settings, read from environment variables (Modal secrets in production)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    version: str = "1.0.0"
    schema_v: int = 1
    chat_enabled: bool = True
    allowed_origins: tuple[str, ...] = ("https://treymcgonnell.github.io", "http://localhost:5173")

    # model + generation
    model_id: str = "unsloth/Llama-3.2-3B-Instruct"
    model_name: str = "trey-lm (Llama 3.2 3B Instruct)"
    temperature: float = 0.7
    top_p: float = 0.9
    max_new_tokens: int = 200
    prompt_token_limit: int = 2048
    neurons_per_layer: int = 14

    # input limits
    max_question_chars: int = 300

    # rate limits
    rate_window_s: int = 600
    rate_window_max: int = 10
    rate_day_max_ip: int = 60
    rate_day_max_global: int = 400
    warm_per_minute: int = 6

    # retrieval
    retrieval_timeout_s: float = 1.5
    retrieval_limit: int = 4
    retrieval_use: int = 3
    retrieval_threshold: float = 0.15
    supermemory_api_key: str = ""
    supermemory_base_url: str = "https://api.supermemory.ai"
    supermemory_container: str = "trey-lm"
    # Supermemory similarities sit in a narrow band (about 0.45 to 0.8), so a note is used when it clears the
    # floor AND is close to the best match. Re-check both against real content (scripts/run_evals.py).
    supermemory_threshold: float = 0.6
    supermemory_margin: float = 0.08

    # files
    content_dir: str = "content"
    data_dir: str = "api/data"
    log_path: str = ".data/qa-log.jsonl"
    log_retention_days: int = 30
    log_salt: str = "dev-salt-change-me"

    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> Settings:
        base = cls()
        origins = os.environ.get("ALLOWED_ORIGINS")
        return replace(
            base,
            chat_enabled=_bool("CHAT_ENABLED", base.chat_enabled),
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()) if origins else base.allowed_origins,
            model_id=os.environ.get("MODEL_ID", base.model_id),
            temperature=_float("TEMPERATURE", base.temperature),
            max_new_tokens=_int("MAX_NEW_TOKENS", base.max_new_tokens),
            rate_window_max=_int("RATE_WINDOW_MAX", base.rate_window_max),
            rate_day_max_ip=_int("RATE_DAY_MAX_IP", base.rate_day_max_ip),
            rate_day_max_global=_int("RATE_DAY_MAX_GLOBAL", base.rate_day_max_global),
            supermemory_api_key=os.environ.get("SUPERMEMORY_API_KEY", ""),
            supermemory_base_url=os.environ.get("SUPERMEMORY_BASE_URL", base.supermemory_base_url),
            supermemory_container=os.environ.get("SUPERMEMORY_CONTAINER", base.supermemory_container),
            supermemory_threshold=_float("SUPERMEMORY_THRESHOLD", base.supermemory_threshold),
            supermemory_margin=_float("SUPERMEMORY_MARGIN", base.supermemory_margin),
            content_dir=os.environ.get("CONTENT_DIR", base.content_dir),
            data_dir=os.environ.get("DATA_DIR", base.data_dir),
            log_path=os.environ.get("LOG_PATH", base.log_path),
            log_salt=os.environ.get("LOG_SALT", base.log_salt),
        )


def lens_layers(n_layers: int) -> list[int]:
    """Layers whose guesses the logit lens shows: 4, 10, 16, 22, 28 for a 28-layer model, scaled for others."""
    if n_layers == 28:
        return [4, 10, 16, 22, 28]
    picks = sorted({max(1, round(n_layers * f)) for f in (1 / 7, 5 / 14, 4 / 7, 11 / 14)} | {n_layers})
    return picks


def attention_layers(n_layers: int) -> list[int]:
    """0-based layer indices averaged for attention: layers 20 to 27 (1-based) of a 28-layer model, scaled for others."""
    start = int(round(n_layers * 19 / 28))
    end = int(round(n_layers * 27 / 28))
    end = max(end, start + 1)
    return list(range(start, min(end, n_layers)))
