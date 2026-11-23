#!/usr/bin/env bash
# Screenshot the standalone background page. usage: shoot.sh <query> <out.png> [w] [h]
set -e
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
here="$(cd "$(dirname "$0")" && pwd)"
page_win="$(cygpath -w "$here/../background/site/index.html")"
out_win="$(cygpath -w "$(realpath -m "$2")")"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$(cygpath -w "$here/../previews/.chrome-profile")" --allow-file-access-from-files \
  --window-size="${3:-1440},${4:-900}" --virtual-time-budget=6000 --screenshot="$out_win" "file:///${page_win//\//}?$1" 2>/dev/null
echo "shot $2"
