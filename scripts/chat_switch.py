"""The kill switch (test J4): turn the live chat off or on without a deploy. The site falls back to replays.

    python scripts/chat_switch.py off     # visitors see "The chat is turned off right now" within about 10 s
    python scripts/chat_switch.py on
    python scripts/chat_switch.py         # show the current state

Needs the Modal CLI login (modal token new / modal token set).
"""
from __future__ import annotations

import sys

import modal


def main() -> None:
    state = modal.Dict.from_name("trey-lm-state", create_if_missing=True)
    arg = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if arg in ("on", "off"):
        state.put("chat_enabled", "true" if arg == "on" else "false")
    value = str(state.get("chat_enabled", "true")).lower()
    print("chat is", "OFF (replays only)" if value in ("false", "0", "off") else "ON")


if __name__ == "__main__":
    main()
