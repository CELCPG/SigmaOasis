#!/usr/bin/env bash
#
# Checks that need Electron proper, not the Node runtime inside it.
#
#  - renderCheck:     the page-extraction script, in a real offscreen window.
#                     Hidden-text stripping depends on getComputedStyle and a real
#                     layout, so mocking a DOM would only test the mock.
#  - styleCheck:      the shipped stylesheet, laid out for real: long-token
#                     wrapping, focus rings, ink contrast. All three are
#                     properties of a layout, not of a string of CSS.
#  - chromeContrast:  the contrast of a real reply's ink, in a real window, in
#                     both themes. Composited over the translucent surfaces the
#                     app actually stacks — a check that reads the CSS variables
#                     alone certifies ink the app never renders.
#  - markdownCheck:   the markdown → HTML sanitizer (the XSS boundary), in a real
#                     window. DOMPurify is a no-op without a DOM, so a node test
#                     of it would pass while sanitizing nothing.
#  - workbenchCheck:  the sandboxed Python runtime (Pyodide in a sandboxed
#                     window): round-trip, isolation, timeout kill. Self-skips
#                     when resources/pyodide is not fetched.
#  - httpClientCheck: the Electron-net transport every outbound request uses.
#                     The node suite stubs ./net, so nothing there exercises the
#                     real transport — a regression would break every network
#                     path in the app with the whole node suite still green.
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
  echo "skipping Electron checks: no bundled Electron found (run 'npm install')." >&2
  exit 0
fi

# A headless CI box has no display server; Electron cannot open even an offscreen
# window without one. Skip rather than fail the whole suite.
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "skipping Electron checks: no display available (try xvfb-run)." >&2
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
  test/renderCheck.ts \
  test/styleCheck.ts \
  test/chromeContrastCheck.ts \
  test/markdownCheck.ts \
  test/workbenchCheck.ts \
  src/preload/workbench.ts \
  test/httpClientCheck.ts

# Chromium's sandbox needs a real session on some CI images; --no-sandbox keeps
# this runnable there without weakening anything in the shipped app.
status=0
for check in renderCheck styleCheck chromeContrastCheck markdownCheck workbenchCheck httpClientCheck; do
  "$ELECTRON" --no-sandbox "$OUT/test/$check.js" || status=1
done
exit "$status"
