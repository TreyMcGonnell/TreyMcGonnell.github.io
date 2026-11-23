"""B2: every replay in the content repo validates, is small, and plays to the end. C6: it came from the real pipeline."""
import gzip
import json
import os
from pathlib import Path

import jsonschema
import pytest

from .conftest import ROOT, SCHEMA

CONTENT = Path(os.environ.get("CONTENT_DIR") or ROOT / "content")
REPLAYS = sorted((CONTENT / "replays").glob("*.json")) if (CONTENT / "replays").exists() else []
pytestmark = pytest.mark.skipif(not REPLAYS, reason="no replays in the content folder")


@pytest.mark.parametrize("path", REPLAYS, ids=[p.name for p in REPLAYS])
def test_b2_replay_is_valid_small_and_complete(path):
    raw = path.read_bytes()
    assert len(gzip.compress(raw)) <= 300 * 1024
    replay = json.loads(raw)
    assert replay["v"] == 1 and replay["question"] and replay["question_tokens"]["pieces"]
    for item in replay["events"]:
        jsonschema.validate(item, SCHEMA)
    names = [e["event"] for e in replay["events"]]
    assert names[0] == "meta" and "retrieval" in names and "prompt" in names and "token" in names and "done" in names
    assert "error" not in names
    times = [e["t"] for e in replay["events"]]
    assert times == sorted(times)


@pytest.mark.parametrize("path", REPLAYS, ids=[p.name for p in REPLAYS])
def test_c6_replay_matches_the_real_model(path):
    replay = json.loads(path.read_bytes())
    meta = next(e["data"] for e in replay["events"] if e["event"] == "meta")
    assert meta["layers"] == 28 and meta["vocab"] == 128256 and meta["mlp"] == 8192
    assert replay.get("seed") is not None and replay.get("recorded_at")
