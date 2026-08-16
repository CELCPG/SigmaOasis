#!/usr/bin/env bash
#
# Build the curated reference packs (packs/<id>/) from packs/sources/*.json.
# Needs Electron proper: pages are converted from a real DOM. Maintainer-time
# only; the app never runs this. Usage: bash scripts/build-packs.sh [packId ...]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.test-build
ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"
if [ -x "$ELECTRON_MAC" ]; then ELECTRON="$ELECTRON_MAC"; elif [ -x "$ELECTRON_LINUX" ]; then ELECTRON="$ELECTRON_LINUX"; else
  echo "error: no bundled Electron found (run 'npm install')." >&2; exit 1; fi

if command -v node >/dev/null 2>&1; then TSC=(node); else TSC=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON"); fi

"${TSC[@]}" node_modules/typescript/bin/tsc \
  --outDir "$OUT" --rootDir . --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --strict scripts/build-packs.ts

# Electron's default-app launcher does nothing when the script is the only
# positional argument, so an explicit "all" always follows it.
env -u ELECTRON_RUN_AS_NODE "$ELECTRON" --no-sandbox "$OUT/scripts/build-packs.js" "${@:-all}"
