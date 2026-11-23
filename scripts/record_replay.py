"""Record a replay from the real pipeline (same gateway, model and notes as live answers).

    python scripts/record_replay.py "What is Trey studying?"            # content/replays/what-is-trey-studying.json
    python scripts/record_replay.py "What is Trey studying?" --seed 7

Every event is validated against protocol/frame.schema.json before the file is written (tests B2, C6).
Replays hold Trey's content, so they live in the private content repo, never in the public one.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jsonschema  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.config import Settings  # noqa: E402
from api.local import resolve  # noqa: E402
from api.serve_local import build_app  # noqa: E402


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("question")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    settings = Settings.from_env()
    schema = json.loads((ROOT / "protocol" / "frame.schema.json").read_text(encoding="utf-8"))
    app = build_app(settings)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        client.post("/api/warm")
        t_wait = time.time()
        while not client.get("/api/health").json()["gpu_ready"]:
            if time.time() - t_wait > 300:
                raise SystemExit("model did not load: " + str(client.get("/api/health").json().get("model_error")))
            time.sleep(0.5)
        tokens = client.get("/api/tokenize", params={"q": args.question}).json()
        events, t0, ev = [], time.perf_counter(), None
        with client.stream("POST", "/api/chat", json={"q": args.question, "seed": args.seed}) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if line.startswith("event: "):
                    ev = line[7:]
                elif line.startswith("data: ") and ev:
                    item = {"event": ev, "t": round((time.perf_counter() - t0) * 1000, 1), "data": json.loads(line[6:])}
                    jsonschema.validate(item, schema)
                    events.append(item)
                    ev = None
    if not any(e["event"] == "done" for e in events):
        raise SystemExit("the answer did not finish; nothing written")
    replay = {
        "v": 1,
        "question": args.question,
        "question_tokens": {"ids": tokens["ids"], "pieces": tokens["pieces"]},
        "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "seed": args.seed,
        "events": events,
    }
    out = Path(args.out) if args.out else resolve(settings.content_dir) / "replays" / f"{slug(args.question)}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(replay, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    answer = "".join(e["data"]["text"] for e in events if e["event"] == "token")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {sum(e['event'] == 'token' for e in events)} tokens)")
    print("answer:", answer)


if __name__ == "__main__":
    main()
