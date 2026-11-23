"""Sync Trey's notes and project write-ups to Supermemory (run by CI with the private content repo).

    SUPERMEMORY_API_KEY=... python scripts/sync_notes.py                 # content/ next to this repo
    python scripts/sync_notes.py --content ../trey-lm-content --dry-run  # list what would change

Uses Supermemory's v5 API: each file is one document in the "trey-lm" namespace with id "<folder>:<name>"
(ids allow letters, digits, "-", "_" and ":") and metadata {file, title, hash}. Reusing an id appends rather than
replaces, so a changed file is deleted and added again; unchanged files are skipped; documents whose file is gone
are deleted. Files marked `sample: true` are never uploaded. Only documents this script created (they carry
metadata.file) are ever changed or deleted, so anything added by hand in the Supermemory app is left alone.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.memory import _strip_frontmatter  # noqa: E402

NAMESPACE = os.environ.get("SUPERMEMORY_CONTAINER", "trey-lm")


def doc_id(rel: str) -> str:
    folder, name = rel.split("/", 1)
    return f"{folder}:{Path(name).stem}"


def collect(content: Path) -> dict[str, dict]:
    docs = {}
    for sub in ("notes", "projects"):
        for p in sorted((content / sub).glob("*.md")):
            meta, body = _strip_frontmatter(p.read_text(encoding="utf-8"))
            if meta.get("sample", "").lower() == "true":
                continue  # placeholder text: keep it out of the model's memory
            rel = f"{sub}/{p.name}"
            title = meta.get("title", p.stem)
            text = f"{title}\n\n{body}"
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
            docs[doc_id(rel)] = {"id": doc_id(rel), "content": text, "metadata": {"file": rel, "title": title, "hash": digest}}
    return docs


def existing(c) -> dict[str, dict]:
    found, page = {}, 1
    while True:
        r = c.post(f"/ns/{NAMESPACE}/list/documents", params={"page": page, "limit": 100}, json={})
        r.raise_for_status()
        data = r.json()
        for d in data.get("documents", []):
            if (d.get("metadata") or {}).get("file"):  # created by this script; hand-added documents are not ours
                found[d["id"]] = d
        if not (data.get("pagination") or {}).get("hasMore"):
            return found
        page += 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--content", default=os.environ.get("CONTENT_DIR", "content"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--wait", type=int, default=180, help="seconds to wait for Supermemory to finish indexing")
    args = ap.parse_args()
    docs = collect(Path(args.content))
    key = os.environ.get("SUPERMEMORY_API_KEY", "")
    if not key:
        for d in docs.values():
            print(f"would sync {d['metadata']['file']} ({len(d['content'].split())} words)")
        print("SUPERMEMORY_API_KEY not set: nothing sent")
        return

    import httpx

    base = os.environ.get("SUPERMEMORY_BASE_URL", "https://api.supermemory.ai")
    with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {key}"}, timeout=30) as c:
        have = existing(c)
        stale = [i for i, d in have.items() if i not in docs or (d.get("metadata") or {}).get("hash") != docs[i]["metadata"]["hash"]]
        new = [i for i in docs if i not in have or i in stale]
        if not stale and not new:
            print(f"Supermemory is up to date ({len(docs)} documents).")
            return
        for i in stale:
            print(f"{'would ' if args.dry_run else ''}{'replace' if i in docs else 'delete'} {i}")
        for i in new:
            if i not in stale:
                print(f"{'would ' if args.dry_run else ''}add {i}")
        if args.dry_run:
            return
        if stale:
            r = c.request("DELETE", f"/ns/{NAMESPACE}/document", json={"ids": stale})
            r.raise_for_status()
            errors = r.json().get("errors") or []
            if errors:
                raise SystemExit(f"Supermemory could not delete: {errors}")
        for i in new:
            c.post(f"/ns/{NAMESPACE}/document", json=docs[i]).raise_for_status()
        # wait until the new documents are searchable
        deadline, pending = time.time() + args.wait, set(new)
        while pending and time.time() < deadline:
            time.sleep(3)
            for i, d in existing(c).items():
                status = (d.get("system") or {}).get("status")
                if i in pending and status in ("done", "failed"):
                    if status == "failed":
                        print(f"indexing failed for {i}")
                    pending.discard(i)
        print(f"synced {len(new)} added, {len(stale)} removed or replaced" + (f"; still indexing: {sorted(pending)}" if pending else ""))


if __name__ == "__main__":
    main()
