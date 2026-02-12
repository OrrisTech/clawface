#!/bin/bash
# =============================================================================
# ClawFace Gateway — Build, Sign, Notarize & Release
#
# Usage:
#   ./scripts/release.sh              # Build signed + notarized DMG
#   ./scripts/release.sh --unsigned   # Build unsigned DMG (for testing)
#   ./scripts/release.sh --github     # Build + create GitHub release
#
# Prerequisites:
#   - Developer ID Application certificate in Keychain
#   - Notarization credentials stored: xcrun notarytool store-credentials "notarytool-profile"
#   - gh CLI authenticated (for --github flag)
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"
RELEASE_DIR="$DESKTOP_DIR/release"
VERSION=$(node -p "require('$DESKTOP_DIR/package.json').version")
DMG_NAME="ClawFace-Gateway-${VERSION}-arm64.dmg"
UNSIGNED=false
GITHUB_RELEASE=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --unsigned) UNSIGNED=true ;;
    --github) GITHUB_RELEASE=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

echo "=== ClawFace Gateway Release v${VERSION} ==="
echo ""

# Step 1: Build gateway (generates type declarations)
echo "[1/5] Building gateway..."
npm run build --workspace=gateway --prefix="$REPO_ROOT"
echo "  ✓ Gateway compiled"

# Step 2: Build desktop TypeScript
echo "[2/5] Building desktop..."
npm run build --workspace=desktop --prefix="$REPO_ROOT"
echo "  ✓ Desktop compiled"

# Step 3: Package DMG
echo "[3/5] Packaging DMG..."
npm run dist --workspace=desktop --prefix="$REPO_ROOT"

# Find the actual DMG file (electron-builder uses its own naming)
ACTUAL_DMG=$(ls "$RELEASE_DIR"/*.dmg 2>/dev/null | head -1)
if [ -z "$ACTUAL_DMG" ]; then
  echo "  ✗ No DMG found in $RELEASE_DIR"
  exit 1
fi
echo "  ✓ DMG built: $(basename "$ACTUAL_DMG")"

# Step 4: Notarize (unless --unsigned)
if [ "$UNSIGNED" = false ]; then
  echo "[4/5] Notarizing..."
  if xcrun notarytool submit "$ACTUAL_DMG" --keychain-profile "notarytool-profile" --wait 2>&1; then
    echo "  ✓ Notarization succeeded"
    xcrun stapler staple "$ACTUAL_DMG"
    echo "  ✓ Stapled notarization ticket"
  else
    echo "  ⚠ Notarization failed — DMG is still usable but will show Gatekeeper warning"
    echo "  Run manually: xcrun notarytool submit \"$ACTUAL_DMG\" --keychain-profile \"notarytool-profile\" --wait"
  fi
else
  echo "[4/5] Skipping notarization (--unsigned)"
fi

# Step 5: Create GitHub Release (if --github)
if [ "$GITHUB_RELEASE" = true ]; then
  echo "[5/5] Creating GitHub release..."

  # Rename DMG to clean name for release asset
  FINAL_DMG="$RELEASE_DIR/$DMG_NAME"
  if [ "$ACTUAL_DMG" != "$FINAL_DMG" ]; then
    cp "$ACTUAL_DMG" "$FINAL_DMG"
  fi

  TAG="gateway-v${VERSION}"

  # Check if gh is available and authenticated
  if ! command -v gh &>/dev/null; then
    echo "  ✗ gh CLI not found. Install: brew install gh"
    exit 1
  fi

  # Create release on the public repo
  gh release create "$TAG" "$FINAL_DMG" \
    --repo "OrrisTech/clawface" \
    --title "ClawFace Gateway v${VERSION}" \
    --notes "## ClawFace Gateway v${VERSION}

### macOS Menu Bar App

Download the DMG below, open it, and drag ClawFace Gateway to your Applications folder.

**Requirements:** macOS 13+ (Ventura or later), Apple Silicon (arm64)

### What's included
- System monitoring (CPU, memory, disk, temperature, network)
- AI usage tracking (Claude, OpenAI, Gemini, DeepSeek)
- OpenClaw gateway status monitoring
- QR code pairing with the ClawFace iOS app
- Runs silently in your menu bar

### Installation
1. Download \`${DMG_NAME}\`
2. Open the DMG and drag the app to Applications
3. Launch ClawFace Gateway from Applications
4. Scan the QR code with the ClawFace iOS app to pair
"
  echo "  ✓ GitHub release created: $TAG"
  echo ""
  echo "Release URL: https://github.com/OrrisTech/clawface/releases/tag/$TAG"
else
  echo "[5/5] Skipping GitHub release (use --github to create)"
fi

echo ""
echo "=== Done ==="
echo "DMG: $ACTUAL_DMG"
echo "Size: $(du -h "$ACTUAL_DMG" | cut -f1)"
