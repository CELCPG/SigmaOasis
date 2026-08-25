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
# Absolute, deliberately. Launched by a relative path, macOS resolves the
# surrounding .app bundle from argv[0] and — once the bundle has been
# registered with LaunchServices by running the app itself — aborts with
# "NSBundle initWithURL:: non-file URL argument" before Node ever starts.
# Same binary, same directory, absolute path: fine. Cost of the lesson: a
# green suite that suddenly would not run at all.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_NODE="$REPO_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_NODE_LINUX="$REPO_ROOT/node_modules/electron/dist/electron"

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
  src/main/ipc/attachmentIndex.ts \
  src/main/ipc/library.ts \
  src/main/ipc/workbenchProfile.ts \
  src/main/ipc/workbenchFormat.ts \
  src/main/ipc/deepResearch.ts \
  src/main/ipc/finance.ts \
  src/main/ipc/dates.ts \
  src/main/ipc/geo.ts \
  src/main/ipc/urlHygiene.ts \
  src/main/ipc/loopback.ts \
  src/main/ipc/sourceTiers.ts \
  src/main/ipc/productExtract.ts \
  src/main/ipc/rubrics.ts \
  src/main/ipc/shopping.ts \
  src/main/ipc/watchlist.ts \
  src/shared/tools/index.ts \
  src/main/ipc/toolHandlers/registry.ts \
  src/main/ipc/toolRank.ts \
  src/main/ipc/evalResults.ts \
  src/main/ipc/traceExport.ts \
  src/main/ipc/projects.ts \
  src/main/ipc/projectRecall.ts \
  src/renderer/src/lib/oasisRipple.ts \
  src/renderer/src/lib/reasoning.ts \
  src/renderer/src/lib/nativeToolCall.ts \
  src/renderer/src/lib/mathPlaintext.ts \
  src/renderer/src/lib/contextBudget.ts \
  src/renderer/src/lib/contextCompressor.ts \
  src/renderer/src/lib/responseCache.ts \
  src/renderer/src/lib/modelInfo.ts \
  src/renderer/src/lib/secondOpinion.ts \
  src/renderer/src/lib/grounding.ts \
  src/renderer/src/lib/toolGrounding.ts \
  src/renderer/src/lib/shopping.ts \
  src/renderer/src/lib/exportMarkdown.ts \
  src/renderer/src/lib/claimCheck.ts \
  src/renderer/src/lib/agentLoop.ts \
  src/renderer/src/lib/evalRunner.ts \
  src/renderer/src/lib/toolArgs.ts \
  src/renderer/src/lib/toolSelection.ts \
  src/renderer/src/lib/routing.ts \
  src/renderer/src/lib/sampling.ts \
  src/renderer/src/lib/attachmentRecall.ts \
  src/renderer/src/lib/libraryRecall.ts \
  src/renderer/src/lib/playbooks.ts \
  src/renderer/src/lib/modelProfiles.ts \
  src/renderer/src/lib/deliberation.ts \
  src/renderer/src/lib/ranCode.ts \
  src/renderer/src/lib/workbenchChecks.ts \
  src/renderer/src/lib/answerEval.ts \
  src/renderer/src/lib/projects.ts \
  src/renderer/src/lib/projectContext.ts \
  src/renderer/src/lib/conversationStats.ts \
  src/renderer/src/stores/appStore.ts \
  src/preload/index.d.ts \
  src/renderer/src/hooks/verification.ts \
  test/harness.ts \
  test/*.test.ts

# node:test discovers by filename; point it at the compiled tests.
"${RUN[@]}" --test "$OUT"/test/*.test.js

# The page-extraction script runs in a browser, so it is verified against a real
# offscreen window rather than mocked. Needs Electron proper, not node.
exec bash scripts/test-render.sh
