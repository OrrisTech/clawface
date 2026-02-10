#!/usr/bin/env tsx
// ============================================================================
// OpenClaw Monitor - Production Entry Point
// Runs the gateway monitor as a background daemon. After displaying the
// pairing code, the parent process exits and the child continues running
// detached from the terminal.
//
// Usage:
//   npm start                   # Run as background daemon
//   npm start -- --foreground   # Run in foreground (for debugging)
//   npm run stop                # Stop the background daemon
// ============================================================================

import { spawn, execFileSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OpenClawMonitor } from './index.js';
import { PairManager } from './pairManager.js';

const CONFIG_DIR = path.join(os.homedir(), '.openclaw');
const PID_FILE = path.join(CONFIG_DIR, 'gateway.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'gateway.log');
const TOKEN_FILE = path.join(CONFIG_DIR, 'device-token');

const DAEMON_FLAG = '__CLAWFACE_DAEMON__';

/**
 * Ensure the config directory exists.
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load or create a persistent device token.
 */
function loadOrCreateDeviceToken(): string {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (token.length > 0) return token;
    }
  } catch { /* fall through */ }

  ensureConfigDir();
  const token = crypto.randomUUID();
  fs.writeFileSync(TOKEN_FILE, token, 'utf-8');
  return token;
}

/**
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run in daemon (child) mode — the actual monitor process.
 */
async function runDaemon(): Promise<void> {
  ensureConfigDir();

  // Write our PID
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');

  // Redirect console to log file
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const logPrefix = () => `[${new Date().toISOString()}]`;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    logStream.write(`${logPrefix()} ${args.join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    logStream.write(`${logPrefix()} WARN: ${args.join(' ')}\n`);
  };
  console.error = (...args: unknown[]) => {
    logStream.write(`${logPrefix()} ERROR: ${args.join(' ')}\n`);
  };

  console.log('ClawFace gateway daemon started (PID ' + process.pid + ')');

  const monitor = new OpenClawMonitor();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await monitor.stop();
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    logStream.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await monitor.start();
  console.log('Gateway is running. Relay connected.');
}

/**
 * Run in foreground mode — similar to dev.ts but uses OpenClawMonitor directly.
 */
async function runForeground(): Promise<void> {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');

  console.log('ClawFace Gateway (foreground mode)');
  console.log(`PID: ${process.pid}`);
  console.log(`Log: ${LOG_FILE}`);
  console.log('');

  const monitor = new OpenClawMonitor();

  const shutdown = async () => {
    console.log('\nShutting down...');
    await monitor.stop();
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await monitor.start();

  // Display pairing code
  const pm = monitor.getPairManager();
  const code = pm.getCurrentCode();
  if (code) {
    console.log(`Pairing code: ${code}`);
  }
  console.log('Gateway is running. Press Ctrl+C to stop.');
}

/**
 * Spawn the daemon child and print the pairing code, then exit.
 */
function spawnDaemon(): void {
  ensureConfigDir();

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (existingPid && isProcessRunning(existingPid)) {
      console.log(`Gateway is already running (PID ${existingPid}).`);
      console.log(`Log: ${LOG_FILE}`);
      console.log(`To stop: npm run stop`);
      process.exit(0);
    }
    // Stale PID file — clean up
    fs.unlinkSync(PID_FILE);
  }

  // Resolve the tsx binary path
  const tsxBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const scriptPath = path.resolve(__dirname, '..', 'src', 'start.ts');

  // If tsx is not found locally, try npx
  const cmd = fs.existsSync(tsxBin) ? tsxBin : 'npx';
  const args = cmd === 'npx'
    ? ['tsx', scriptPath, DAEMON_FLAG]
    : [scriptPath, DAEMON_FLAG];

  // Open log file for child stdout/stderr
  const logFd = fs.openSync(LOG_FILE, 'a');

  const child: ChildProcess = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  child.unref();
  fs.closeSync(logFd);

  // Wait briefly for the child to start and write its PID
  setTimeout(() => {
    const deviceToken = loadOrCreateDeviceToken();

    console.log('');
    console.log('  ClawFace Gateway Started');
    console.log('  ========================');
    console.log(`  PID:    ${child.pid}`);
    console.log(`  Log:    ${LOG_FILE}`);
    console.log(`  Token:  ${deviceToken.substring(0, 8)}...`);
    console.log('');
    console.log('  Open the ClawFace app and pair with this Mac.');
    console.log('  The gateway runs in the background — you can close this terminal.');
    console.log('');
    console.log('  To stop:  npm run stop');
    console.log('            (or unpair from the ClawFace app)');
    console.log('');

    // Close the terminal window/tab since the daemon runs in the background
    closeTerminalWindow();

    process.exit(0);
  }, 1500);
}

/**
 * Close the terminal window/tab (macOS only). Best-effort, no-op on failure.
 */
function closeTerminalWindow(): void {
  if (process.platform !== 'darwin') return;
  try {
    const frontApp = execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();

    if (frontApp === 'Terminal') {
      execFileSync('osascript', ['-e', 'tell application "Terminal" to close front window'],
        { encoding: 'utf-8', timeout: 3000 });
    } else if (frontApp === 'iTerm2') {
      execFileSync('osascript', ['-e', 'tell application "iTerm2" to tell current session of current window to close'],
        { encoding: 'utf-8', timeout: 3000 });
    }
  } catch { /* best-effort */ }
}

// --- Entry Point ---

const args = process.argv.slice(2);

if (args.includes(DAEMON_FLAG)) {
  // We are the daemon child process
  runDaemon().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
} else if (args.includes('--foreground') || args.includes('-f')) {
  // Run in foreground (for debugging)
  runForeground().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
} else {
  // Default: spawn daemon and exit
  spawnDaemon();
}
