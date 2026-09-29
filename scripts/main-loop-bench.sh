#!/usr/bin/env bash
#
# M4 (v3.1): measure how long the main process stops answering while it does
# its heaviest synchronous work, with an agent task's stream running through
# it. See scripts/main-loop-bench/bench.ts for the phases and what is recorded.
#
#   bash scripts/main-loop-bench.sh <label>     # e.g. "main 0edef37"
#
# Runs inside the project's own Electron, against a stand-in server in another
# process; no model and no network. Results append to
# .main-loop-bench/results.jsonl. Not part of the suite; CI does not run it.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=.main-loop-bench
LABEL="${1:-$(git rev-parse --short HEAD)}"
mkdir -p "$WORK"

ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"
ELECTRON_WIN="node_modules/electron/dist/electron.exe"
if [ -x "$ELECTRON_MAC" ]; then ELECTRON="$ELECTRON_MAC"
elif [ -x "$ELECTRON_WIN" ]; then ELECTRON="$ELECTRON_WIN"
else ELECTRON="$ELECTRON_LINUX"; fi

# One bundle of the bench and the app modules it drives; electron is the real one.
node_modules/.bin/esbuild scripts/main-loop-bench/bench.ts --bundle --platform=node --format=cjs \
  --external:electron --outfile="$WORK/bench.js" --log-level=warning
# v3.1: the PDF worker beside the bundle, as the app ships it beside index.js —
# without it pdfOffThread extracts in-thread and the run measures the old way.
# (A tree from before the worker has no such file, and measures itself.)
rm -f "$WORK/pdfWorker.js"
if [ -f src/main/ipc/pdfWorker.ts ]; then
  node_modules/.bin/esbuild src/main/ipc/pdfWorker.ts --bundle --platform=node --format=cjs \
    --outfile="$WORK/pdfWorker.js" --log-level=warning
fi

# render.ts loads only https, so the pages it opens are served over TLS with a
# throwaway self-signed certificate; the bench — not the app — trusts exactly
# that host and port. Without openssl the render phase is skipped and says so.
TLS="$WORK/tls"
if command -v openssl >/dev/null 2>&1 && [ ! -s "$TLS/cert.pem" ]; then
  mkdir -p "$TLS"
  # MSYS_NO_PATHCONV: Git Bash on Windows otherwise rewrites "/CN=…" into a
  # Windows path and the certificate is never written. Harmless elsewhere.
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1" -keyout "$TLS/key.pem" -out "$TLS/cert.pem" >/dev/null 2>&1 || true
fi

# The stand-in server, in its own process so it keeps time while this one is blocked.
PORT_FILE="$WORK/port"
rm -f "$PORT_FILE"
if [ -s "$TLS/cert.pem" ]; then
  TLS_KEY="$TLS/key.pem" TLS_CERT="$TLS/cert.pem" node scripts/main-loop-bench/stream-server.mjs > "$PORT_FILE" &
else
  node scripts/main-loop-bench/stream-server.mjs > "$PORT_FILE" &
fi
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
read -r HTTP_PORT HTTPS_PORT < <(head -1 "$PORT_FILE" | tr -d '\r')

MAIN_LOOP_BENCH_DIR="$PWD/$WORK" MAIN_LOOP_BENCH_LABEL="$LABEL" \
  MAIN_LOOP_BENCH_SERVER="$HTTP_PORT" MAIN_LOOP_BENCH_TLS_PORT="$HTTPS_PORT" \
  "$ELECTRON" "$WORK/bench.js"
