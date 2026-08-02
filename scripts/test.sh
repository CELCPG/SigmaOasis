#!/usr/bin/env bash
#
# Run the test suite.
#
# The suite uses Node's built-in test runner (node:test) with no extra
# dependencies. TypeScript is compiled to CommonJS in .test-build/ first, so the
# tests exercise the same code the app ships rather than a re-implementation.
#
# Node is used when available. Otherwise we fall back to the Node runtime bundled
# inside the project's Electron — the app already depends on it, and it is the
# same major version the main process runs on.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.test-build
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

# Compile main-process modules + tests together, preserving the directory layout
# that test/harness.ts expects (.test-build/{src/main/ipc,test}).
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
  src/main/ipc/embeddings.ts \
  src/main/ipc/retrieval.ts \
  src/main/ipc/researchIndex.ts \
  src/main/ipc/extract.ts \
  src/main/ipc/pdf.ts \
  src/main/ipc/userAgent.ts \
  src/main/ipc/pageScript.ts \
  src/main/ipc/render.ts \
  src/main/ipc/httpClient.ts \
  src/main/ipc/proxy.ts \
  src/main/ipc/search.ts \
  src/main/ipc/llm.ts \
  src/main/ipc/audit.ts \
  src/main/ipc/plan.ts \
  src/main/ipc/modelPin.ts \
  src/main/ipc/modelCatalog.ts \
  src/main/ipc/attachments.ts \
  src/main/ipc/deepResearch.ts \
  src/main/ipc/finance.ts \
  src/renderer/src/lib/oasisRipple.ts \
  src/renderer/src/lib/reasoning.ts \
  src/renderer/src/lib/nativeToolCall.ts \
  src/renderer/src/lib/mathPlaintext.ts \
  src/renderer/src/lib/contextBudget.ts \
  src/renderer/src/lib/modelInfo.ts \
  src/renderer/src/lib/secondOpinion.ts \
  src/renderer/src/lib/grounding.ts \
  src/renderer/src/lib/claimCheck.ts \
  src/renderer/src/stores/appStore.ts \
  test/harness.ts \
  test/*.test.ts

# node:test discovers by filename; point it at the compiled tests.
"${RUN[@]}" --test "$OUT"/test/*.test.js

# The page-extraction script runs in a browser, so it is verified against a real
# offscreen window rather than mocked. Needs Electron proper, not node.
exec bash scripts/test-render.sh
