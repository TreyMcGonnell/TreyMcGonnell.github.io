"""Publish everything from this PC: Supermemory notes, the Modal API, and the website on GitHub Pages.

    python scripts/deploy.py              # all three
    python scripts/deploy.py site         # only the website (or: notes, api; several are fine)
    python scripts/deploy.py --dry-run    # run the checks and build, change nothing online

Private content never goes into the repo. It lives in content/ and api/data/ on this PC (both gitignored).
- notes: content/notes and content/projects are synced to Supermemory.
- api:   Modal receives the code plus content/ and api/data/ inside its private image.
- site:  the built website (only what visitors can see) is force-pushed as a single commit to the gh-pages
         branch, which GitHub Pages serves. The main branch stays code-only.

Keys are read from the environment or from ~/.trey-lm/secrets.env (outside the repo), never from the repo:
    SUPERMEMORY_API_KEY=...       (Modal uses its own login: modal token new)
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
API_BASE = os.environ.get("TREY_LM_API_BASE", "https://treymcgonnell--trey-lm-gateway.us-east.modal.run")
SECRETS = Path.home() / ".trey-lm" / "secrets.env"
NPM = "npm.cmd" if os.name == "nt" else "npm"
PY = sys.executable


def run(cmd: list[str], cwd: Path = ROOT, env: dict | None = None) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, check=True)


def load_secrets() -> None:
    if SECRETS.exists():
        for line in SECRETS.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def checks(strict: bool) -> None:
    run([PY, "scripts/check_pii.py", "content"])
    run([NPM, "run", "-s", "check:hygiene"], cwd=WEB)
    if not (ROOT / "api" / "data" / "neurons.npz").exists():
        raise SystemExit("api/data/neurons.npz is missing: run scripts/pick_neurons.py first")


def notes(dry: bool) -> None:
    if not os.environ.get("SUPERMEMORY_API_KEY"):
        raise SystemExit(f"SUPERMEMORY_API_KEY is not set (environment or {SECRETS})")
    run([PY, "scripts/sync_notes.py"] + (["--dry-run"] if dry else []))


def api(dry: bool) -> None:
    modal = shutil.which("modal") or str(Path(PY).with_name("modal.exe" if os.name == "nt" else "modal"))
    if dry:
        print("(dry run) would run: modal deploy api/modal_app.py")
        return
    run([modal, "deploy", "api/modal_app.py"], env={"PYTHONIOENCODING": "utf-8"})


def site(dry: bool, strict: bool) -> None:
    run([NPM, "run", "build"], cwd=WEB, env={"VITE_API_BASE": API_BASE})
    run([NPM, "run", "-s", "check:size"], cwd=WEB)
    run([NPM, "run", "-s", "check:links"], cwd=WEB)
    try:
        run([NPM, "run", "-s", "check:content"], cwd=WEB)
    except subprocess.CalledProcessError:
        if strict:
            raise SystemExit("placeholder text found in the built site; replace the sample content first") from None
        print("WARNING: the site still contains sample or placeholder text (publishing anyway; use --strict to stop)")
    if dry:
        print(f"(dry run) built web/dist for {API_BASE}; not pushed")
        return
    origin = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="trey-lm-pages-") as tmp:
        out = Path(tmp) / "site"
        shutil.copytree(WEB / "dist", out)
        (out / ".nojekyll").write_text("", encoding="utf-8")  # serve files as they are; no Jekyll processing
        run(["git", "init", "-q", "-b", "gh-pages"], cwd=out)
        run(["git", "add", "-A"], cwd=out)
        run(["git", "-c", "user.name=trey-lm deploy", "-c", "user.email=deploy@users.noreply.github.com",
             "commit", "-q", "-m", f"Publish site {datetime.now():%Y-%m-%d %H:%M}"], cwd=out)
        # one commit, replaced every time: nothing old lingers in the branch history
        run(["git", "push", "--force", origin, "gh-pages"], cwd=out)
    print("Published. GitHub Pages serves it from the gh-pages branch within a minute or two.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parts", nargs="*", choices=["notes", "api", "site"], default=[])
    ap.add_argument("--dry-run", action="store_true", help="check and build only; change nothing online")
    ap.add_argument("--strict", action="store_true", help="refuse to publish a site with placeholder text")
    args = ap.parse_args()
    parts = args.parts or ["notes", "api", "site"]
    load_secrets()
    checks(args.strict)
    if "notes" in parts:
        notes(args.dry_run)
    if "api" in parts:
        api(args.dry_run)
    if "site" in parts:
        site(args.dry_run, args.strict)


if __name__ == "__main__":
    main()
