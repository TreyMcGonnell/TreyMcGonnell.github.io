"""Calibrate the visualizer's neurons: which 14 per layer the towers show, how to scale them, and their labels.

    python scripts/pick_neurons.py            # writes api/data/neurons.npz and api/data/neuron_labels.json

Runs ~40 generic questions through the real prompt (with whatever bio and notes are in content/),
lets the model answer each greedily, and measures every MLP neuron on the answer tokens.
Re-run whenever the bio or notes change a lot, or the model changes.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.calibration import QUESTIONS, calibrate, calibration_sequences  # noqa: E402
from api.config import Settings  # noqa: E402
from api.inference import ModelRunner  # noqa: E402
from api.local import make_retriever, model_path, read_bio, resolve  # noqa: E402


def main() -> None:
    settings = Settings.from_env()
    t0 = time.time()
    runner = ModelRunner(model_path(settings))
    print(f"model loaded in {time.time() - t0:.1f}s on {runner.device}: {runner.n_layers} layers x {runner.n_mlp} neurons")
    seqs = calibration_sequences(runner, read_bio(settings), make_retriever(settings), QUESTIONS)
    print(f"{len(seqs)} calibration answers, {sum(len(s) - st for s, st in seqs)} positions")
    ns = calibrate(runner, seqs, per_layer=settings.neurons_per_layer)
    out = resolve(settings.data_dir)
    ns.save(out)
    print(f"saved {out / 'neurons.npz'} and {len(ns.labels)} labels in {time.time() - t0:.1f}s; "
          f"the strongest neuron is a shown window for {getattr(ns, 'coverage', 0):.0%} of calibration tokens")


if __name__ == "__main__":
    main()
