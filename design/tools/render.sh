#!/usr/bin/env bash
# Screenshot a local HTML page with headless Chrome.
# usage: render.sh <page.html> <out.png> [width] [height]
set -e
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
here="$(cd "$(dirname "$0")" && pwd)"
prof="$here/../previews/.chrome-profile"
mkdir -p "$prof"
page_win="$(cygpath -w "$(realpath "$1")")"
out_win="$(cygpath -w "$(realpath -m "$2")")"
url="file:///${page_win//\\//}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$(cygpath -w "$prof")" --allow-file-access-from-files \
  --window-size="${3:-1440},${4:-900}" --virtual-time-budget=8000 --screenshot="$out_win" "$url" 2>/dev/null
echo "rendered $2"
