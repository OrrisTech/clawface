// ============================================================================
// ClawFace Desktop - Electron Menu Bar App
// Embeds the gateway monitor and shows live stats in a dropdown panel.
// ============================================================================

import { app, ipcMain } from 'electron';
import { OpenClawMonitor } from '@openclaw/gateway-monitor';
import QRCode from 'qrcode';
import { createTray, updateTrayTooltip, getDropdownWindow } from './tray.js';
import { registerIpcHandlers } from './ipc-handlers.js';

// Hide dock icon — menu bar only
app.dock?.hide();

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let monitor: OpenClawMonitor | null = null;

// Cache the latest pair data so the renderer can pull it on load
let latestPairData: { code: string; expiresAt: number; qrDataUrl: string } | null = null;

app.whenReady().then(async () => {
  // 1. Create the tray icon and dropdown window
  const { window: dropdownWindow } = createTray();

  // 2. Register IPC handlers
  registerIpcHandlers();

  // 3. Pull handler: renderer requests latest pair data after it loads
  ipcMain.handle('pair:get', () => latestPairData);

  // 4. Unpair handler: stop monitor, clear pair data, restart for re-pairing
  ipcMain.handle('pair:unpair', async () => {
    console.log('[Desktop] Unpair requested by user.');
    if (monitor) {
      await monitor.stop();
      monitor = null;
    }
    latestPairData = null;
    sendGatewayState(true, false);
    // Restart monitor to begin new pairing flow
    monitor = new OpenClawMonitor();
    wireMonitorHooks(monitor);
    try {
      await monitor.start();
      sendGatewayState(true, false);
    } catch (err) {
      console.error('[Desktop] Failed to restart after unpair:', err);
      sendGatewayState(false, false);
    }
  });

  // 5. Create and start the gateway monitor
  try {
    monitor = new OpenClawMonitor();
    wireMonitorHooks(monitor);
    await monitor.start();
    sendGatewayState(true, false);
    console.log('[Desktop] Gateway started.');
  } catch (err) {
    console.error('[Desktop] Failed to start gateway:', err);
    sendGatewayState(false, false);
  }
});

// Graceful shutdown
app.on('before-quit', async () => {
  if (monitor) {
    await monitor.stop();
    monitor = null;
  }
});

// macOS: prevent app from quitting when all windows close (menu bar app behavior)
app.on('window-all-closed', () => {
  // Do nothing — keep the app running as a menu bar app
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function sendPairCode(code: string, expiresAt: number): void {
  // Send immediately with whatever QR data we have (may be empty string)
  const win = getDropdownWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('pair:code', { code, expiresAt, qrDataUrl: latestPairData?.qrDataUrl ?? '' });
  }
}

function generateAndSendQR(code: string, expiresAt: number): void {
  const qrPayload = JSON.stringify({ code, relay: 'wss://relay.clawface.app/gateway' });
  QRCode.toDataURL(qrPayload, {
    width: 160,
    margin: 1,
    color: { dark: '#00d4aa', light: '#00000000' },
  }).then((dataUrl: string) => {
    latestPairData = { code, expiresAt, qrDataUrl: dataUrl };
    const win = getDropdownWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('pair:code', latestPairData);
    }
  }).catch((err: unknown) => {
    console.error('[Desktop] QR generation failed:', err);
  });
}

/** Wire all hooks onto a monitor instance. */
function wireMonitorHooks(m: OpenClawMonitor): void {
  m.setStatusListener((status) => {
    const win = getDropdownWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('status:update', status);
    }
    updateTrayTooltip(status.system.cpu.usage, status.system.memory.usagePercent);
  });

  // Listen for paired state changes (fires when iOS device pairs/unpairs via relay)
  m.setPairedStateListener((paired) => {
    console.log(`[Desktop] Paired state changed: ${paired}`);
    sendGatewayState(true, paired);
  });

  // Synchronous listener — sends code immediately, QR follows async
  m.setPairCodeListener((code, expiresAt) => {
    console.log(`[Desktop] Pair code received: ${code}`);
    latestPairData = { code, expiresAt, qrDataUrl: '' };
    sendPairCode(code, expiresAt);
    generateAndSendQR(code, expiresAt);
  });

  m.setOnUnpair(() => {
    console.log('[Desktop] Unpaired — restarting monitor for re-pairing.');
    latestPairData = null;
    sendGatewayState(false, false);
    setTimeout(async () => {
      monitor = new OpenClawMonitor();
      wireMonitorHooks(monitor);
      await monitor.start();
      sendGatewayState(true, false);
    }, 1000);
  });
}

function sendGatewayState(running: boolean, relayConnected: boolean): void {
  const win = getDropdownWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('gateway:state', { running, relayConnected });
  }
}
