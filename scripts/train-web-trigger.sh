#!/usr/bin/env bash
#
# v4.2 (C2): retrain the web-trigger classifier from
# test/fixtures/webTrigger/labelled.jsonl and rewrite
# src/renderer/src/lib/webTrigger.model.json. Maintainer-time only: the app
# reads the committed JSON and never trains. Deterministic, offline, a few
# seconds. See docs/web-trigger.md.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.test-build
node node_modules/typescript/bin/tsc \
  --outDir "$OUT" --rootDir . --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --strict --types node scripts/train-web-trigger.ts
node "$OUT/scripts/train-web-trigger.js" "$@"
