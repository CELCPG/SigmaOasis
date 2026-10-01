#!/usr/bin/env bash
#
# Compare an eval run with a committed baseline (v4.1, M2; the noise band v4.3).
# Offline: it reads results files. See scripts/eval-diff.ts and baselines/README.md.
#
#   npm run eval:diff -- baselines/agent-qwen3.8-9b-distill.json .eval-results/agent-….json [more runs …]
#   npm run eval:diff -- --base <a.json> [<b.json> …] --run <c.json> [<d.json> …]
#   npm run eval:diff -- --save .eval-results/agent-….json [more runs …]
#
# Exit 0 BETTER or SAME-WITHIN-NOISE · 1 WORSE · 2 unreadable · 3 TOO-FEW-PASSES.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build/diff

node node_modules/typescript/bin/tsc \
  --outDir "$OUT" \
  --rootDir . \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --esModuleInterop --resolveJsonModule \
  --skipLibCheck \
  --strict \
  --types node \
  scripts/eval-diff.ts

node "$OUT/scripts/eval-diff.js" "$@"
