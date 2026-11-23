"""Write the 56-number embedding preview the Typing screen shows for each token.

    python scripts/make_embed_preview.py      # writes api/data/embed_preview.npy (+ .json with the color scale)

Derived from the model's weights, so it is never committed (api/data/ is gitignored).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from safetensors import safe_open  # noqa: E402

from api.config import Settings  # noqa: E402
from api.local import model_path, resolve  # noqa: E402

DIMS = 56


def main() -> None:
    settings = Settings.from_env()
    path = Path(model_path(settings))
    weight = None
    for f in sorted(path.glob("*.safetensors")):
        with safe_open(str(f), framework="pt") as st:
            if "model.embed_tokens.weight" in st.keys():
                weight = st.get_slice("model.embed_tokens.weight")[:, :DIMS].float().numpy()
                break
    if weight is None:
        raise SystemExit("embedding matrix not found in the model files")
    out = resolve(settings.data_dir)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "embed_preview.npy", weight.astype(np.float16))
    scale = float(np.percentile(np.abs(weight), 99))
    (out / "embed_preview.json").write_text(json.dumps({"dims": DIMS, "scale": scale}), encoding="utf-8")
    print(f"saved {weight.shape} preview, color scale {scale:.4f}")


if __name__ == "__main__":
    main()
