#!/usr/bin/env bash
#
# Read recorded agent runs the way the unrun-claim guard does (v4.5, H3, H3b).
# Offline: it reads results files. See scripts/eval-claims.ts and docs/evals/claims.md.
#
#   npm run eval:claims -- baselines .eval-results [--before <git-rev>] [--same] [--list]
#   npm run eval:claims -- <folders of full results> --rescore <results.json …> [--write [--reformat]]
#
# Exit 0 nothing to fix · 1 the guard marks a run the eval does not score a false claim, or misses
# one it does — or, with --same, the code at --before reads a report differently · 2 unreadable,
# or --write refused a file that is not 2-space JSON.
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
