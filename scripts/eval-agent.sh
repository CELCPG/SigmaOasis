#!/usr/bin/env bash
#
# Compile and run the agent eval (ROADMAP-v3.1.md M1).
#
# Mirrors scripts/eval-tools.sh: TypeScript is compiled to CommonJS in
# .eval-build/ so the eval drives the shipping engine (src/main/agent/), not a
# copy of it. Plain Node, not Electron: the engine is plain Node, as the sigma
# CLI shows. Gated behind LMSTUDIO_EVAL=1 — it needs a live LM Studio.
#
#   LMSTUDIO_EVAL=1 npm run eval:agent -- <model-id> [model-id ...]
#   EVAL_PASSES=3 EVAL_CASES=1-7 LMSTUDIO_EVAL=1 npm run eval:agent -- <model-id>
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build

# The cases run `node --test` in the agent's own shell, so Node on the PATH is a
# precondition of the suite, not only of this script.
if ! command -v node >/dev/null 2>&1; then
  echo "error: the agent eval needs Node on the PATH (the cases' tests run with node --test)." >&2
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
  scripts/eval-agent.ts

node "$OUT/scripts/eval-agent.js" "$@"
