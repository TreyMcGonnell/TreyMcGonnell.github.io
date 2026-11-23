"""Real-model checks on a CUDA GPU: G6 (speed with hooks on) and schema validity of real frames.

Skipped automatically without a GPU, the downloaded weights, or the neuron calibration.
"""
import os
import time
from pathlib import Path

import jsonschema
import pytest

torch = pytest.importorskip("torch")

from api.config import Settings  # noqa: E402
from api.inference import ModelRunner, NeuronSet  # noqa: E402
from api.local import DEFAULT_MODEL_DIR, make_retriever, read_bio, resolve  # noqa: E402
from api.memory import retrieve  # noqa: E402
from api.prompt import build_prompt  # noqa: E402

from .conftest import SCHEMA  # noqa: E402

MODEL_DIR = Path(os.environ.get("MODEL_PATH") or DEFAULT_MODEL_DIR)
DATA_DIR = resolve(Settings().data_dir)
pytestmark = [
    pytest.mark.gpu,
    pytest.mark.skipif(not torch.cuda.is_available(), reason="no CUDA GPU"),
    pytest.mark.skipif(not any(MODEL_DIR.glob("*.safetensors")), reason="weights not downloaded"),
    pytest.mark.skipif(not NeuronSet.exists(DATA_DIR), reason="run scripts/pick_neurons.py first"),
]


@pytest.fixture(scope="module")
def setup():
    settings = Settings()
    runner = ModelRunner(str(MODEL_DIR))
    neurons = NeuronSet.load(DATA_DIR)
    found = retrieve(make_retriever(settings), "What has Trey built?", limit=4, use=3, threshold=settings.retrieval_threshold, timeout_s=5)
    build = build_prompt(runner.tokenizer, read_bio(settings), found.used, "What has Trey built?")
    return runner, neurons, build


def test_g6_speed_with_hooks_on(setup):
    runner, neurons, build = setup
    list(runner.stream(build, neurons, temperature=0.7, top_p=0.9, max_new_tokens=8, seed=1))  # warm-up
    t0 = time.perf_counter()
    events = list(runner.stream(build, neurons, temperature=0.7, top_p=0.9, max_new_tokens=80, seed=1))
    dt = time.perf_counter() - t0
    n = sum(1 for e, _ in events if e == "token")
    rate = n / dt
    print(f"\nG6: {n} tokens in {dt:.2f}s = {rate:.1f} tokens/s on {torch.cuda.get_device_name()}; prompt {build.total} tokens")
    print("answer:", "".join(d["text"] for e, d in events if e == "token"))
    assert rate >= 15


def test_real_frames_validate_and_point_at_notes(setup):
    runner, neurons, build = setup
    events = list(runner.stream(build, neurons, temperature=0.7, top_p=0.9, max_new_tokens=40, seed=2))
    for e, d in events:
        jsonschema.validate({"event": e, "data": d}, SCHEMA)
    tokens = [d for e, d in events if e == "token"]
    assert tokens
    note_share = sum(x["w"] for f in tokens for x in f["looking_at"] if x["src"].startswith("note:")) / len(tokens)
    print(f"\naverage attention share on Supermemory notes: {note_share:.2%}")
    assert all(abs(sum(x["w"] for x in f["looking_at"]) - 1) < 0.01 for f in tokens)
