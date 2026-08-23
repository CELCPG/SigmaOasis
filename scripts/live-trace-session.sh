#!/usr/bin/env bash
#
# Compile and run the Layer 4 live-session demo harness.
# Requires a running LM Studio. Sandbox userData: /tmp/oasis-live-userdata.
#
#   bash scripts/live-trace-session.sh [model-id]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.live-build
ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"

if [ -x "$ELECTRON" ]; then
  RUN=("$ELECTRON")
elif [ -x "$ELECTRON_LINUX" ]; then
  RUN=("$ELECTRON_LINUX")
else
  echo "error: no bundled Electron runtime found. Run 'npm install'." >&2
  exit 1
fi

rm -rf "$OUT"

node node_modules/typescript/bin/tsc \
  --outDir "$OUT" \
  --rootDir . \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --strict \
  --types node \
  src/shared/tools/index.ts \
  src/main/ipc/traceExport.ts \
  src/main/ipc/audit.ts \
  src/main/ipc/store.ts \
  src/main/ipc/fsAtomic.ts \
  src/renderer/src/lib/agentLoop.ts \
  src/renderer/src/lib/grounding.ts \
  src/renderer/src/lib/nativeToolCall.ts \
  src/renderer/src/lib/toolArgs.ts \
  scripts/live-trace-session.ts

# Full Electron runtime (not ELECTRON_RUN_AS_NODE): safeStorage needs it.
"${RUN[@]}" "$OUT/scripts/live-trace-session.js" "$@"
