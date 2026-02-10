#!/usr/bin/env tsx
// ============================================================================
// OpenClaw Monitor - Dev Runner
// Standalone script for local development and testing. Instantiates the
// system collector, AI usage tracker, pair manager, and relay client.
// Connects to the production relay so pairing codes are registered and
// the iPhone app can pair with this gateway.
//
// Usage: npx tsx src/dev.ts
// ============================================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SystemCollector } from './systemCollector.js';
import { AiUsageTracker } from './aiUsageTracker.js';
import { PairManager } from './pairManager.js';
import { RelayClient } from './relayClient.js';
import { OpenClawCollector } from './openclawCollector.js';

/** Map lowercase provider IDs to display names for the iOS app */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral',
};

/** Convert a lowercase provider ID to a title-case display name */
function displayProvider(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}
import type { SystemStats } from './types.js';

const TICK_INTERVAL_MS = 2000;

/** Relay server URL — connects to the production relay for pairing support */
const RELAY_URL = 'wss://relay.clawface.app/gateway';

/** Config directory for persisting the device token across restarts */
const CONFIG_DIR = path.join(os.homedir(), '.openclaw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'device-token');

// Use a temp path for the dev database so we don't pollute the real one
const DEV_DB_PATH = '/tmp/openclaw-dev-usage.db';

const collector = new SystemCollector();
const tracker = new AiUsageTracker(DEV_DB_PATH);
const pairManager = new PairManager();
const openclawCollector = new OpenClawCollector();

/**
 * Load an existing device token from disk, or generate a new one.
 * The token is a random UUID stored at ~/.openclaw/device-token.
 * It persists across restarts so the relay can identify this gateway.
 */
function loadOrCreateDeviceToken(): string {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (token.length > 0) return token;
    }
  } catch {
    // Fall through to generate a new token
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const token = crypto.randomUUID();
  fs.writeFileSync(TOKEN_FILE, token, 'utf-8');
  console.log(`[dev] Generated new device token: ${token}`);
  return token;
}

/**
 * Format a SystemStats snapshot into a readable multi-line string
 * suitable for terminal output.
 */
function formatStats(stats: SystemStats): string {
  const lines: string[] = [];

  // Header with timestamp
  lines.push(`--- OpenClaw Monitor [${new Date().toLocaleTimeString()}] ---`);
  lines.push('');

  // CPU
  const perCoreStr = stats.cpu.perCore.map((v, i) => `  Core ${i}: ${v.toFixed(1)}%`).join('\n');
  lines.push(`CPU: ${stats.cpu.usage.toFixed(1)}% (${stats.cpu.cores} cores)`);
  lines.push(perCoreStr);
  lines.push('');

  // Memory
  lines.push(
    `Memory: ${stats.memory.usagePercent.toFixed(1)}% ` +
    `(${stats.memory.usedGB.toFixed(2)} / ${stats.memory.totalGB.toFixed(2)} GB)`
  );

  // Disk
  lines.push(
    `Disk:   ${stats.disk.usagePercent.toFixed(1)}% ` +
    `(${stats.disk.usedGB.toFixed(2)} / ${stats.disk.totalGB.toFixed(2)} GB)`
  );

  // Temperature
  lines.push(`Temp:   ${stats.temperature.cpu.toFixed(1)} C`);

  // Network
  lines.push(
    `Network: DL ${stats.network.downloadMBps.toFixed(2)} MB/s | ` +
    `UL ${stats.network.uploadMBps.toFixed(2)} MB/s`
  );

  // Uptime
  const uptimeHours = Math.floor(stats.uptime / 3600);
  const uptimeMinutes = Math.floor((stats.uptime % 3600) / 60);
  lines.push(`Uptime: ${uptimeHours}h ${uptimeMinutes}m`);
  lines.push('');

  // AI usage (from dev DB)
  const usage = tracker.getUsageSummary('today');
  lines.push(`AI Cost Today: $${usage.totalCostToday.toFixed(2)} | Month: $${usage.totalCostThisMonth.toFixed(2)}`);

  // Pairing code
  const code = pairManager.getCurrentCode();
  if (code) {
    lines.push(`Pairing Code: ${code}`);
  }

  lines.push('');

  return lines.join('\n');
}

/** Reference to the relay client, set in main() */
let relayRef: RelayClient | null = null;

/**
 * Build a full GatewayStatus message matching the iOS app's expected format.
 * Includes system stats, real OpenClaw data from the collector, and AI usage.
 */
function buildStatusMessage(stats: SystemStats): Record<string, unknown> {
  const usage = tracker.getUsageSummary('today');
  const ocSnapshot = openclawCollector.getSnapshot();

  return {
    type: 'status',
    version: 1,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    system: stats,
    openclaw: ocSnapshot,
    aiUsage: {
      period: 'today',
      providers: usage.providers.flatMap((p) =>
        p.models.map((m) => ({
          name: m.model,
          provider: displayProvider(p.provider),
          requests: m.requestCount,
          inputTokens: m.totalInputTokens,
          outputTokens: m.totalOutputTokens,
          estimatedCost: m.totalCost,
          currency: 'USD',
        })),
      ),
      totalCostToday: usage.totalCostToday,
      totalCostThisMonth: usage.totalCostThisMonth,
    },
  };
}

/**
 * Single tick: collect stats, refresh OpenClaw data, send to relay, and print.
 */
async function tick(): Promise<void> {
  const stats = await collector.collect();

  // Refresh OpenClaw data from the RPC (no-op if not connected)
  await openclawCollector.refresh();

  // Send the full status message to the relay for forwarding to iOS clients
  if (relayRef) {
    const statusMsg = buildStatusMessage(stats);
    relayRef.sendStatus(statusMsg as any);
  }

  console.log(formatStats(stats));
}

/**
 * Main entry point. Connects to the relay, starts pairing code rotation,
 * seeds sample AI usage data, and begins the periodic stats tick loop.
 */
async function main(): Promise<void> {
  const deviceToken = loadOrCreateDeviceToken();

  console.log(`[dev] OpenClaw Monitor Dev Runner`);
  console.log(`[dev] Hostname: ${os.hostname()}`);
  console.log(`[dev] Platform: ${os.platform()} ${os.arch()}`);
  console.log(`[dev] Device Token: ${deviceToken}`);
  console.log(`[dev] Relay URL: ${RELAY_URL}`);
  console.log(`[dev] Collecting stats every ${TICK_INTERVAL_MS}ms...`);
  console.log('');

  // Seed a few sample AI requests so the usage summary has data to show
  seedSampleUsage();

  // Connect to OpenClaw RPC for live data (non-blocking, gracefully degrades)
  await openclawCollector.connect();

  // Connect to the relay so pairing codes are registered in KV.
  // When the relay sends a pair_code message, display it via PairManager.
  const relay = new RelayClient(
    RELAY_URL,
    deviceToken,
    'dev',
    (cmd) => {
      console.log(`[dev] Received command: ${cmd.action} (id=${cmd.id})`);
    },
    (code) => pairManager.setRelayCode(code),
  );
  relayRef = relay;
  relay.connect();

  // Also start local pairing code rotation as a fallback display
  // (the relay's pair_code message will override with the registered code)
  pairManager.startRotation();

  // Prime the collector with a first reading (CPU delta needs a baseline)
  await collector.collect();

  // Start the periodic tick
  const interval = setInterval(() => {
    tick().catch((err) => console.error('[dev] Tick error:', err));
  }, TICK_INTERVAL_MS);

  // Graceful shutdown on SIGINT (Ctrl+C)
  process.on('SIGINT', () => {
    console.log('\n[dev] Shutting down...');
    clearInterval(interval);
    openclawCollector.disconnect();
    relay.disconnect();
    tracker.close();
    process.exit(0);
  });
}

/**
 * Insert a handful of sample AI request logs into the dev database
 * so that the usage summary section is not empty during dev testing.
 */
function seedSampleUsage(): void {
  const now = Date.now();

  tracker.logRequest({
    timestamp: now - 60_000,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 1500,
    outputTokens: 800,
    source: 'claude-code',
  });

  tracker.logRequest({
    timestamp: now - 30_000,
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 2000,
    outputTokens: 1200,
    source: 'api',
  });

  tracker.logRequest({
    timestamp: now - 10_000,
    provider: 'deepseek',
    model: 'deepseek-r1',
    inputTokens: 5000,
    outputTokens: 3000,
    source: 'telegram',
  });

  console.log('[dev] Seeded 3 sample AI usage records');
}

main().catch((err) => {
  console.error('[dev] Fatal error:', err);
  process.exit(1);
});
