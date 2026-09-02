#!/usr/bin/env bash
#
# Head-to-head capture harness: drive the shipped UI through one task and
# record what the screen showed. Needs a build (out/) and a running LM Studio.
#
#   bash scripts/h2h-capture.sh --model qwen3.8-9b --task-id sum-csv \
#        --prompt "How many prime numbers are below 100?"
#
# The driver runs under Electron's bundled Node, which is v20: WHATWG WebSocket
# lives behind --experimental-websocket there, and CDP needs a WebSocket.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.h2h-build
ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"
if [ -x "$ELECTRON_MAC" ]; then ELECTRON="$ELECTRON_MAC"; elif [ -x "$ELECTRON_LINUX" ]; then ELECTRON="$ELECTRON_LINUX"; else
  echo "error: no bundled Electron found (run 'npm install')." >&2; exit 1; fi

if [ ! -f out/main/index.js ]; then
  echo "error: no build in out/. Run: node node_modules/electron-vite/bin/electron-vite.js build" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then TSC=(node); else TSC=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON"); fi

"${TSC[@]}" node_modules/typescript/bin/tsc \
  --outDir "$OUT" --rootDir . --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --strict --types node \
  scripts/h2h-capture.ts

# The driver is a plain Node program (it spawns the app itself), so it runs as
# ELECTRON_RUN_AS_NODE. The app it spawns gets a full Electron runtime with that
# variable stripped from its environment.
#
# Node 20 (Electron ≤ 33) needs a flag for the WebSocket client the CDP driver
# uses; Node 22+ (Electron 44's is 24) has it built in and rejects the flag.
# Ask the runtime rather than assume — the same probe scripts/render-bench.sh
# makes, adopted here for v2.3's Electron upgrade.
if ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e 'if (typeof WebSocket === "undefined") process.exit(1)' >/dev/null 2>&1; then
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$OUT/scripts/h2h-capture.js" "$@"
else
  ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--experimental-websocket \
    "$ELECTRON" "$OUT/scripts/h2h-capture.js" "$@"
fi
