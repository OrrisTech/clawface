# ClawFace Gateway — Mac App Distribution Guide

This guide covers how to build, sign, notarize, and distribute the ClawFace Gateway macOS app.

---

## Distribution Options

| Option | Pros | Cons |
|--------|------|------|
| **Direct DMG (Recommended)** | Full control, no review process, fast updates | Must handle code signing + notarization yourself |
| **Mac App Store** | Discovery, trust, auto-updates | Sandboxing restrictions, 30% cut, review delays |

**Recommendation:** Direct DMG distribution via clawface.app. The gateway needs low-level system access (CPU metrics, file scanning, WebSocket server) that is difficult to sandbox for the Mac App Store.

---

## Option A: Direct DMG Distribution (Recommended)

### Prerequisites

- [ ] Apple Developer Program membership ($99/year) — same account as the iOS app
- [ ] Developer ID Application certificate (for code signing)
- [ ] Developer ID Installer certificate (optional, for pkg distribution)
- [ ] App-specific password for notarization

### Step 1: Create Certificates

1. Go to https://developer.apple.com/account/resources/certificates/list
2. Click **+** to create a new certificate
3. Select **Developer ID Application** (for signing apps distributed outside the App Store)
4. Follow the CSR process (Keychain Access → Certificate Assistant → Request a Certificate)
5. Download and double-click to install in your Keychain

### Step 2: Configure Code Signing

Update `electron-builder.yml` to include your signing identity:

```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAM_ID)"
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: entitlements.mac.plist
  entitlementsInherit: entitlements.mac.plist
```

Create `desktop/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
</dict>
</plist>
```

### Step 3: Set Up Notarization

Apple requires all Developer ID apps to be notarized (since macOS 10.15+).

1. Generate an app-specific password at https://appleid.apple.com/account/manage → Security → App-Specific Passwords
2. Store credentials in your keychain:

```bash
xcrun notarytool store-credentials "notarytool-profile" \
  --apple-id "your@apple.id" \
  --team-id "K9YT36SP4B" \
  --password "your-app-specific-password"
```

### Step 4: Build, Sign & Notarize

```bash
cd desktop

# Install dependencies
npm install

# Build TypeScript
npm run build

# Build signed DMG
npm run dist

# The DMG is now at release/ClawFace Gateway-1.0.0-arm64.dmg
```

To add notarization to the build, update `electron-builder.yml`:

```yaml
mac:
  notarize: true

afterSign: scripts/notarize.js
```

Or manually notarize after building:

```bash
# Submit for notarization
xcrun notarytool submit "release/ClawFace Gateway-1.0.0-arm64.dmg" \
  --keychain-profile "notarytool-profile" \
  --wait

# Staple the notarization ticket to the DMG
xcrun stapler staple "release/ClawFace Gateway-1.0.0-arm64.dmg"

# Verify
xcrun stapler validate "release/ClawFace Gateway-1.0.0-arm64.dmg"
spctl --assess --type execute --verbose "release/ClawFace Gateway-1.0.0-arm64.dmg"
```

### Step 5: Host on clawface.app

Upload the DMG to your website and provide a download link. Example:

```
https://clawface.app/download/ClawFace-Gateway-1.0.0-arm64.dmg
```

Add a download page to the website that:
- Shows the DMG download button
- Explains installation (drag to Applications)
- Links to the iOS app in the App Store
- Shows the pairing flow

---

## Option B: Mac App Store (Not Recommended for This App)

If you decide to go the Mac App Store route despite sandboxing limitations:

### Challenges

1. **Sandboxing**: The gateway needs to:
   - Read `~/.anthropic/logs/` (Claude logs) — requires file access entitlement
   - Read `~/.config/claude/` — sandbox restricts this
   - Open WebSocket server on localhost:18789 — requires network server entitlement
   - Execute `pmset`, `ifstat` shell commands — NOT allowed in sandbox
   - Access `better-sqlite3` native module — complex with sandbox

2. **Workarounds needed**:
   - Replace shell commands with native Node.js APIs where possible
   - Use bookmark-based file access with user permission dialogs
   - Some features (temperature monitoring) may need to be dropped

### If You Still Want MAS

1. Register Bundle ID `au.com.orris.clawface.gateway` at developer.apple.com
2. Create provisioning profile for Mac App Store distribution
3. Add to `electron-builder.yml`:

```yaml
mac:
  target:
    - target: mas
      arch:
        - arm64
  entitlements: entitlements.mas.plist
  entitlementsInherit: entitlements.mas.inherit.plist
  provisioningProfile: embedded.provisionprofile

mas:
  entitlements: entitlements.mas.plist
  entitlementsInherit: entitlements.mas.inherit.plist
```

---

## Universal Binary (Intel + Apple Silicon)

Currently the build targets `arm64` only. To support Intel Macs:

```yaml
mac:
  target:
    - target: dmg
      arch:
        - universal  # or: [arm64, x64]
```

Note: `better-sqlite3` requires native compilation for each architecture. The `npm run postinstall` handles this via `electron-builder install-app-deps`.

---

## Auto-Update (Optional)

For automatic updates, add `electron-updater`:

```bash
npm install electron-updater
```

Update `electron-builder.yml`:
```yaml
publish:
  provider: generic
  url: https://clawface.app/releases/
```

Then in `main.ts`:
```typescript
import { autoUpdater } from 'electron-updater';
autoUpdater.checkForUpdatesAndNotify();
```

---

## Quick Reference — Build Commands

```bash
# Development
npm run dev          # Compile TS + launch Electron

# Production
npm run build        # Compile TypeScript only
npm run pack         # Package (unpacked, for testing)
npm run dist         # Build signed DMG to release/

# Manual notarization
xcrun notarytool submit release/*.dmg --keychain-profile "notarytool-profile" --wait
xcrun stapler staple release/*.dmg
```

---

## Checklist Before Release

- [ ] Update `version` in `desktop/package.json`
- [ ] Update `copyright` in `electron-builder.yml`
- [ ] Developer ID Application certificate installed in Keychain
- [ ] App-specific password stored for notarization
- [ ] `npm run dist` builds successfully
- [ ] DMG notarized and stapled
- [ ] Test: Download DMG → drag to Applications → launches → shows tray icon
- [ ] Test: Pairing QR code displays → iOS app can scan and pair
- [ ] Upload DMG to clawface.app
- [ ] Update download link on website
