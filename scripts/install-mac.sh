#!/bin/bash
# Build FunkinAI and install it to /Applications.
#
# If scripts/signing.env exists (see signing.env.example), the build is
# signed with your Developer ID certificate and notarized by Apple — no
# quarantine workaround needed. Otherwise the build is unsigned and this
# script clears the Gatekeeper quarantine flag instead (personal use only).
set -e
cd "$(dirname "$0")/.."

if [ -f scripts/signing.env ]; then
  echo "🔐 Signing credentials found — building signed + notarized"
  set -a
  source scripts/signing.env
  set +a
else
  echo "⚠️  No scripts/signing.env — building unsigned (personal use)"
fi

# Release builds cover arm64 + x64; installing locally only needs this Mac's
# architecture, so build the one and skip the cross-compile.
case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *)
    echo "❌ Unsupported architecture: $(uname -m)"
    exit 1
    ;;
esac

npm run build:mac -- --"$ARCH"

VERSION=$(node -p "require('./package.json').version")
DMG="dist/FunkinAI-${VERSION}-mac-${ARCH}.dmg"
if [ ! -f "$DMG" ]; then
  echo "❌ Expected build artifact not found: $DMG"
  exit 1
fi

MOUNT=$(hdiutil attach "$DMG" -nobrowse | grep -o '/Volumes/.*' | head -1)
if [ -z "$MOUNT" ]; then
  echo "❌ Could not mount $DMG"
  exit 1
fi

cp -R "$MOUNT/FunkinAI.app" /Applications/
hdiutil detach "$MOUNT" -quiet

if [ -f scripts/signing.env ]; then
  # Verify Gatekeeper accepts the notarized app.
  spctl --assess --verbose /Applications/FunkinAI.app && \
    echo "✅ FunkinAI ${VERSION} installed — signed, notarized, Gatekeeper-approved"
else
  xattr -dr com.apple.quarantine /Applications/FunkinAI.app 2>/dev/null || true
  echo "✅ FunkinAI ${VERSION} installed to /Applications (unsigned)"
  echo "⚠️  Unsigned build: on first launch macOS will block it as 'malware'."
  echo "   Approve it once via System Settings → Privacy & Security → Open Anyway."
fi
