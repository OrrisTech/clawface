// ============================================================================
// OpenClaw Monitor - Main Entry Point
// Ties together all gateway monitor modules: system resource collection,
// AI usage tracking, relay WebSocket connection, and device pairing.
// Designed to be imported into an existing OpenClaw Gateway codebase.
// ============================================================================

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SystemCollector } from './systemCollector.js';
import { AiUsageTracker } from './aiUsageTracker.js';
import { RelayClient } from './relayClient.js';
import { PairManager } from './pairManager.js';
import { OpenClawCollector } from './openclawCollector.js';
import type { MonitorConfig, StatusMessage, AiUsageSummary, CommandMessage, CommandResponse } from './types.js';

// Re-export all modules and types for consumers of this package
export { SystemCollector } from './systemCollector.js';
export { AiUsageTracker } from './aiUsageTracker.js';
export { RelayClient } from './relayClient.js';
export { PairManager } from './pairManager.js';
export { OpenClawCollector } from './openclawCollector.js';
export * from './types.js';

/** Default config values used when fields are missing from the config file */
const DEFAULT_CONFIG: MonitorConfig = {
  relay: {
    enabled: true,
    server: 'wss://relay.clawface.app/gateway',
    autoConnect: true,
    statusInterval: 2000,
  },
  aiUsage: {
    enabled: true,
    retentionDays: 30,
  },
};

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

/**
 * Close the terminal window/tab that launched this process (macOS only).
 * Tries Terminal.app first, then iTerm2. No-op on non-macOS or if the
 * process is running as a detached daemon (no controlling terminal).
 */
function closeTerminalWindow(): void {
  if (process.platform !== 'darwin') return;
  // If running as a daemon (no TTY), skip — nothing to close
  if (!process.stdout.isTTY && !process.stderr.isTTY) return;

  try {
    // Detect which terminal app is frontmost
    const frontApp = execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();

    if (frontApp === 'Terminal') {
      execFileSync(
        'osascript',
        ['-e', 'tell application "Terminal" to close front window'],
        { encoding: 'utf-8', timeout: 3000 },
      );
    } else if (frontApp === 'iTerm2') {
      execFileSync(
        'osascript',
        ['-e', 'tell application "iTerm2" to tell current session of current window to close'],
        { encoding: 'utf-8', timeout: 3000 },
      );
    }
  } catch {
    // Best-effort — don't block shutdown if AppleScript fails
  }
}

/** Path to the config directory */
const CONFIG_DIR = path.join(os.homedir(), '.openclaw');

/** Path to the config file */
const CONFIG_FILE = path.join(CONFIG_DIR, 'monitor.json');

/** Path to the device token file (persisted across restarts) */
const TOKEN_FILE = path.join(CONFIG_DIR, 'device-token');

export class OpenClawMonitor {
  private collector: SystemCollector;
  private tracker: AiUsageTracker | null = null;
  private relay: RelayClient | null = null;
  private pairManager: PairManager;
  private openclawCollector: OpenClawCollector;
  private config: MonitorConfig;
  private statusInterval: NodeJS.Timeout | null = null;
  private logScanInterval: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private _isPaired: boolean = false;

  /** Optional listener called on each status tick (used by Electron UI). */
  private statusListener: ((status: StatusMessage) => void) | null = null;
  /** Optional listener called when pairing code changes. */
  private pairCodeListener: ((code: string, expiresAt: number) => void) | null = null;
  /** Optional callback for unpair — if set, called instead of process.exit(). */
  private onUnpairCallback: (() => void) | null = null;
  /** Optional listener called when paired state changes. */
  private pairedStateListener: ((paired: boolean) => void) | null = null;

  constructor(config?: Partial<MonitorConfig>) {
    // Merge provided config with defaults loaded from file
    const fileConfig = loadConfig();
    this.config = mergeConfig(fileConfig, config);

    // Initialize system collector (always active)
    this.collector = new SystemCollector();

    // Initialize OpenClaw collector for live OpenClaw data
    this.openclawCollector = new OpenClawCollector();

    // Initialize AI usage tracker if enabled
    if (this.config.aiUsage.enabled) {
      this.tracker = new AiUsageTracker();
    }

    // Initialize pair manager with the configured relay URL for QR code generation
    this.pairManager = new PairManager();
    this.pairManager.setRelayUrl(this.config.relay.server);

    // Initialize relay client if enabled
    if (this.config.relay.enabled) {
      const deviceToken = loadOrCreateDeviceToken();
      this.relay = new RelayClient(
        this.config.relay.server,
        deviceToken,
        this.getVersion(),
        (cmd) => this.handleCommand(cmd),
        (code) => this.pairManager.setRelayCode(code),
      );
    }
  }

  // --------------------------------------------------------------------------
  // Event hooks (for Electron desktop app integration)
  // --------------------------------------------------------------------------

  /** Register a listener called on each status tick with the full StatusMessage. */
  setStatusListener(listener: (status: StatusMessage) => void): void {
    this.statusListener = listener;
  }

  /** Register a listener called when the pairing code changes. */
  setPairCodeListener(listener: (code: string, expiresAt: number) => void): void {
    this.pairCodeListener = listener;
    // Also wire into pairManager
    this.pairManager.setCodeChangeListener(listener);
  }

  /** Set a callback for unpair events. If set, the monitor will NOT call process.exit(). */
  setOnUnpair(callback: () => void): void {
    this.onUnpairCallback = callback;
  }

  /** Whether the relay client is currently connected to the relay server. */
  get isRelayConnected(): boolean {
    return this.relay?.isConnected ?? false;
  }

  /** Whether an iOS device is currently paired (confirmed via relay commands). */
  get isPaired(): boolean {
    return this._isPaired;
  }

  /** Register a listener called when paired state changes. */
  setPairedStateListener(listener: (paired: boolean) => void): void {
    this.pairedStateListener = listener;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start all monitor subsystems:
   * 1. Perform an initial system stats collection (primes the CPU delta)
   * 2. Connect to relay if enabled and autoConnect is true
   * 3. Start the periodic status update loop
   * 4. Start pairing code rotation
   * 5. Schedule periodic old-data cleanup
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log('[OpenClawMonitor] Starting...');

    // Prime the CPU usage collector with an initial reading
    await this.collector.collect();

    // Connect to OpenClaw RPC for live data (non-blocking, gracefully degrades)
    await this.openclawCollector.connect();

    // Connect to relay
    if (this.relay && this.config.relay.autoConnect) {
      this.relay.connect();
    }

    // Start periodic status updates
    this.statusInterval = setInterval(
      () => this.tick(),
      this.config.relay.statusInterval,
    );

    // Start pairing code rotation
    this.pairManager.startRotation();

    // Scan local AI logs on startup and periodically (every 60 seconds)
    if (this.tracker) {
      this.tracker.scanLocalLogs();
      this.logScanInterval = setInterval(() => {
        this.tracker?.scanLocalLogs();
      }, 60_000);
    }

    // Schedule daily cleanup of old AI usage data
    if (this.tracker) {
      this.scheduleCleanup();
    }

    console.log('[OpenClawMonitor] Started successfully');
  }

  /**
   * Stop all subsystems gracefully.
   * Clears timers, disconnects from relay, and closes the database.
   * If paired, sends a disconnect notification so the iOS app knows to re-pair.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log('[OpenClawMonitor] Stopping...');

    // Stop the status update loop
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    // Stop the log scan interval
    if (this.logScanInterval) {
      clearInterval(this.logScanInterval);
      this.logScanInterval = null;
    }

    // Stop pairing code rotation
    this.pairManager.stopRotation();

    // Disconnect from OpenClaw RPC
    this.openclawCollector.disconnect();

    // Notify relay that we're disconnecting (so iOS app can show re-pair)
    if (this.relay && this._isPaired) {
      this.relay.sendDisconnect(loadOrCreateDeviceToken(), 'quit');
      // Give the message a moment to be sent before closing
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Disconnect from relay
    if (this.relay) {
      this.relay.disconnect();
    }

    // Close AI usage database
    if (this.tracker) {
      this.tracker.close();
    }

    this._isPaired = false;
    console.log('[OpenClawMonitor] Stopped');
  }

  // --------------------------------------------------------------------------
  // Status tick
  // --------------------------------------------------------------------------

  /**
   * Collect system stats, refresh OpenClaw data, and send a status update
   * to the relay. Called on every tick of the statusInterval timer.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const system = await this.collector.collect();

      // Refresh OpenClaw data from the RPC (no-op if not connected)
      await this.openclawCollector.refresh();

      // Build AI usage summary (always include, even if tracker is disabled)
      let aiUsage: AiUsageSummary;
      if (this.tracker) {
        const summary = this.tracker.getUsageSummary('today');
        aiUsage = {
          period: 'today',
          providers: summary.providers.flatMap((p) =>
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
          totalCostToday: summary.totalCostToday,
          totalCostThisMonth: summary.totalCostThisMonth,
        };
      } else {
        aiUsage = {
          period: 'today',
          providers: [],
          totalCostToday: 0,
          totalCostThisMonth: 0,
        };
      }

      // Build the status message with all data the iOS app expects
      const status: StatusMessage = {
        type: 'status',
        deviceToken: loadOrCreateDeviceToken(),
        timestamp: new Date().toISOString(),
        version: 1,
        hostname: os.hostname(),
        system,
        openclaw: this.openclawCollector.getSnapshot(),
        aiUsage,
      };

      // Notify local listener (Electron UI)
      this.statusListener?.(status);

      // Send to relay (no-op if not connected)
      if (this.relay) {
        this.relay.sendStatus(status);
      }
    } catch (err) {
      console.error('[OpenClawMonitor] Tick error:', err);
    }
  }

  // --------------------------------------------------------------------------
  // Command handling
  // --------------------------------------------------------------------------

  /**
   * Handle a command received from the relay server (triggered by the mobile app).
   * Sends back a CommandResponse with the result or error.
   */
  private handleCommand(cmd: CommandMessage): void {
    console.log(`[OpenClawMonitor] Received command: ${cmd.action} (id=${cmd.id})`);

    // Receiving any command from relay means an iOS device is paired
    if (cmd.action !== 'unpair' && !this._isPaired) {
      this._isPaired = true;
      this.pairedStateListener?.(true);
    }

    let response: CommandResponse;

    try {
      switch (cmd.action) {
        case 'ping':
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: true,
            data: { pong: true, timestamp: Date.now() },
          };
          break;

        case 'get-usage':
          if (!this.tracker) {
            response = {
              type: 'command-response',
              commandId: cmd.id,
              success: false,
              error: 'AI usage tracking is not enabled',
            };
          } else {
            const period = (cmd.payload?.period as 'today' | 'week' | 'month') || 'today';
            const summary = this.tracker.getUsageSummary(period);
            response = {
              type: 'command-response',
              commandId: cmd.id,
              success: true,
              data: summary,
            };
          }
          break;

        case 'pair':
          const code = this.pairManager.getCurrentCode();
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: true,
            data: { code, valid: this.pairManager.isCodeValid() },
          };
          break;

        case 'unpair':
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: true,
            data: { unpaired: true, shutting_down: true },
          };
          // Schedule shutdown after sending the response
          setTimeout(async () => {
            console.log('[OpenClawMonitor] Unpaired by remote app — shutting down...');
            this._isPaired = false;
            this.pairedStateListener?.(false);
            await this.stop();
            // Clean up PID file so `npm run stop` knows we're gone
            const pidFile = path.join(os.homedir(), '.openclaw', 'gateway.pid');
            try { fs.unlinkSync(pidFile); } catch { /* ignore */ }

            if (this.onUnpairCallback) {
              // Electron mode: notify the desktop app instead of exiting
              this.onUnpairCallback();
            } else {
              // Terminal mode: close window and exit process
              closeTerminalWindow();
              process.exit(0);
            }
          }, 500);
          break;

        case 'restart':
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: true,
            data: { restarting: true },
          };
          // Schedule a restart after sending the response
          setTimeout(() => {
            console.log('[OpenClawMonitor] Restarting by command...');
            this.stop().then(() => this.start());
          }, 500);
          break;

        case 'get-logs':
          // Placeholder: in a full implementation this would stream recent logs
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: true,
            data: { message: 'Log streaming not yet implemented' },
          };
          break;

        default:
          response = {
            type: 'command-response',
            commandId: cmd.id,
            success: false,
            error: `Unknown command action: ${cmd.action}`,
          };
      }
    } catch (err) {
      response = {
        type: 'command-response',
        commandId: cmd.id,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }

    if (this.relay) {
      this.relay.sendCommandResponse(response);
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup scheduler
  // --------------------------------------------------------------------------

  /**
   * Schedule daily cleanup of old AI usage data.
   * Runs once at startup and then every 24 hours.
   */
  private scheduleCleanup(): void {
    if (!this.tracker) return;

    // Run cleanup immediately on start
    this.tracker.cleanupOldData(this.config.aiUsage.retentionDays);

    // Then schedule it every 24 hours
    const DAY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      if (this.tracker) {
        this.tracker.cleanupOldData(this.config.aiUsage.retentionDays);
      }
    }, DAY_MS);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Read the package version, falling back to 'unknown' */
  private getVersion(): string {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Expose the AI usage tracker for external code to log requests */
  getTracker(): AiUsageTracker | null {
    return this.tracker;
  }

  /** Expose the pair manager for external access to pairing codes */
  getPairManager(): PairManager {
    return this.pairManager;
  }
}

// ============================================================================
// Config loading utilities
// ============================================================================

/**
 * Load the monitor config from ~/.openclaw/monitor.json.
 * Returns an empty partial config if the file doesn't exist or is invalid.
 */
function loadConfig(): Partial<MonitorConfig> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw) as Partial<MonitorConfig>;
    }
  } catch (err) {
    console.warn('[OpenClawMonitor] Failed to load config file, using defaults:', err);
  }
  return {};
}

/**
 * Deep-merge a file-loaded config and an optional programmatic override
 * on top of the default config.
 */
function mergeConfig(
  fileConfig: Partial<MonitorConfig>,
  overrides?: Partial<MonitorConfig>,
): MonitorConfig {
  return {
    relay: {
      ...DEFAULT_CONFIG.relay,
      ...(fileConfig.relay || {}),
      ...(overrides?.relay || {}),
    },
    aiUsage: {
      ...DEFAULT_CONFIG.aiUsage,
      ...(fileConfig.aiUsage || {}),
      ...(overrides?.aiUsage || {}),
    },
  };
}

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

  // Ensure config directory exists
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Generate a new UUID v4 token
  const token = crypto.randomUUID();
  fs.writeFileSync(TOKEN_FILE, token, 'utf-8');
  console.log(`[OpenClawMonitor] Generated new device token: ${token}`);
  return token;
}

