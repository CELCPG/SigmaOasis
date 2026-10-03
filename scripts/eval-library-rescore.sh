#!/usr/bin/env bash
#
# Move recorded library results to the current library scorer (v4.6, J3).
# Offline: it reads results files. See scripts/eval-library-rescore.ts and docs/evals/answers.md.
#
#   npm run eval:library-rescore -- <results.json | folder> [more …] [--skip <text> …] [--write [--reformat]]
#
# Exit 0 · 2 unreadable, or --write refused a file that is not 2-space JSON.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.eval-build/library-rescore

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
  scripts/eval-library-rescore.ts

node "$OUT/scripts/eval-library-rescore.js" "$@"
