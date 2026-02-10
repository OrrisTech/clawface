// ============================================================================
// OpenClaw Monitor - OpenClaw Collector
// Gathers runtime data from a local OpenClaw instance via two sources:
//   1. Config file (~/.openclaw/openclaw.json) for static agent/channel defs
//   2. WebSocket RPC (ws://localhost:{port}) for live status, channels, sessions
//
// The collector exposes a snapshot that matches the iOS app's OpenClawInfo model.
// Handles graceful degradation when OpenClaw is not installed or not running.
//
// RPC Protocol:
//   The OpenClaw gateway uses a challenge-response WebSocket protocol.
//   On connect the server sends a connect.challenge event with a nonce.
//   The client must reply with a "connect" RPC that echoes the nonce and
//   declares its role/scopes.  Only after a successful connect response
//   will subsequent RPC calls be accepted.
// ============================================================================

import WebSocket from 'ws';
import JSON5 from 'json5';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import type { OpenClawSnapshot, OpenClawAgentSnapshot, OpenClawAgentActivity } from './types.js';

// --- OpenClaw Config File Types ---

/** Shape of an agent definition in the OpenClaw config file (agents.list[]) */
interface ConfigAgent {
  id?: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  model?: { primary?: string; fallbacks?: string[] } | string;
  subagents?: { allowAgents?: string[] };
}

/** Shape of the OpenClaw config file (~/.openclaw/openclaw.json) */
interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      workspace?: string;
      maxConcurrent?: number;
    };
    list?: ConfigAgent[];
  };
  controlUI?: { port?: number; auth?: { token?: string; password?: string } };
  bindings?: Array<{ agentId?: string; match?: Record<string, unknown> }>;
  [key: string]: unknown;
}

// --- RPC Message Types ---

/** Outbound RPC request sent to the OpenClaw control WebSocket */
interface RpcRequest {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Inbound RPC response from OpenClaw */
interface RpcResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Pending RPC call tracked internally for promise resolution */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

// --- Constants ---

/** Default OpenClaw control UI port */
const DEFAULT_PORT = 18789;

/** RPC call timeout in milliseconds */
const RPC_TIMEOUT_MS = 5000;

/** Path to the OpenClaw config directory */
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');

/** Path to the OpenClaw config file */
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');

/** Path to the device identity file */
const IDENTITY_PATH = path.join(OPENCLAW_DIR, 'identity', 'device.json');

/** WebSocket reconnect delay when the connection drops (ms) */
const RECONNECT_DELAY_MS = 10000;

/** Ed25519 SPKI DER prefix (12 bytes) — stripped to get the raw 32-byte public key */
const ED25519_SPKI_PREFIX_LEN = 12;

// --- Device Identity Types ---

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// --- Crypto Helpers ---

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  return (spki as Buffer).subarray(ED25519_SPKI_PREFIX_LEN);
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce?: string;
}): string {
  const version = params.nonce ? 'v2' : 'v1';
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
  ];
  if (version === 'v2') base.push(params.nonce || '');
  return base.join('|');
}

/**
 * Collector that gathers OpenClaw runtime data from the config file and
 * WebSocket RPC. Produces snapshots matching the iOS app's OpenClawInfo model.
 *
 * Usage:
 *   const collector = new OpenClawCollector();
 *   await collector.connect();          // non-blocking, logs on failure
 *   await collector.refresh();          // poll all RPC methods
 *   const snapshot = collector.getSnapshot();
 *   collector.disconnect();
 */
export class OpenClawCollector {
  // --- Internal State ---

  /** Parsed OpenClaw config (null if file not found or parse failed) */
  private config: OpenClawConfig | null = null;

  /** Active WebSocket connection to the OpenClaw control UI */
  private ws: WebSocket | null = null;

  /** Map of pending RPC calls awaiting responses */
  private pendingCalls: Map<string, PendingCall> = new Map();

  /** Whether the RPC WebSocket has completed the protocol handshake */
  private rpcConnected = false;

  /** Whether we should attempt to reconnect after a disconnect */
  private shouldReconnect = true;

  /** Timer handle for reconnection attempts */
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** The control UI port parsed from config (default 18789) */
  private port: number = DEFAULT_PORT;

  /** Gateway auth token from gateway.auth.token in config */
  private gatewayAuthToken: string | null = null;

  /** Device identity for Ed25519 signed handshake */
  private deviceIdentity: DeviceIdentity | null = null;

  /** The latest collected snapshot */
  private snapshot: OpenClawSnapshot;

  /** Timestamp of the last successful RPC refresh */
  private lastRefreshTime = 0;

  /** Cached OpenClaw CLI version */
  private cliVersion: string | null = null;

  /** Timestamp when the RPC handshake succeeded (for uptime estimation) */
  private connectedSince = 0;

  /** Whether the status RPC already populated session aggregates this cycle */
  private statusHadSessions = false;

  /** Raw session objects from sessions.list for agent enrichment */
  private sessionsList: Array<Record<string, unknown>> = [];

  // --- Constructor ---

  constructor() {
    this.snapshot = this.createDefaultSnapshot();
    this.loadConfig();
    this.loadDeviceIdentity();
    this.cliVersion = this.detectCliVersion();
  }

  // --- Public API ---

  /**
   * Connect to the OpenClaw control WebSocket.
   * Non-blocking: logs a warning if the connection fails and retries later.
   * Safe to call even if OpenClaw is not installed.
   */
  async connect(): Promise<void> {
    this.shouldReconnect = true;

    // If no config was loaded, OpenClaw is likely not installed
    if (!this.config) {
      console.log('[OpenClawCollector] No config found at ~/.openclaw/openclaw.json — OpenClaw may not be installed');
    }

    this.connectWebSocket();
  }

  /**
   * Poll all RPC methods and update the internal snapshot.
   * Call this before getSnapshot() to ensure fresh data.
   * If the RPC is not connected, the snapshot retains its last values
   * with status set to "stopped".
   */
  async refresh(): Promise<void> {
    // Always re-read config to pick up hot-reloaded changes
    this.loadConfig();

    if (!this.rpcConnected) {
      // Not connected to RPC — mark as stopped but populate agents from config
      this.snapshot.status = 'stopped';
      this.snapshot.isRunning = false;
      this.populateAgentsFromConfig();
      this.populateChannelsFromConfig();
      return;
    }

    try {
      // Fire all RPC calls in parallel for speed
      const [statusResult, channelsResult, sessionsResult] = await Promise.allSettled([
        this.rpcCall('status'),
        this.rpcCall('channels.status'),
        this.rpcCall('sessions.list'),
      ]);

      // Mark as running since the RPC responded
      this.snapshot.status = 'running';
      this.snapshot.isRunning = true;
      if (this.cliVersion) {
        this.snapshot.version = this.cliVersion;
      }
      // Estimate uptime from when we connected (gateway was already running)
      if (this.connectedSince > 0) {
        this.snapshot.uptime = Math.floor((Date.now() - this.connectedSince) / 1000);
      }

      // --- Process status ---
      this.statusHadSessions = false;
      this.sessionsList = [];
      if (statusResult.status === 'fulfilled' && statusResult.value) {
        const s = statusResult.value as Record<string, unknown>;

        // The status response contains session summaries we can use
        if (s.sessions && typeof s.sessions === 'object') {
          const sessInfo = s.sessions as Record<string, unknown>;
          if (typeof sessInfo.count === 'number') {
            this.snapshot.sessions.total = sessInfo.count;
          }
          if (sessInfo.defaults && typeof sessInfo.defaults === 'object') {
            const defaults = sessInfo.defaults as Record<string, unknown>;
            if (typeof defaults.contextTokens === 'number') {
              this.snapshot.context.limit = defaults.contextTokens;
            }
          }

          // Aggregate token usage from recent sessions
          if (Array.isArray(sessInfo.recent)) {
            let totalInput = 0;
            let totalOutput = 0;
            let activeSessions = 0;
            let newestActiveTokens = 0;
            let newestActiveAge = Infinity;
            for (const sess of sessInfo.recent) {
              if (typeof sess === 'object' && sess !== null) {
                const s = sess as Record<string, unknown>;
                totalInput += (s.inputTokens as number) || 0;
                totalOutput += (s.outputTokens as number) || 0;
                // Count sessions active in the last 10 minutes
                const age = s.age as number;
                if (typeof age === 'number' && age < 600000) {
                  activeSessions++;
                  // Track the most recently active session for context usage
                  if (age < newestActiveAge) {
                    newestActiveAge = age;
                    newestActiveTokens = (s.totalTokens as number) || 0;
                  }
                }
              }
            }
            this.snapshot.tokens.input = totalInput;
            this.snapshot.tokens.output = totalOutput;
            // Context.used = most recently active session's tokens (not sum of all)
            this.snapshot.context.used = newestActiveTokens;
            this.snapshot.sessions.active = activeSessions;
            this.statusHadSessions = true;
          }
        }
      }

      // --- Process channels ---
      if (channelsResult.status === 'fulfilled' && channelsResult.value) {
        const data = channelsResult.value as Record<string, unknown>;
        this.processChannelStatus(data);
      } else {
        // Fall back to config-based channels with unknown status
        this.populateChannelsFromConfig();
      }

      // --- Process sessions ---
      if (sessionsResult.status === 'fulfilled' && sessionsResult.value) {
        const data = sessionsResult.value as Record<string, unknown>;
        this.processSessionsList(data);
      }

      // Populate agents from config + enrich with session data
      this.populateAgentsFromConfig();

      this.lastRefreshTime = Date.now();
    } catch (err) {
      console.error('[OpenClawCollector] Refresh error:', err);
    }
  }

  /**
   * Get the latest OpenClaw snapshot.
   * Returns default "stopped" state if no data has been collected.
   */
  getSnapshot(): OpenClawSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Disconnect from the OpenClaw RPC WebSocket.
   * Disables auto-reconnect and cleans up all pending calls.
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending RPC calls
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Collector disconnecting'));
    }
    this.pendingCalls.clear();

    if (this.ws) {
      this.ws.close(1000, 'Collector shutting down');
      this.ws = null;
    }

    this.rpcConnected = false;
    console.log('[OpenClawCollector] Disconnected');
  }

  // --- Config Loading ---

  /**
   * Load and parse the OpenClaw config file.
   * Uses JSON5 to handle comments and trailing commas.
   */
  private loadConfig(): void {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return;

      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      this.config = JSON5.parse(raw) as OpenClawConfig;

      // Extract gateway settings
      const gw = (this.config as Record<string, unknown>)?.gateway as Record<string, unknown> | undefined;
      if (gw?.port && typeof gw.port === 'number') {
        this.port = gw.port;
      }
      if (gw?.auth && typeof gw.auth === 'object') {
        const auth = gw.auth as Record<string, unknown>;
        if (typeof auth.token === 'string') {
          this.gatewayAuthToken = auth.token;
        }
      }
    } catch (err) {
      // Only log on first failure to avoid spamming
      if (!this.config) {
        console.warn('[OpenClawCollector] Failed to parse config:', (err as Error).message);
      }
    }
  }

  /**
   * Load the device identity (Ed25519 keypair) from ~/.openclaw/identity/device.json.
   * Required for the signed WebSocket handshake with the OpenClaw gateway.
   */
  private loadDeviceIdentity(): void {
    try {
      if (!fs.existsSync(IDENTITY_PATH)) return;

      const raw = fs.readFileSync(IDENTITY_PATH, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
        this.deviceIdentity = {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    } catch (err) {
      console.warn('[OpenClawCollector] Failed to load device identity:', (err as Error).message);
    }
  }

  /**
   * Detect the installed OpenClaw CLI version via `openclaw --version`.
   */
  private detectCliVersion(): string | null {
    try {
      const output = execFileSync('openclaw', ['--version'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  // --- WebSocket RPC Connection ---

  /**
   * Establish the WebSocket connection to the OpenClaw control UI.
   * Waits for the connect.challenge event and completes the protocol handshake.
   */
  private connectWebSocket(): void {
    const url = `ws://127.0.0.1:${this.port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.log(`[OpenClawCollector] Cannot create WebSocket to ${url}: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`[OpenClawCollector] WebSocket open to ws://127.0.0.1:${this.port}, awaiting challenge...`);
      // Don't set rpcConnected yet — wait for handshake completion
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', () => {
      this.rpcConnected = false;
      this.connectedSince = 0;
      this.rejectAllPending('Connection closed');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      // Suppress ECONNREFUSED noise when OpenClaw is simply not running
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        console.log('[OpenClawCollector] OpenClaw not available on port ' + this.port);
      } else {
        console.warn(`[OpenClawCollector] WebSocket error: ${err.message}`);
      }
    });
  }

  /**
   * Schedule a reconnection attempt after a delay.
   * Only one reconnect timer runs at a time.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connectWebSocket();
      }
    }, RECONNECT_DELAY_MS);
  }

  // --- RPC Communication ---

  /**
   * Send an RPC request and wait for the response.
   * Returns the payload on success, throws on timeout or error.
   */
  private rpcCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const id = crypto.randomUUID();
      const request: RpcRequest = { type: 'req', id, method };
      if (params) request.params = params;

      // Set a timeout so we don't wait forever
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pendingCalls.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCalls.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Handle an incoming WebSocket message.
   * Routes RPC responses to their pending promise resolvers,
   * and handles the protocol handshake (connect.challenge -> connect).
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;

      if (msg.type === 'res') {
        const res = msg as unknown as RpcResponse;
        const pending = this.pendingCalls.get(res.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(res.id);
          if (res.ok) {
            pending.resolve(res.payload);
          } else {
            pending.reject(new Error(res.error || 'RPC error'));
          }
        }
      } else if (msg.type === 'event') {
        this.handleEvent(msg);
      }
    } catch (err) {
      console.warn('[OpenClawCollector] Failed to parse message:', (err as Error).message);
    }
  }

  /**
   * Handle an OpenClaw real-time event.
   * Critically, this handles the connect.challenge event that kicks off
   * the protocol handshake required before any RPC calls work.
   */
  private handleEvent(event: Record<string, unknown>): void {
    const eventName = event.event as string;

    if (eventName === 'connect.challenge') {
      // Gateway sent a challenge — respond with connect handshake using device identity
      const payload = event.payload as Record<string, unknown> | undefined;
      const nonce = payload?.nonce as string | undefined;

      console.log('[OpenClawCollector] Received connect.challenge, sending handshake...');

      const role = 'operator';
      const scopes = ['operator.read'];
      const clientId = 'gateway-client';
      const clientMode = 'backend';
      const signedAtMs = Date.now();

      const connectParams: Record<string, unknown> = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: this.cliVersion || '1.0.0',
          platform: os.platform(),
          mode: clientMode,
        },
        role,
        scopes,
      };

      // Build device identity proof with Ed25519 signature
      if (this.deviceIdentity) {
        const authPayload = buildDeviceAuthPayload({
          deviceId: this.deviceIdentity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs,
          token: this.gatewayAuthToken || '',
          nonce,
        });

        const signature = base64UrlEncode(
          crypto.sign(
            null,
            Buffer.from(authPayload, 'utf8'),
            crypto.createPrivateKey(this.deviceIdentity.privateKeyPem),
          ),
        );

        const publicKeyB64 = base64UrlEncode(
          derivePublicKeyRaw(this.deviceIdentity.publicKeyPem),
        );

        connectParams.device = {
          id: this.deviceIdentity.deviceId,
          publicKey: publicKeyB64,
          signature,
          signedAt: signedAtMs,
          nonce,
        };
      }

      // Include gateway auth token if configured
      if (this.gatewayAuthToken) {
        connectParams.auth = { token: this.gatewayAuthToken };
      }

      this.rpcCall('connect', connectParams)
        .then(() => {
          console.log('[OpenClawCollector] RPC handshake succeeded');
          this.rpcConnected = true;
          this.connectedSince = Date.now();
        })
        .catch((err) => {
          console.warn('[OpenClawCollector] RPC handshake failed:', (err as Error).message);
          // Don't set rpcConnected — RPC calls will be skipped during refresh
        });
    }
    // Future: handle other events like agent state changes
  }

  /**
   * Reject all pending RPC calls with the given reason.
   * Called when the WebSocket connection is lost.
   */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingCalls.clear();
  }

  // --- Snapshot Building ---

  /**
   * Create a default "stopped" snapshot with empty data.
   * Used as the initial state before any data is collected.
   */
  private createDefaultSnapshot(): OpenClawSnapshot {
    return {
      version: 'unknown',
      status: 'stopped',
      isRunning: false,
      uptime: 0,
      sessions: { active: 0, total: 0 },
      context: { used: 0, limit: 200000 },
      tokens: { input: 0, output: 0 },
      channels: {},
      agents: [],
    };
  }

  /**
   * Populate the snapshot's agent list from config file definitions.
   * The OpenClaw config stores agents at agents.list[] with a nested
   * agents.defaults for shared settings like the default model.
   */
  private populateAgentsFromConfig(): void {
    const agentList = this.config?.agents?.list;
    if (!agentList || !Array.isArray(agentList)) {
      this.snapshot.agents = [];
      return;
    }

    const defaultModel = this.config?.agents?.defaults?.model?.primary || null;

    // Build per-agent session data from sessions.list.
    // Session keys follow pattern: agent:{agentId}:{channel}:{type}:{id}
    const agentSessions = this.buildAgentSessionMap();

    this.snapshot.agents = agentList.map((agent, index) => {
      // Agent model can be a string or {primary, fallbacks} object
      let model: string | null = null;
      if (typeof agent.model === 'string') {
        model = agent.model;
      } else if (agent.model && typeof agent.model === 'object') {
        model = agent.model.primary || null;
      }

      const agentId = agent.id || `agent-${index}`;
      const sessionData = agentSessions.get(agentId);

      // Strip provider prefix (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
      // so model names match the normalized format used in AI usage
      let resolvedModel = model || defaultModel;
      if (resolvedModel && resolvedModel.includes('/')) {
        resolvedModel = resolvedModel.split('/').pop()!;
      }

      return {
        id: agentId,
        name: agent.name || `Agent ${index + 1}`,
        activity: (this.rpcConnected ? 'idle' : 'sleeping') as OpenClawAgentActivity,
        activeChannel: sessionData?.channel || null,
        currentTask: null,
        model: resolvedModel,
        tokensUsed: sessionData?.tokensUsed ?? null,
        sessionDuration: sessionData?.sessionDuration ?? null,
      };
    });
  }

  /**
   * Build a map from agent ID to the most recently active session's data.
   * Parses session keys (agent:{agentId}:{channel}:...) to associate sessions
   * with agents, then picks the newest session per agent.
   */
  private buildAgentSessionMap(): Map<string, { tokensUsed: number; sessionDuration: number; channel: string }> {
    const result = new Map<string, { tokensUsed: number; sessionDuration: number; channel: string }>();
    if (this.sessionsList.length === 0) return result;

    // Track the most recently updated session per agent
    const newestByAgent = new Map<string, { updatedAt: number; tokens: number; duration: number; channel: string }>();

    for (const sess of this.sessionsList) {
      const key = sess.key as string;
      if (typeof key !== 'string') continue;

      // Parse: agent:{agentId}:{channel}:{type}:{id}
      const parts = key.split(':');
      if (parts.length < 3 || parts[0] !== 'agent') continue;

      const agentId = parts[1];
      const channel = parts[2];
      const updatedAt = (sess.updatedAt as number) || 0;
      const createdAt = (sess.createdAt as number) || updatedAt;
      const totalTokens = (sess.totalTokens as number) || 0;
      const durationSec = updatedAt > createdAt ? Math.round((updatedAt - createdAt) / 1000) : 0;

      const existing = newestByAgent.get(agentId);
      if (!existing || updatedAt > existing.updatedAt) {
        newestByAgent.set(agentId, { updatedAt, tokens: totalTokens, duration: durationSec, channel });
      }
    }

    for (const [agentId, data] of newestByAgent) {
      result.set(agentId, { tokensUsed: data.tokens, sessionDuration: data.duration, channel: data.channel });
    }

    return result;
  }

  /**
   * Populate channels from the config bindings with "connected: false" status.
   * The OpenClaw config uses bindings[] to map agents to channels, not a
   * top-level channels object.
   */
  private populateChannelsFromConfig(): void {
    const channels: Record<string, { connected: boolean }> = {};

    // Extract channel names from bindings
    if (this.config?.bindings && Array.isArray(this.config.bindings)) {
      for (const binding of this.config.bindings) {
        const channel = binding.match?.channel as string | undefined;
        if (channel) {
          channels[channel.toLowerCase()] = { connected: false };
        }
      }
    }

    this.snapshot.channels = channels;
  }

  /**
   * Process the channels.status RPC response and update the snapshot.
   * The actual response has structure:
   *   { channels: { telegram: { configured, running, ... }, discord: { ... } } }
   */
  private processChannelStatus(data: Record<string, unknown>): void {
    const channels: Record<string, { connected: boolean }> = {};

    // The channel data is nested under a "channels" key
    const channelMap = (data.channels || data) as Record<string, unknown>;

    for (const [name, value] of Object.entries(channelMap)) {
      // Skip non-channel metadata keys
      if (name === 'ts' || name === 'channelOrder' || name === 'channelLabels' ||
          name === 'channelDetailLabels' || name === 'channelSystemImages' ||
          name === 'channelMeta' || name === 'channelAccounts') {
        continue;
      }

      if (typeof value === 'object' && value !== null) {
        const status = value as Record<string, unknown>;
        // A channel is "connected" if it's both configured and running
        channels[name.toLowerCase()] = {
          connected: status.running === true && status.configured === true,
        };
      } else if (typeof value === 'boolean') {
        channels[name.toLowerCase()] = { connected: value };
      }
    }

    this.snapshot.channels = channels;
  }

  /**
   * Process the sessions.list RPC response.
   * The actual response has structure:
   *   { count: number, sessions: [...], defaults: { model, contextTokens } }
   *
   * If the status RPC already populated session aggregates (total, active,
   * tokens, context), those values are more authoritative (status.sessions.count
   * includes ALL sessions while sessions.list only returns a recent subset,
   * and status provides server-computed age rather than clock-dependent deltas).
   * In that case we only store the individual sessions for agent enrichment.
   */
  private processSessionsList(data: Record<string, unknown>): void {
    // Always update context.limit from defaults (both sources agree)
    if (typeof data.defaults === 'object' && data.defaults !== null) {
      const defaults = data.defaults as Record<string, unknown>;
      if (typeof defaults.contextTokens === 'number') {
        this.snapshot.context.limit = defaults.contextTokens;
      }
    }

    // Store raw sessions for agent enrichment in populateAgentsFromConfig()
    if (Array.isArray(data.sessions)) {
      this.sessionsList = data.sessions.filter(
        (s): s is Record<string, unknown> => typeof s === 'object' && s !== null
      );
    }

    // If status already set session aggregates, don't overwrite with less
    // authoritative data (status.count=65 vs sessions.list.count=28)
    if (this.statusHadSessions) return;

    // Fallback: status RPC failed, use sessions.list for aggregates
    if (typeof data.count === 'number') {
      this.snapshot.sessions.total = data.count;
    }

    let totalInput = 0;
    let totalOutput = 0;
    let activeSessions = 0;
    let newestActiveTokens = 0;
    let newestUpdatedAt = 0;

    for (const s of this.sessionsList) {
      totalInput += (s.inputTokens as number) || 0;
      totalOutput += (s.outputTokens as number) || 0;

      const updatedAt = s.updatedAt as number;
      if (typeof updatedAt === 'number') {
        const age = Date.now() - updatedAt;
        if (age < 600000) {
          activeSessions++;
          if (updatedAt > newestUpdatedAt) {
            newestUpdatedAt = updatedAt;
            newestActiveTokens = (s.totalTokens as number) || 0;
          }
        }
      }
    }

    this.snapshot.tokens.input = totalInput;
    this.snapshot.tokens.output = totalOutput;
    this.snapshot.context.used = newestActiveTokens;
    this.snapshot.sessions.active = activeSessions;
  }
}
