#!/usr/bin/env bash
#
# Compile and run the answer-quality evals (library grounding, quantitative,
# deliberation). Runs under Electron *proper*, not the bundled Node: the
# Workbench needs a real sandboxed window and the library needs the app's own
# retrieval. Gated behind LMSTUDIO_EVAL=1 — it needs a live LM Studio.
#
#   LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>
#   EVAL_SUITES=quant,deliberate EVAL_CASES=1-5 LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build
ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"
if [ -x "$ELECTRON_MAC" ]; then ELECTRON="$ELECTRON_MAC"; elif [ -x "$ELECTRON_LINUX" ]; then ELECTRON="$ELECTRON_LINUX"; else
  echo "error: no bundled Electron found (run 'npm install')." >&2; exit 1; fi

if command -v node >/dev/null 2>&1; then TSC=(node); else TSC=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON"); fi

"${TSC[@]}" node_modules/typescript/bin/tsc \
  --outDir "$OUT" --rootDir . --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --strict --types node \
  scripts/eval-answers.ts \
  src/main/ipc/projectRecall.ts \
  src/main/ipc/marketData.ts \
  src/main/ipc/toolHandlers/market.ts \
  src/preload/workbench.ts

# Electron's default-app launcher ignores a lone script argument, so the model
# id always follows it; with none given the script prints its usage.
env -u ELECTRON_RUN_AS_NODE "$ELECTRON" --no-sandbox "$OUT/scripts/eval-answers.js" "${@:-help}"
