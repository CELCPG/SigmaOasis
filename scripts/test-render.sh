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
#  - tabTraverse:     the head-to-head keyboard-traversal and theme instruments,
#                     driven with real key events in a real window. Whether Tab
#                     moves focus, what :focus-visible matches, what a click at
#                     an element's centre would hit and what a translucent ink
#                     composites to are all properties of a live layout.
#  - modalFocus:      focus containment on the app's own overlays, measured by
#                     booting the shipped build on a throwaway profile and
#                     walking 70 Tab stops in both themes. tabTraverse proves
#                     the instrument against a page written to have the defect;
#                     this proves the product, which needs the product's real
#                     component tree and real layout. Builds first — see below.
#  - planAccessibility: what a screen reader is handed for a plan block, read
#                     from the real Chromium accessibility tree over CDP
#                     (Accessibility.getFullAXTree) against the shipped build.
#                     A computed name cannot be scraped off markup — an <ol> is
#                     a list with no role= on it, and a <button> whose contents
#                     are four lines of prose is named with all four. Both of
#                     those were true here, and only the tree says so. Builds
#                     first, like modalFocus — see below.
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

# Electron 42+ fetches its binary on first run rather than at install; a tree
# that skipped that step would make every check below skip too. Fetch it here
# rather than report a green run that checked nothing.
if [ ! -x "$ELECTRON_MAC" ] && [ ! -x "$ELECTRON_LINUX" ]; then
  node scripts/ensure-electron.js || true
fi

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
  test/tabTraverseCheck.ts \
  test/modalFocusCheck.ts \
  test/planAccessibilityCheck.ts \
  test/markdownCheck.ts \
  test/workbenchCheck.ts \
  src/preload/workbench.ts \
  test/httpClientCheck.ts

# modalFocusCheck and planAccessibilityCheck boot out/ — so out/ has to be this
# tree, not whatever was built last. Unconditionally, not "if it looks stale": a
# freshness heuristic is one more enumeration to be defeated, and a check that
# silently measures an old build is worse than no check. Three rounds of one
# bench arm ran handicapped on exactly this kind of missing precondition.
echo "building out/ so the checks that boot it measure this tree…"
"${TSC[@]}" node_modules/electron-vite/bin/electron-vite.js build > "$OUT/build.log" 2>&1 || {
  echo "error: build failed; see $OUT/build.log" >&2
  exit 1
}

# Chromium's sandbox needs a real session on some CI images; --no-sandbox keeps
# this runnable there without weakening anything in the shipped app.
#
# Each check gets a throwaway profile. Without --user-data-dir every check
# process shares ~/Library/Application Support/Electron with every other
# Electron dev process on the machine, cache index included. The first run
# after the Electron 31 → 44 upgrade (v2.3) opened that Electron-31 cache under
# Chromium 152, logged "Unable to map Index file", and the network service
# crashed under renderCheck's one page load — ERR_FAILED on a loopback fixture
# that passes every time in isolation. A profile nothing else has touched is
# the check's own precondition, not the machine's history.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/sigma-checks.XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT
# markdownCheck bundles the sanitizer under test into $OUT/markdown-bundle from
# inside Electron, and vite empties that directory first. `npm test` recreates
# $OUT from scratch so there is never anything to empty; this script run on its
# own leaves the previous bundle behind, and on macOS 26 a file an Electron
# process wrote can come back EPERM to a later Electron process's unlink (seen
# once in v2.3's upgrade runs). Clear it from the shell, which is never refused.
rm -rf "$OUT/markdown-bundle"
status=0
for check in renderCheck styleCheck chromeContrastCheck tabTraverseCheck modalFocusCheck planAccessibilityCheck markdownCheck workbenchCheck httpClientCheck; do
  "$ELECTRON" --no-sandbox --user-data-dir="$PROFILE/$check" "$OUT/test/$check.js" || status=1
done
exit "$status"
