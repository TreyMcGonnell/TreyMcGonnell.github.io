"""Frame builder tests (A3, A4, B1 on real frames) using a tiny randomly initialized Llama with the real tokenizer.

The tiny model runs on CPU in seconds, so CI can run these with only the tokenizer files.
Test G6 (speed with hooks on the real 3B model) lives in test_gpu.py and needs a GPU.
"""
import base64
import os
from pathlib import Path

import jsonschema
import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")

from api.calibration import calibrate  # noqa: E402
from api.config import attention_layers, lens_layers  # noqa: E402
from api.inference import ModelRunner  # noqa: E402
from api.local import DEFAULT_MODEL_DIR  # noqa: E402
from api.prompt import Passage, build_prompt  # noqa: E402

from .conftest import BIO, SCHEMA  # noqa: E402

MODEL_DIR = Path(os.environ.get("MODEL_PATH") or DEFAULT_MODEL_DIR)
pytestmark = [pytest.mark.model, pytest.mark.skipif(not (MODEL_DIR / "tokenizer.json").exists(), reason="Llama tokenizer not downloaded")]


@pytest.fixture(scope="module")
def tiny():
    tok = transformers.AutoTokenizer.from_pretrained(str(MODEL_DIR))
    cfg = transformers.LlamaConfig(vocab_size=len(tok), hidden_size=64, intermediate_size=96, num_hidden_layers=8,
                                   num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=4096,
                                   bos_token_id=tok.bos_token_id, eos_token_id=tok.convert_tokens_to_ids("<|eot_id|>"),
                                   tie_word_embeddings=True)
    torch.manual_seed(0)
    model = transformers.LlamaForCausalLM(cfg).eval()
    model.config._attn_implementation = "eager"
    runner = ModelRunner(model, tokenizer=tok, device="cpu")
    build = build_prompt(tok, BIO, [Passage("projects/sample.md", "S", "SAMPLE. Trey built a sample tool.", 0.8)], "What has Trey built?")
    neurons = calibrate(runner, [(build.ids + [tok.encode(" sample", add_special_tokens=False)[0]] * 4, build.total - 1)], per_layer=6)
    return runner, build, neurons


def collect(runner, build, neurons, n=6):
    return list(runner.stream(build, neurons, temperature=0.7, top_p=0.9, max_new_tokens=n, seed=3))


def test_layer_selections_scale_with_model_depth():
    assert lens_layers(28) == [4, 10, 16, 22, 28]
    assert attention_layers(28) == list(range(19, 27))  # layers 20..27, 1-based
    assert lens_layers(8)[-1] == 8 and all(1 <= x <= 8 for x in lens_layers(8))


def test_a3_frame_builder(tiny):
    runner, build, neurons = tiny
    events = collect(runner, build, neurons)
    assert events[0][0] == "prefill" and events[-1][0] == "done"
    tokens = [d for e, d in events if e == "token"]
    assert tokens
    for f in tokens:
        ps = [k["p"] for k in f["topk"]]
        assert ps == sorted(ps, reverse=True) and sum(ps) <= 1.0001 and len(ps) == 5
        raw = base64.b64decode(f["neurons"])
        assert len(raw) == runner.n_layers * neurons.per_layer and all(0 <= b <= 255 for b in raw)
        assert [x["layer"] for x in f["logit_lens"]] == lens_layers(runner.n_layers)
        assert 1 <= f["top_neuron"]["layer"] <= runner.n_layers and 0 <= f["top_neuron"]["index"] < runner.n_mlp


def test_a4_looking_at_sums_to_one_and_names_real_sections(tiny):
    runner, build, neurons = tiny
    sources = set(build.positions_src) | {"answer"}
    for e, f in collect(runner, build, neurons):
        if e != "token":
            continue
        assert abs(sum(x["w"] for x in f["looking_at"]) - 1.0) < 0.01
        assert all(x["src"] in sources for x in f["looking_at"])
        assert all(a["src"] in sources for a in f["attention"])


def test_b1_real_frames_match_the_schema(tiny):
    runner, build, neurons = tiny
    for e, d in collect(runner, build, neurons):
        jsonschema.validate({"event": e, "data": d}, SCHEMA)
    meta = runner.meta(model_name="tiny", temperature=0.7, per_layer=neurons.per_layer)
    jsonschema.validate({"event": "meta", "data": meta}, SCHEMA)


def test_same_seed_same_answer(tiny):
    runner, build, neurons = tiny
    a = [d["id"] for e, d in collect(runner, build, neurons) if e == "token"]
    b = [d["id"] for e, d in collect(runner, build, neurons) if e == "token"]
    assert a == b


def test_neuron_set_round_trips(tiny, tmp_path):
    from api.inference import NeuronSet

    _, _, neurons = tiny
    neurons.save(tmp_path)
    loaded = NeuronSet.load(tmp_path)
    assert (loaded.indices == neurons.indices).all() and loaded.labels == neurons.labels
