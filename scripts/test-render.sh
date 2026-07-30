#!/usr/bin/env bash
#
# Verify the page-extraction script against a real offscreen Chromium window.
#
# Separate from scripts/test.sh because this needs Electron proper (a browser and
# a layout engine), not the Node runtime inside it. Hidden-text stripping depends
# on getComputedStyle, so mocking the DOM would only test the mock.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.test-build
ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"

if [ -x "$ELECTRON_MAC" ]; then
  ELECTRON="$ELECTRON_MAC"
elif [ -x "$ELECTRON_LINUX" ]; then
  ELECTRON="$ELECTRON_LINUX"
else
  echo "skipping render checks: no bundled Electron found (run 'npm install')." >&2
  exit 0
fi

# A headless CI box has no display server; Electron cannot open even an offscreen
# window without one. Skip rather than fail the whole suite.
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "skipping render checks: no display available (try xvfb-run)." >&2
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  TSC=(node)
else
  TSC=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON")
fi

"${TSC[@]}" node_modules/typescript/bin/tsc \
  --outDir "$OUT" \
  --rootDir . \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --strict \
  test/renderCheck.ts

# Chromium's sandbox needs a real session on some CI images; --no-sandbox keeps
# this runnable there without weakening anything in the shipped app.
exec "$ELECTRON" --no-sandbox "$OUT/test/renderCheck.js"
