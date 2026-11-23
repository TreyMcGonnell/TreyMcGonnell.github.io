#!/usr/bin/env bash
# Build a local preview of one artboard and screenshot it.
# usage: preview.sh <Name> [height]   (renders canvas/project/<Name>.dc.html -> previews/<Name>.png)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
node tools/dc_preview.mjs "canvas/project/$1.dc.html" "previews/$1.html" \
  fc7316b34c6c3646f08120ea5d629e50=../skyline/out/skyline-awake.svg \
  661228b075cce31874258f41de49b1aa=../skyline/out/skyline-warming.svg
bash tools/render.sh "previews/$1.html" "previews/$1.png" 1440 "${2:-900}"
