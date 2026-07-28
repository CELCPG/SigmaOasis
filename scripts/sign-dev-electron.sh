#!/usr/bin/env bash
# Why this exists (macOS 26+):
# The stock Electron binary downloaded by npm is ad-hoc signed, and its CDHash
# is on Apple's notarization revocation list (stock Electron runtimes are
# frequently repackaged by malware). Gatekeeper's verdict is
# "notarization indicates this code has been revoked" and it MOVES THE BINARY
# TO THE TRASH on launch — which breaks `npm run dev`.
#
# Re-signing ad-hoc locally produces a fresh CDHash that isn't on any
# revocation list, so the verdict drops to plain "rejected" (unsigned), which
# macOS still executes fine for local development. Stripping the
# com.apple.provenance xattr removes the download-tracking metadata that ties
# the file to the revoked distribution.
#
# This only ever touches the LOCAL dev copy in node_modules. Release builds
# are properly signed with Developer ID and notarized in CI (see RELEASING.md).
set -euo pipefail

[ "$(uname)" = "Darwin" ] || exit 0

APP="$(cd "$(dirname "$0")/.." && pwd)/node_modules/electron/dist/Electron.app"
[ -d "$APP" ] || exit 0

xattr -dr com.apple.provenance "$(dirname "$APP")" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
echo "sign-dev-electron: re-signed local Electron for development (adhoc)"
