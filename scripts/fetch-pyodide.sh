#!/usr/bin/env bash
#
# Fetch the Pyodide runtime the Workbench (run_python / analyze_file) needs into
# resources/pyodide/: the core runtime plus offline wheels for the scientific
# stack. Pinned; verified by loading in the check suite (test/workbenchCheck.ts).
# Packaged builds ship this directory as an extra resource; dev runs read it
# from the repo. The app itself never downloads anything — this is a
# maintainer/dev step, like npm install.
#
#   PYODIDE_VERSION   release tag (default pinned below)
#   WORKBENCH_PACKAGES space-separated top-level packages; their dependency
#                     closure is resolved from the release's lock file
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${PYODIDE_VERSION:-314.0.4}"
PACKAGES="${WORKBENCH_PACKAGES:-numpy pandas matplotlib}"
BASE="https://github.com/pyodide/pyodide/releases/download/${VERSION}"
CDN="https://cdn.jsdelivr.net/pyodide/v${VERSION}/full"
DEST=resources/pyodide
# Windows runners expose python as `python`, not `python3`, under git-bash.
PY="$(command -v python3 || command -v python)"

need_core=1
if [ -f "$DEST/pyodide.asm.wasm" ] && grep -q "\"version\": \"$VERSION\"" "$DEST/package.json" 2>/dev/null; then
  need_core=0
fi

if [ "$need_core" = 1 ]; then
  tmp=$(mktemp -d)
  echo "downloading $BASE/pyodide-core-${VERSION}.tar.bz2"
  curl -fsSL -o "$tmp/pyodide-core.tar.bz2" "$BASE/pyodide-core-${VERSION}.tar.bz2"
  rm -rf "$DEST"
  mkdir -p resources
  tar xjf "$tmp/pyodide-core.tar.bz2" -C resources
  rm -f "$DEST/python" "$DEST/python.bat" "$DEST/python.exe" "$DEST/python_cli_entry.mjs"
  rm -rf "$tmp"
else
  echo "pyodide $VERSION core already present"
fi

# The full distribution's lock file lists every package and its dependencies;
# it replaces the core-only lock so loadPackage() can resolve the wheels below.
echo "downloading lock file"
curl -fsSL -o "$DEST/pyodide-lock.json" "$CDN/pyodide-lock.json"

# Resolve the dependency closure and fetch each wheel that is not already here.
# tr -d '\r': Windows Python writes CRLF on stdout, and a filename carrying a
# trailing carriage return into a URL is rejected by curl as malformed — which
# is exactly how the v1.6.0 Windows release job failed.
FILES=$("$PY" - "$DEST/pyodide-lock.json" $PACKAGES <<'PY' | tr -d '\r'
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
want = sys.argv[2:]
seen = []
def walk(name):
    if name in seen: return
    if name not in lock:
        sys.stderr.write(f"warning: {name} is not in the lock file; skipped\n"); return
    seen.append(name)
    for d in lock[name]["depends"]: walk(d)
for w in want: walk(w)
for n in seen: print(lock[n]["file_name"])
PY
)
count=0
for f in $FILES; do
  if [ ! -f "$DEST/$f" ]; then
    echo "  $f"
    curl -fsSL -o "$DEST/$f" "$CDN/$f"
  fi
  count=$((count + 1))
done
echo "$count wheel(s) present for: $PACKAGES"
# Record what is bundled so the app can say so without parsing the lock.
"$PY" - "$DEST" $PACKAGES <<'PY'
import json, sys, os
dest = sys.argv[1]; want = sys.argv[2:]
lock = json.load(open(os.path.join(dest, "pyodide-lock.json")))["packages"]
have = sorted(n for n, p in lock.items() if os.path.exists(os.path.join(dest, p["file_name"])))
json.dump({"requested": want, "available": have}, open(os.path.join(dest, "workbench-packages.json"), "w"), indent=2)
PY
du -sh "$DEST"
echo "ok"
