# ClawFace Gateway - Desktop App

A native macOS menu bar app for monitoring your Mac's system health and AI spending. Pairs with the [ClawFace iOS app](https://clawface.app) for remote monitoring from your iPhone.

## Features

- **Menu Bar Tray Icon** -- Lives in your macOS menu bar as a compact tray icon
- **System Metrics** -- CPU, memory, disk usage with color-coded bars; temperature and network speed
- **AI Usage Tracking** -- Expandable section showing per-provider and per-model cost breakdown (Anthropic, OpenAI, Google, Deepseek)
- **OpenClaw Monitoring** -- Expandable section with agent status, channels, sessions, context usage, and token counts
- **Device Pairing** -- QR code and `CLAW-XXXX` code for pairing with the ClawFace iOS app
- **Auto-Disconnect** -- Notifies paired devices when the app quits, requiring re-pairing on next launch

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build DMG installer
npm run dist
```

The DMG is output to `release/`. Open it and drag ClawFace Gateway to Applications.

## Project Structure

```
desktop/
├── src/
│   ├── main/
│   │   ├── main.ts          # Electron main process, IPC handlers, gateway lifecycle
│   │   ├── tray.ts           # Tray icon creation, window management
│   │   └── preload.cjs       # Context bridge (secure IPC for renderer)
│   ├── renderer/
│   │   ├── index.html        # Dropdown panel markup
│   │   ├── styles.css         # Panel styles (dark theme, expandable sections)
│   │   └── app.js             # DOM updates, expand/collapse, pairing handlers
│   └── assets/
│       ├── tray-icon.png      # 22x22 B&W template icon (auto-inverts in dark mode)
│       ├── tray-icon@2x.png   # 44x44 retina template icon
│       └── app-icon.icns      # Application icon
├── electron-builder.yml       # Build configuration for DMG packaging
├── tsconfig.json
└── package.json
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Compile TypeScript and launch Electron |
| `npm run build` | Compile TypeScript only |
| `npm run pack` | Package the app (unpacked, for testing) |
| `npm run dist` | Build a DMG installer for distribution |

## How It Works

The desktop app embeds the same `@openclaw/gateway-monitor` engine used by the CLI gateway. On launch:

1. Starts the gateway monitor (system metrics, AI usage tracking, OpenClaw RPC)
2. Creates a tray icon in the macOS menu bar
3. Clicking the icon opens a dropdown panel with live data
4. If paired with an iOS device, status updates stream to the phone via WebSocket relay

## Dependencies

- **[@openclaw/gateway-monitor](../gateway/)** -- Core monitoring engine (linked from the monorepo)
- **[qrcode](https://www.npmjs.com/package/qrcode)** -- QR code generation for device pairing
- **[Electron](https://www.electronjs.org/)** -- Desktop framework
- **[electron-builder](https://www.electron.build/)** -- DMG/installer packaging

## License

MIT
