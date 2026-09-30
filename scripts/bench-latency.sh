#!/usr/bin/env bash
#
# The latency bench (v4.1, M7): cold vs warm prefix, turn 1 vs turn 10, a chat
# past its window — TTFT, prefill, cached tokens and decode tok/s against a
# loaded model. Results append to .latency-bench/results.jsonl; `--report`
# tabulates them. See scripts/bench-latency.ts and docs/evals.md.
#
#   npm run bench:latency -- qwen3.8-9b-distill 4.1-dev
#   npm run bench:latency -- --report
#
# It needs a live LM Studio with the model loaded. Not part of the test suite;
# CI does not run it.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.latency-bench/build
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
  scripts/bench-latency.ts

node "$OUT/scripts/bench-latency.js" "$@"
