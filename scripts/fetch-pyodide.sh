#!/usr/bin/env bash
#
# Fetch the Pyodide core runtime the Workbench (run_python) needs into
# resources/pyodide/. Pinned; verified by size and by loading in the check
# suite (test/workbenchCheck.ts). Packaged builds ship this directory as an
# extra resource; dev runs read it from the repo. The app itself never
# downloads anything — this is a maintainer/dev step, like npm install.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${PYODIDE_VERSION:-314.0.4}"
URL="https://github.com/pyodide/pyodide/releases/download/${VERSION}/pyodide-core-${VERSION}.tar.bz2"
DEST=resources/pyodide

if [ -f "$DEST/pyodide.asm.wasm" ] && grep -q "\"version\": \"$VERSION\"" "$DEST/package.json" 2>/dev/null; then
  echo "pyodide $VERSION already present in $DEST"
  exit 0
fi

tmp=$(mktemp -d)
echo "downloading $URL"
curl -fsSL -o "$tmp/pyodide-core.tar.bz2" "$URL"
rm -rf "$DEST"
mkdir -p resources
tar xjf "$tmp/pyodide-core.tar.bz2" -C resources
# CLI shims are not used by the app.
rm -f "$DEST/python" "$DEST/python.bat" "$DEST/python.exe" "$DEST/python_cli_entry.mjs"
rm -rf "$tmp"
du -sh "$DEST"
echo "ok"
