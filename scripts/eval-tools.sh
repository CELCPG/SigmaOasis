#!/usr/bin/env bash
#
# Compile and run the Layer 0b tool-choice eval harness.
#
# Mirrors scripts/test.sh: TypeScript is compiled to CommonJS in .eval-build/
# so the eval exercises the same shipped code (the agent loop, the tool
# schemas), not a re-implementation. The eval itself is gated behind
# LMSTUDIO_EVAL=1 — it needs a live LM Studio server.
#
#   LMSTUDIO_EVAL=1 npm run eval:tools -- <model-id> [model-id ...]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build
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
  src/renderer/src/lib/agentLoop.ts \
  src/renderer/src/lib/evalRunner.ts \
  src/renderer/src/lib/reasoning.ts \
  src/renderer/src/lib/nativeToolCall.ts \
  src/renderer/src/lib/grounding.ts \
  src/renderer/src/lib/toolArgs.ts \
  scripts/eval-tools.ts

"${RUN[@]}" "$OUT/scripts/eval-tools.js" "$@"
