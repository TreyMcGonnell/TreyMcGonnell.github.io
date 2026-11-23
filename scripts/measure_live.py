"""Latency checks against a deployed gateway (tests G4, G5, G6). Every question costs GPU time.

    python scripts/measure_live.py https://<workspace>--trey-lm-gateway.modal.run --warm-runs 5
"""
from __future__ import annotations

import argparse
import json
import statistics
import time

import httpx


def ask(client: httpx.Client, base: str, q: str) -> dict:
    t0 = time.perf_counter()
    first = None
    tokens, text, phases = 0, [], []
    with client.stream("POST", f"{base}/api/chat", json={"q": q}, timeout=300) as r:
        r.raise_for_status()
        ev = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                d = json.loads(line[6:])
                if ev == "status":
                    phases.append(d["phase"])
                elif ev == "token":
                    tokens += 1
                    text.append(d["text"])
                    if first is None:
                        first = time.perf_counter() - t0
                elif ev == "error":
                    raise SystemExit(f"error event: {d}")
    total = time.perf_counter() - t0
    gen = total - (first or total)
    return {"first_token_s": round(first or total, 2), "total_s": round(total, 2), "tokens": tokens,
            "tokens_per_s": round((tokens - 1) / gen, 1) if gen > 0 and tokens > 1 else None,
            "waking": "waking" in phases, "answer": "".join(text)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--warm-runs", type=int, default=5)
    ap.add_argument("--cold", action="store_true", help="measure a cold start first (the GPU must be asleep)")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    with httpx.Client() as c:
        t0 = time.perf_counter()
        h = c.get(f"{base}/api/health", timeout=120).json()
        print(f"health in {time.perf_counter() - t0:.1f}s: {h}")
        if args.cold:
            if h["gpu_ready"]:
                print("the GPU is already awake; skipping the cold-start measurement")
            else:
                t0 = time.perf_counter()
                c.post(f"{base}/api/warm", timeout=60)
                while not c.get(f"{base}/api/health", timeout=60).json()["gpu_ready"]:
                    time.sleep(1)
                print(f"G5 cold start: model ready {time.perf_counter() - t0:.1f}s after the warm-up request")
        runs = [ask(c, base, q) for q in (["What is Trey McGonnell's major?", "What has Trey built?", "What clubs is Trey in?"] * 9)[: args.warm_runs]]
        firsts = [r["first_token_s"] for r in runs]
        rates = [r["tokens_per_s"] for r in runs if r["tokens_per_s"]]
        for r in runs:
            print(f"  first token {r['first_token_s']}s, {r['tokens']} tokens, {r['tokens_per_s']} tok/s{' (woke the GPU)' if r['waking'] else ''}: {r['answer'][:70]}")
        print(f"G4 first token: median {statistics.median(firsts):.2f}s, worst {max(firsts):.2f}s over {len(runs)} runs")
        if rates:
            print(f"G6 throughput: median {statistics.median(rates):.1f} tokens/s")


if __name__ == "__main__":
    main()
