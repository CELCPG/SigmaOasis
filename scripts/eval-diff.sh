#!/usr/bin/env bash
#
# Compare an eval run with a committed baseline (v4.1, M2). Offline: it reads
# two results files. See scripts/eval-diff.ts and baselines/README.md.
#
#   npm run eval:diff -- baselines/agent-qwen3.8-9b.json .eval-results/agent-….json
#   npm run eval:diff -- --save .eval-results/agent-….json
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
