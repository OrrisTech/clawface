#!/usr/bin/env tsx
// ============================================================================
// OpenClaw Monitor - Stop Daemon
// Sends SIGTERM to the running gateway daemon and waits for it to exit.
//
// Usage: npm run stop
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';

const PID_FILE = path.join(os.homedir(), '.openclaw', 'gateway.pid');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Gateway is not running (no PID file found).');
    process.exit(0);
  }

  const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (!pid || isNaN(pid)) {
    console.log('Invalid PID file. Removing stale file.');
    fs.unlinkSync(PID_FILE);
    process.exit(0);
  }

  if (!isProcessRunning(pid)) {
    console.log(`Gateway process ${pid} is not running. Cleaning up stale PID file.`);
    fs.unlinkSync(PID_FILE);
    process.exit(0);
  }

  console.log(`Stopping gateway (PID ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to send SIGTERM to ${pid}:`, (err as Error).message);
    process.exit(1);
  }

  // Wait up to 5 seconds for the process to exit
  let waited = 0;
  const interval = setInterval(() => {
    waited += 200;
    if (!isProcessRunning(pid)) {
      clearInterval(interval);
      // Clean up PID file if the daemon didn't remove it
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      console.log('Gateway stopped.');
      process.exit(0);
    }
    if (waited >= 5000) {
      clearInterval(interval);
      console.log(`Process ${pid} did not exit after 5s. Sending SIGKILL...`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* ignore */ }
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      console.log('Gateway force-killed.');
      process.exit(0);
    }
  }, 200);
}

main();
