#!/usr/bin/env bash
#
# Run the test suite.
#
# The suite uses Node's built-in test runner (node:test) with no extra
# dependencies. TypeScript is compiled to CommonJS in .test-build/ first, so the
# tests exercise the same code the app ships rather than a re-implementation.
#
# Node is used when available. Otherwise we fall back to the Node runtime bundled
# inside the project's Electron — the app already depends on it, and it is the
# same major version the main process runs on.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.test-build
# Absolute, deliberately. Launched by a relative path, macOS resolves the
# surrounding .app bundle from argv[0] and — once the bundle has been
# registered with LaunchServices by running the app itself — aborts with
# "NSBundle initWithURL:: non-file URL argument" before Node ever starts.
# Same binary, same directory, absolute path: fine. Cost of the lesson: a
# green suite that suddenly would not run at all.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_NODE="$REPO_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_NODE_LINUX="$REPO_ROOT/node_modules/electron/dist/electron"

if command -v node >/dev/null 2>&1; then
  RUN=(node)
elif [ -x "$ELECTRON_NODE" ]; then
  RUN=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_NODE")
elif [ -x "$ELECTRON_NODE_LINUX" ]; then
  RUN=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_NODE_LINUX")
else
  echo "error: no node binary and no bundled Electron runtime found." >&2
  echo "Run 'npm install', or install Node." >&2
  exit 1
fi

rm -rf "$OUT"

# v1.17.1: typecheck the WHOLE project before compiling the test build.
#
# The compile below takes a hand-maintained list of files, and that list is an
# enumeration — it grew one entry at a time as tests needed things. MessageBubble
# .tsx, which renders the entire verification banner, was never on it, so a merge
# that left a dangling `parts` reference in it passed this script at exit 0 while
# `npm run typecheck` failed. The list cannot be trusted to cover what ships; the
# tsconfigs can, because they describe the project rather than a selection.
#
# This is the same repair the app's own checks keep needing: replace an
# enumeration of what to look at with the thing that covers the class.
"${RUN[@]}" node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
"${RUN[@]}" node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json


# Compile main-process modules + tests together, preserving the directory layout
# that test/harness.ts expects (.test-build/{src/main/ipc,test}).
#
# v4.1 (F4): from tsconfig.test.json, which names folders, not files. Through
# 4.0.2 this was a hand-kept list of ninety-odd paths, and a list is the
# enumeration the note above warns about: harness.ts's load() requires compiled
# modules by path at run time, which no import names, so a module a test loads
# that way was built only if someone remembered to add it. The folders build a
# superset of what the list did (every file it produced, and the rest of
# src/main and the renderer's lib, hooks, stores and components beside it).
"${RUN[@]}" node_modules/typescript/bin/tsc -p tsconfig.test.json --outDir "$OUT"

# node:test discovers by filename; point it at the compiled tests.
"${RUN[@]}" --test "$OUT"/test/*.test.js

# The page-extraction script runs in a browser, so it is verified against a real
# offscreen window rather than mocked. Needs Electron proper, not node.
exec bash scripts/test-render.sh
