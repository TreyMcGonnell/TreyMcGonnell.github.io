"""Runs Llama step by step and turns each forward pass into one visualizer frame.

Per generated token the frame carries:
  - the top 5 next words (the distribution actually sampled from, after temperature),
  - 14 fixed MLP neurons per layer (chosen offline by calibration), scaled to 0..255,
  - the strongest shown neuron (largest z-score against calibration statistics),
  - attention from the newest token, averaged over heads in the upper layers, grouped by prompt section,
  - the logit lens: what the model would say if it stopped at a few earlier layers.
"""
from __future__ import annotations

import base64
import json
import time
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch

from .config import attention_layers, lens_layers
from .prompt import PromptBuild

EVENT = tuple[str, dict]


@dataclass
class NeuronSet:
    indices: np.ndarray  # [L, K] int32: which neurons each tower shows, top window first
    lo: np.ndarray  # [L, K] float32: 5th percentile of each shown neuron during calibration
    hi: np.ndarray  # [L, K] float32: 99th percentile
    mean: np.ndarray  # [L, M] float32: mean of every neuron (for the top-neuron z-score)
    std: np.ndarray  # [L, M] float32
    labels: dict = field(default_factory=dict)  # "layer:index" (1-based layer) -> short description

    @property
    def per_layer(self) -> int:
        return int(self.indices.shape[1])

    def save(self, data_dir: str | Path) -> None:
        d = Path(data_dir)
        d.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(d / "neurons.npz", indices=self.indices, lo=self.lo, hi=self.hi, mean=self.mean, std=self.std)
        if self.labels:
            (d / "neuron_labels.json").write_text(json.dumps(self.labels, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, data_dir: str | Path) -> NeuronSet:
        d = Path(data_dir)
        z = np.load(d / "neurons.npz")
        labels_path = d / "neuron_labels.json"
        labels = json.loads(labels_path.read_text(encoding="utf-8")) if labels_path.exists() else {}
        return cls(z["indices"], z["lo"], z["hi"], z["mean"], z["std"], labels)

    @classmethod
    def exists(cls, data_dir: str | Path) -> bool:
        return (Path(data_dir) / "neurons.npz").exists()


def pick_dtype(device: str) -> torch.dtype:
    if device.startswith("cuda"):
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    return torch.float32


class ModelRunner:
    """Owns the model, its tokenizer and the activation hooks."""

    def __init__(self, model_or_path, tokenizer=None, device: str | None = None, dtype: torch.dtype | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        if isinstance(model_or_path, (str, Path)):
            from transformers import AutoModelForCausalLM, AutoTokenizer

            self.tokenizer = tokenizer or AutoTokenizer.from_pretrained(str(model_or_path))
            self.model = AutoModelForCausalLM.from_pretrained(
                str(model_or_path), torch_dtype=dtype or pick_dtype(self.device), attn_implementation="eager"
            )
        else:
            self.model, self.tokenizer = model_or_path, tokenizer
        self.model.to(self.device).eval()
        cfg = self.model.config
        self.n_layers = cfg.num_hidden_layers
        self.n_mlp = cfg.intermediate_size
        self.hidden = cfg.hidden_size
        self.vocab = cfg.vocab_size
        self.lens = lens_layers(self.n_layers)
        self.attn_layers = attention_layers(self.n_layers)
        self.special_ids = set(int(i) for i in (self.tokenizer.all_special_ids or []))
        self.special_ids |= {i for i in range(128000, 128256)} if self.vocab >= 128256 else set()
        eos = getattr(self.model.generation_config, "eos_token_id", None) or self.tokenizer.eos_token_id
        self.eos_ids = set(eos if isinstance(eos, (list, tuple)) else [eos]) | {
            i for i in (self.tokenizer.convert_tokens_to_ids(t) for t in ("<|eot_id|>", "<|end_of_text|>", "<|eom_id|>"))
            if isinstance(i, int) and i >= 0 and i != self.tokenizer.unk_token_id
        }
        self._capture = False
        self._all_positions = False
        self._acts: list[torch.Tensor | None] = [None] * self.n_layers
        for i, layer in enumerate(self.model.model.layers):
            layer.mlp.down_proj.register_forward_pre_hook(self._hook(i))

    def to(self, device: str) -> ModelRunner:
        """Move to another device (Modal loads on CPU for the memory snapshot, then moves to the GPU)."""
        self.model.to(device)
        self.device = device
        return self

    def _hook(self, i: int):
        def hook(_module, args):
            if self._capture:
                x = args[0]
                self._acts[i] = (x[0] if self._all_positions else x[0, -1]).detach().float()
        return hook

    def meta(self, *, model_name: str, temperature: float, per_layer: int) -> dict:
        return {
            "v": 1, "model": model_name, "layers": self.n_layers, "hidden": self.hidden, "mlp": self.n_mlp,
            "vocab": self.vocab, "temperature": temperature, "neurons_per_layer": per_layer, "lens_layers": list(self.lens),
        }

    # ---- calibration support: activations of every neuron at every position of a sequence ----
    @torch.no_grad()
    def activations(self, ids: list[int]) -> torch.Tensor:
        """[L, T, M] float32 on the model's device."""
        self._capture, self._all_positions = True, True
        try:
            self.model(input_ids=torch.tensor([ids], device=self.device))
        finally:
            self._capture, self._all_positions = False, False
        return torch.stack([a for a in self._acts])  # type: ignore[misc]

    @torch.no_grad()
    def greedy(self, ids: list[int], max_new_tokens: int) -> list[int]:
        out = self.model.generate(
            input_ids=torch.tensor([ids], device=self.device), attention_mask=torch.ones(1, len(ids), device=self.device, dtype=torch.long),
            max_new_tokens=max_new_tokens, do_sample=False, eos_token_id=list(self.eos_ids), pad_token_id=list(self.eos_ids)[0],
        )
        return out[0, len(ids):].tolist()

    # ---- live generation ----
    @torch.no_grad()
    def stream(self, build: PromptBuild, neurons: NeuronSet, *, temperature: float, top_p: float,
               max_new_tokens: int, seed: int | None = None) -> Iterator[EVENT]:
        tok = self.tokenizer
        dev = self.device
        P = build.total
        ids = torch.tensor([build.ids], device=dev)
        idx = torch.as_tensor(neurons.indices, device=dev, dtype=torch.long)
        lo = torch.as_tensor(neurons.lo, device=dev)
        span = torch.clamp(torch.as_tensor(neurons.hi, device=dev) - lo, min=1e-6)
        mean = torch.as_tensor(neurons.mean, device=dev)
        std = torch.as_tensor(neurons.std, device=dev)
        std = torch.maximum(std, std.median(dim=1, keepdim=True).values * 0.25)  # ignore near-dead neurons
        shown_mean, shown_std = torch.gather(mean, 1, idx), torch.gather(std, 1, idx)
        # every position's source as a small integer, and which positions are special tokens (excluded from attention)
        names = list(dict.fromkeys(build.positions_src)) + ["answer"]
        ANSWER = len(names) - 1
        src_idx = np.array([names.index(s) for s in build.positions_src] + [ANSWER] * (max_new_tokens + 1), dtype=np.int64)
        keep_pos = np.array([t not in self.special_ids for t in build.ids] + [True] * (max_new_tokens + 1), dtype=np.float32)

        # Prefill everything but the last prompt token, so the first frame's attention is a single query row.
        t0 = time.perf_counter()
        out = self.model(input_ids=ids[:, :-1], use_cache=True)
        if dev.startswith("cuda"):
            torch.cuda.synchronize()
        yield "prefill", {"ms": round((time.perf_counter() - t0) * 1000, 1), "tokens": P}

        past = out.past_key_values
        step_input = ids[:, -1:]
        gen: list[int] = []
        texts: list[str] = []
        shown = ""
        share_sum: dict[str, float] = defaultdict(float)
        n_frames = 0
        gen_t0 = time.perf_counter()
        generator = None
        if seed is not None:
            generator = torch.Generator(device=dev).manual_seed(seed)

        for i in range(max_new_tokens):
            self._capture = True
            try:
                out = self.model(input_ids=step_input, past_key_values=past, use_cache=True,
                                 output_hidden_states=True, output_attentions=True)
            finally:
                self._capture = False
            past = out.past_key_values
            logits = out.logits[0, -1].float()
            probs = torch.softmax(logits / max(temperature, 1e-4), dim=-1)

            # sample with nucleus (top-p) filtering
            sp, si = torch.sort(probs, descending=True)
            keep = torch.cumsum(sp, 0) - sp < top_p
            keep[0] = True
            filt = sp * keep
            choice = int(si[torch.multinomial(filt / filt.sum(), 1, generator=generator)].item())

            if choice in self.eos_ids:
                break

            # top 5 shown as the model's odds
            top_p5, top_i5 = sp[:5], si[:5]
            topk = [{"text": tok.decode([int(t)]), "p": round(float(p), 4)} for p, t in zip(top_p5, top_i5, strict=False)]

            # neurons: the fixed displayed set, scaled into 0..255
            acts = torch.stack(self._acts)  # [L, M]
            shown_acts = torch.gather(acts, 1, idx)
            scaled = torch.clamp((shown_acts - lo) / span, 0, 1)
            neuron_bytes = (scaled * 255).round().to(torch.uint8).cpu().numpy().tobytes()
            # The callout names the strongest of the shown windows (z-score against calibration), so its line
            # always lands on a real window. Whenever the strongest neuron in the whole model is shown, it is this one.
            z = (shown_acts - shown_mean) / shown_std
            flat = int(torch.argmax(z).item())
            t_layer, t_row = divmod(flat, idx.shape[1])
            t_index = int(neurons.indices[t_layer][t_row])
            top = {"layer": t_layer + 1, "index": t_index, "row": t_row}
            label = neurons.labels.get(f"{t_layer + 1}:{t_index}")
            if label:
                top["label"] = label

            # attention from the newest token: mean over heads and upper layers; drop special tokens and renormalize
            att = torch.stack([out.attentions[layer][0, :, -1, :].float().mean(0) for layer in self.attn_layers]).mean(0)
            kv = att.shape[0]
            all_ids = build.ids + gen
            att_cpu = att.cpu().numpy() * keep_pos[:kv]
            att_cpu = att_cpu / max(float(att_cpu.sum()), 1e-9)
            shares = np.bincount(src_idx[:kv], weights=att_cpu, minlength=len(names))
            per_src = {names[j]: float(w) for j, w in enumerate(shares) if w > 0}
            looking = sorted(({"src": s, "w": round(w, 4)} for s, w in per_src.items()), key=lambda d: -d["w"])
            for s, w in per_src.items():
                share_sum[s] += w
            n_frames += 1
            chips = []
            strongest = np.argpartition(-att_cpu, min(24, kv - 1))[:24]  # the 24 largest, then in order
            for k in strongest[np.argsort(-att_cpu[strongest])]:
                if len(chips) == 6 or att_cpu[k] <= 0:
                    break
                text = tok.decode([all_ids[int(k)]])
                if not text.strip():
                    continue
                chips.append({"text": text, "src": names[src_idx[int(k)]], "w": round(float(att_cpu[k]), 4)})

            # logit lens: earlier layers through the final norm and the output head; the last layer is the real answer
            lens = []
            for layer in self.lens:
                if layer >= self.n_layers:
                    lid = int(torch.argmax(logits).item())
                else:
                    h = out.hidden_states[layer][0, -1]
                    lid = int(torch.argmax(self.model.lm_head(self.model.model.norm(h))).item())
                lens.append({"layer": layer, "text": tok.decode([lid])})

            gen.append(choice)
            full = tok.decode(gen, skip_special_tokens=True)
            delta = full[len(shown):] if full.startswith(shown) else tok.decode([choice])
            shown = full
            texts.append(delta)
            yield "token", {
                "i": i, "id": choice, "text": delta, "p": round(float(probs[choice]), 4), "topk": topk,
                "neurons": base64.b64encode(neuron_bytes).decode("ascii"), "top_neuron": top,
                "attention": chips, "looking_at": looking, "logit_lens": lens,
            }
            step_input = torch.tensor([[choice]], device=dev)

        if dev.startswith("cuda"):
            torch.cuda.synchronize()
        sources = sorted(({"src": s, "share": round(v / max(1, n_frames), 4)} for s, v in share_sum.items()), key=lambda d: -d["share"])
        yield "done", {"tokens": n_frames, "ms": round((time.perf_counter() - gen_t0) * 1000, 1), "sources": sources}
