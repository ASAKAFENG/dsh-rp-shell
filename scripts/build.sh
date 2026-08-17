#!/bin/bash
# Build dsh-rp-shell: pure-JS plugin (zero compile step), syntax-check lib/ and
# link the @deepseek-ai runtime dependencies into local node_modules (same
# vendoring pattern as dsh-qq-remote / dsh-tdai-memory / dsh-paper-tutor).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Syntax check ==="
node --check lib/index.js
node --check preset/rp-shell/rp-commands.mjs

# Locate the DSH runtime node_modules (npx cache): explicit
# DSH_APP_NODE_MODULES wins, else the newest npx cache holding schemastery.
APP_NM="${DSH_APP_NODE_MODULES:-}"
if [ -z "$APP_NM" ]; then
  for cand in $(ls -dt "$HOME"/.npm/_npx/*/node_modules 2>/dev/null); do
    if [ -d "$cand/@deepseek-ai/schemastery" ]; then APP_NM="$cand"; break; fi
  done
fi
if [ -z "$APP_NM" ] || [ ! -d "$APP_NM/@deepseek-ai" ]; then
  echo "build: cannot locate DSH runtime node_modules (set DSH_APP_NODE_MODULES)" >&2
  exit 1
fi

link_pkg() {
  local name="$1"
  local target="$APP_NM/$name"
  if [ ! -e "$target" ]; then
    echo "build: missing dependency target: $target" >&2
    exit 1
  fi
  mkdir -p "node_modules/$(dirname "$name")"
  rm -rf "node_modules/$name"
  ln -sfn "$(realpath "$target")" "node_modules/$name"
  echo "link: node_modules/$name -> $target"
}

echo "=== Linking runtime dependencies (app node_modules: $APP_NM) ==="
link_pkg @deepseek-ai/schemastery

echo "=== Packing tgz ==="
mkdir -p dist
VERSION="$(node -e "console.log(require('./package.json').version)")"
TARBALL="dsh-external-dsh-rp-shell-${VERSION}.tgz"
npm pack --pack-destination dist >/dev/null
# npm names the tarball after the package name; normalize to our stable name.
for f in dist/*.tgz; do
  [ -e "$f" ] || continue
  if [ "$(basename "$f")" != "$TARBALL" ]; then mv -f "$f" "dist/$TARBALL"; fi
done
echo "=== Build complete: dist/$TARBALL ==="
