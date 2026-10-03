#!/usr/bin/env bash
#
# v4.5 (H2): the think-first planners' probe — plan mode, the outline, deep
# research's planner and its reformulation, each asked the way the app asks
# today and the closed-think-prefill way, on a live model. Results append to
# .probe-planners/results.jsonl (or --out); `--summary` tabulates them. See
# scripts/probe-planners.ts.
#
#   npm run probe:planners -- --planner plan --budget-s 420
#   npm run probe:planners -- --summary
#   npm run probe:planners -- --dry
#
# It needs a live LM Studio with the model loaded. Not part of the test suite;
# CI does not run it.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.probe-planners/build
rm -rf "$OUT"

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
  scripts/probe-planners.ts

node "$OUT/scripts/probe-planners.js" "$@"
