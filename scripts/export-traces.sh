#!/usr/bin/env bash
#
# Compile and run the Layer 4 trace exporter.
#
# Mirrors scripts/eval-tools.sh: TypeScript is compiled to CommonJS in
# .export-build/ so the export runs the same shipped code the app does, not a
# re-implementation.
#
#   npm run export:traces -- <audit-export.jsonl> [--conversations <dir>] [--out <dir>]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.export-build
ELECTRON_NODE="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_NODE_LINUX="node_modules/electron/dist/electron"

if command -v node >/dev/null 2>&1; then
  RUN=(node)
elif [ -x "$ELECTRON_NODE" ]; then
  RUN=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_NODE")
elif [ -x "$ELECTRON_NODE_LINUX" ]; then
  RUN=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_NODE_LINUX")
else
  echo "error: no node binary and no bundled Electron runtime found." >&2
  echo "Run 'npm install', or install Node." >&2
  exit 1
fi

rm -rf "$OUT"

"${RUN[@]}" node_modules/typescript/bin/tsc \
  --outDir "$OUT" \
  --rootDir . \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --strict \
  --types node \
  src/main/ipc/toolSchemas.ts \
  src/main/ipc/traceExport.ts \
  scripts/export-traces.ts

"${RUN[@]}" "$OUT/scripts/export-traces.js" "$@"
