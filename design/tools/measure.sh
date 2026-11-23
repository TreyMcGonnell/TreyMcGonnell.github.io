#!/usr/bin/env bash
# Print the on-screen boxes [left, top, right, bottom] of CSS selectors in a previewed artboard.
# usage: measure.sh <Name> '<selector>||<selector>...'
set -e
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
node tools/dc_preview.mjs "canvas/project/$1.dc.html" "previews/$1.html" \
  fc7316b34c6c3646f08120ea5d629e50=../skyline/out/skyline-awake.svg \
  661228b075cce31874258f41de49b1aa=../skyline/out/skyline-warming.svg >/dev/null
page_win="$(cygpath -w "$(realpath "previews/$1.html")")"
hash="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$2")"
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$(cygpath -w "$here/../previews/.chrome-profile")" --allow-file-access-from-files \
  --window-size=1440,900 --virtual-time-budget=8000 --dump-dom "file:///${page_win//\//}#$hash" 2>/dev/null \
  | sed -n 's:.*<pre id="measure">\(.*\)</pre>.*:\1:p' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s.replace(/&quot;/g,"\"").replace(/&amp;/g,"&"));for(const[k,v]of Object.entries(o))console.log(k.padEnd(48).slice(0,48),JSON.stringify(v))})'
