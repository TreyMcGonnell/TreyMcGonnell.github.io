#!/usr/bin/env bash
# Wrap background/skyline.html (an artifact-style fragment) into a complete page GitHub Pages can serve.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../background/skyline.html"; out="$here/../background/site/index.html"
mkdir -p "$(dirname "$out")"
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<style>body{margin:0}</style>\n</head>\n<body>\n'
  cat "$src"
  printf '\n</body>\n</html>\n'
} > "$out"
echo "wrote $out"
