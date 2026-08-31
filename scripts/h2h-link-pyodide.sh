#!/usr/bin/env bash
#
# Give a head-to-head arm the repo's Pyodide runtime, safely.
#
#   bash scripts/h2h-link-pyodide.sh <arm-app-root>
#
# An arm is a separate checkout or scratch build (e.g. .../baseline-app), and
# re-downloading ~60MB of runtime per arm is pointless when the repo already
# has it — so the arm's resources/pyodide is a symlink to the repo's. This
# script exists because the obvious one-liner is a trap that has already fired:
#
#   ln -s "$repo/resources/pyodide" "$arm/resources/pyodide"
#
# run a second time does not fail and does not replace the link — <dest> now
# EXISTS as a directory (through the link), so ln follows it and plants
# `pyodide -> resources/pyodide` INSIDE the repo's own runtime directory.
# Every tree walk from then on recurses forever; electron-builder died signing
# the v2.1.0 release on exactly that ELOOP. `ln -sfn` alone is not the whole
# fix either — with <dest> a real directory (a previously copied runtime),
# -f still places the link inside it.
#
# So: refuse the degenerate cases, remove only what is safe to remove, and be
# idempotent — running this twice is the expected use, not an accident.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd -P)
SRC="$REPO/resources/pyodide"

ARM="${1:?usage: h2h-link-pyodide.sh <arm-app-root>}"
[ -d "$ARM" ] || { echo "error: $ARM is not a directory" >&2; exit 1; }
ARM=$(cd "$ARM" && pwd -P)

[ -f "$SRC/pyodide.js" ] || {
  echo "error: $SRC has no runtime — run scripts/fetch-pyodide.sh first" >&2
  exit 1
}

# Linking the repo to itself is how the loop is made; an arm is never here.
if [ "$ARM" = "$REPO" ]; then
  echo "error: <arm-app-root> is this repo — an arm is a separate checkout" >&2
  exit 1
fi

DEST="$ARM/resources/pyodide"
mkdir -p "$ARM/resources"

if [ -L "$DEST" ]; then
  # An existing link is replaced whatever it points at: -n treats the link
  # itself as the target instead of following it into the directory.
  ln -sfn "$SRC" "$DEST"
elif [ -e "$DEST" ]; then
  # A real directory (or file) is somebody's data — a copied runtime, perhaps
  # deliberately pinned to a different version. Not this script's to delete.
  echo "error: $DEST exists and is not a symlink; remove it yourself first" >&2
  exit 1
else
  ln -s "$SRC" "$DEST"
fi

# Trust nothing above: prove the arm resolves to the repo's runtime and that
# the repo's runtime contains no link pointing back at itself.
resolved=$(cd "$DEST" && pwd -P)
[ "$resolved" = "$SRC" ] || { echo "error: $DEST resolves to $resolved" >&2; exit 1; }
if [ -L "$SRC/pyodide" ]; then
  echo "error: $SRC/pyodide is a symlink loop — remove it" >&2
  exit 1
fi

echo "linked $DEST -> $SRC"
