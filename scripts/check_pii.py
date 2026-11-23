"""Test I4: Trey's content may hold public-resume-level facts only. Fails on phone numbers, street addresses,
birth dates and government ID numbers anywhere in the content folder (bio, notes, projects, resume, evals).

    python scripts/check_pii.py [content_dir]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "phone number": re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)"),
    "street address": re.compile(r"\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way|Pike)\b\.?"),
    "birth date": re.compile(r"\b(?:born|birthday|birth date|date of birth|DOB)\b[^.\n]{0,40}\d", re.I),
    "ID number": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
}


def scan(content: Path) -> list[str]:
    problems = []
    for path in sorted(content.rglob("*")):
        if path.suffix.lower() not in (".md", ".json", ".txt", ".yaml", ".yml") or "replays" in path.parts:
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            for kind, rx in PATTERNS.items():
                m = rx.search(line)
                if m:
                    problems.append(f"{path.relative_to(content)}:{n}: possible {kind}: {m.group(0)!r}")
    return problems


def main() -> None:
    content = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "content"
    if not content.exists():
        raise SystemExit(f"no content folder at {content}")
    problems = scan(content)
    if problems:
        print("Personal details found:\n  " + "\n  ".join(problems))
        raise SystemExit(1)
    print(f"No phone numbers, addresses, birth dates or ID numbers in {content}.")


if __name__ == "__main__":
    main()
