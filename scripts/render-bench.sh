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

# BENCH_ELECTRON points the run at another Electron binary, so one checked-out
# tree can be measured under two runtimes — the comparison an Electron upgrade
# needs (v2.3: 31 → 44), which two labels from two trees cannot give, since the
# report rightly voids a pair that rendered different text.
if [ -n "${BENCH_ELECTRON:-}" ] && [ -x "$BENCH_ELECTRON" ]; then
  ELECTRON="$BENCH_ELECTRON"
elif [ -x "$ELECTRON_MAC" ]; then
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

# The profile lives under $TMPDIR, not in the repository. On macOS 26 the
# re-signed Electron binary (a new identity to the folder-privacy system every
# time scripts/sign-dev-electron.sh runs) is refused renames and unlinks under
# ~/Documents — measured 3/3 EPERM in .render-bench/, 0/1 in /tmp — and the
# app's first settings write is an atomic rename. Logs and results stay in
# $WORK because plain node writes them.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/sigma-bench-$LABEL.XXXXXX")"
STUB_PID=""
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  [ -n "${PROFILE:-}" ] && rm -rf "$PROFILE"
}
trap cleanup EXIT

mkdir -p "$WORK"
"${NODE[@]}" "$HERE/seed.js" "$PROFILE" "${BENCH_PAIRS:-12}"

# Build, so the measurement is of the tree that is checked out right now and
# not of whatever out/ happened to contain.
#
# On plain node when there is one, like test.sh and test-render.sh. Electron's
# node built this fine through v2.2; on the Electron 44 upgrade (v2.3, macOS
# 26) vite's emptyDir under Electron-as-node came back EPERM unlinking files a
# previous build wrote, twice in a row, while the same build from `node`
# succeeded every time. The measurement itself still runs on Electron proper.
# The same runtime drives the measurement, whose one file write — appending to
# $RESULTS — was refused under Electron's node once for the reason above.
if command -v node >/dev/null 2>&1; then HOST_NODE=(node); else HOST_NODE=("${NODE_WS[@]}"); fi
echo "building…"
"${HOST_NODE[@]}" node_modules/electron-vite/bin/electron-vite.js build > "$WORK/build-$LABEL.log" 2>&1 || {
  echo "error: build failed; see $WORK/build-$LABEL.log" >&2
  exit 1
}

"${NODE[@]}" "$HERE/stub.js" > "$WORK/stub-$LABEL.log" 2>&1 &
STUB_PID=$!
sleep 2
head -1 "$WORK/stub-$LABEL.log"

BENCH_PROFILE="$PROFILE" "$ELECTRON" --remote-debugging-port="$BENCH_CDP_PORT" \
  "$HERE/wrapper.js" > "$WORK/app-$LABEL.log" 2>&1 &
APP_PID=$!

"${HOST_NODE[@]}" "$HERE/measure.js" "$LABEL" "$RESULTS"

echo
echo "appended to $RESULTS — 'bash scripts/render-bench.sh --report' to compare"
