#!/usr/bin/env bash
#
# Read recorded agent runs the way the unrun-claim guard does (v4.5, H3).
# Offline: it reads results files. See scripts/eval-claims.ts.
#
#   npm run eval:claims -- baselines .eval-results [--before <git-rev>] [--list]
#
# Exit 0 nothing to fix · 1 the move changed a reading, or the guard marks a run the eval scored
# clean, or misses one it scored false · 2 unreadable.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build/claims

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
  scripts/eval-claims.ts

node "$OUT/scripts/eval-claims.js" "$@"
