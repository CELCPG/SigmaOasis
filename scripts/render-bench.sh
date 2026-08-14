#!/usr/bin/env bash
#
# Measure what one streamed reply costs to render.
#
# Builds the current working tree, launches it against a throwaway profile
# pointed at a stand-in LM Studio server, streams one fixed long code-heavy
# reply, and records main-thread processor time. Results append to
# .render-bench/results.jsonl; `--report` tabulates them.
#
#   bash scripts/render-bench.sh v1.4.7        # measure the current tree
#   bash scripts/render-bench.sh --report      # compare everything recorded
#
# To A/B two versions, run it once per checkout and then report:
#
#   git checkout v1.4.6 && bash scripts/render-bench.sh v1.4.6
#   git checkout v1.4.7 && bash scripts/render-bench.sh v1.4.7
#   bash scripts/render-bench.sh --report
#
# The checkout is deliberately yours to do. A benchmark script that moves HEAD
# on its own is one stray invocation away from discarding uncommitted work.
#
# Knobs:
#   BENCH_TOK_PER_SEC  tokens/sec to stream (default 60; try 150 for a fast model)
#   BENCH_BLOCKS       code blocks in the reply (default 8, ≈ 25 KB / 516 lines)
#   BENCH_PAIRS        prior exchanges already in the conversation (default 12)
#
# Why a stand-in model: a real one writes a different answer every run, so an
# A/B against it compares two different workloads. See
# docs/measuring-render-cost.md for the method and the traps.
#
# This opens a real window and takes a few minutes. It is not part of the test
# suite and CI does not run it.
set -euo pipefail
cd "$(dirname "$0")/.."

HERE=scripts/render-bench
WORK=.render-bench
RESULTS="$WORK/results.jsonl"

ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"

if [ -x "$ELECTRON_MAC" ]; then
  ELECTRON="$ELECTRON_MAC"
elif [ -x "$ELECTRON_LINUX" ]; then
  ELECTRON="$ELECTRON_LINUX"
else
  echo "error: no bundled Electron found (run 'npm install')." >&2
  exit 1
fi

# Everything runs on Electron's own Node so there is one runtime to reason
# about, and because the benchmark already requires Electron for the app.
NODE=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON")

# Node 20 needs a flag for the WebSocket client the CDP driver uses; Node 22+
# has it built in and rejects the flag. Ask rather than assume.
if "${NODE[@]}" -e 'if (typeof WebSocket === "undefined") process.exit(1)' >/dev/null 2>&1; then
  NODE_WS=("${NODE[@]}")
else
  NODE_WS=(env ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--experimental-websocket "$ELECTRON")
fi

if [ "${1:-}" = "--report" ]; then
  exec "${NODE[@]}" "$HERE/report.js" "$RESULTS"
fi

LABEL="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo current)}"

if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "error: no display available — this drives a real window (try xvfb-run)." >&2
  exit 1
fi

export BENCH_STUB_PORT="${BENCH_STUB_PORT:-1235}"
export BENCH_CDP_PORT="${BENCH_CDP_PORT:-9223}"
export BENCH_TOK_PER_SEC="${BENCH_TOK_PER_SEC:-60}"
export BENCH_BLOCKS="${BENCH_BLOCKS:-8}"

PROFILE="$WORK/profile-$LABEL"
STUB_PID=""
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$WORK"
rm -rf "$PROFILE"
"${NODE[@]}" "$HERE/seed.js" "$PROFILE" "${BENCH_PAIRS:-12}"

# Build, so the measurement is of the tree that is checked out right now and
# not of whatever out/ happened to contain.
echo "building…"
"${NODE[@]}" node_modules/electron-vite/bin/electron-vite.js build > "$WORK/build-$LABEL.log" 2>&1

"${NODE[@]}" "$HERE/stub.js" > "$WORK/stub-$LABEL.log" 2>&1 &
STUB_PID=$!
sleep 2
head -1 "$WORK/stub-$LABEL.log"

BENCH_PROFILE="$PWD/$PROFILE" "$ELECTRON" --remote-debugging-port="$BENCH_CDP_PORT" \
  "$HERE/wrapper.js" > "$WORK/app-$LABEL.log" 2>&1 &
APP_PID=$!

"${NODE_WS[@]}" "$HERE/measure.js" "$LABEL" "$RESULTS"

echo
echo "appended to $RESULTS — 'bash scripts/render-bench.sh --report' to compare"
