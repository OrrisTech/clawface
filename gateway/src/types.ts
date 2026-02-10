// ============================================================================
// OpenClaw Monitor - Type Definitions
// Shared TypeScript interfaces for the Gateway monitor data protocol.
// These types define the structure for system stats, AI usage tracking,
// relay communication messages, and monitor configuration.
// ============================================================================

// --- System Resource Stats ---

/** Per-core CPU usage percentage */
export interface CpuStats {
  /** Overall CPU usage percentage (0-100) */
  usage: number;
  /** Number of logical CPU cores */
  cores: number;
  /** Usage percentage for each individual core */
  perCore: number[];
}

export interface MemoryStats {
  /** Memory usage as a percentage (0-100) */
  usagePercent: number;
  /** Memory currently in use, in gigabytes */
  usedGB: number;
  /** Total system memory, in gigabytes */
  totalGB: number;
}

export interface DiskStats {
  /** Disk usage as a percentage (0-100) */
  usagePercent: number;
  /** Disk space currently used, in gigabytes */
  usedGB: number;
  /** Total disk capacity, in gigabytes */
  totalGB: number;
}

export interface TemperatureStats {
  /** CPU temperature in degrees Celsius */
  cpu: number;
}

export interface NetworkStats {
  /** Upload speed in megabytes per second */
  uploadMBps: number;
  /** Download speed in megabytes per second */
  downloadMBps: number;
}

/** Complete snapshot of all system resource statistics */
export interface SystemStats {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStats;
  temperature: TemperatureStats;
  network: NetworkStats;
  /** System uptime in seconds */
  uptime: number;
}

// --- AI Usage Tracking ---

/** Supported AI provider identifiers */
export type AiProvider = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'other';

/** Source of the AI request (which service triggered it) */
export type AiRequestSource = 'telegram' | 'discord' | 'api' | 'claude-code' | 'other';

/** A single logged AI API request with token counts and cost */
export interface AiRequestLog {
  /** Unix timestamp in milliseconds when the request was made */
  timestamp: number;
  /** The AI provider that served the request */
  provider: AiProvider;
  /** The specific model used (e.g., 'claude-sonnet-4-5') */
  model: string;
  /** Number of tokens in the input/prompt */
  inputTokens: number;
  /** Number of tokens in the output/response */
  outputTokens: number;
  /** Number of tokens read from the prompt cache (reduces input cost) */
  cacheReadInputTokens?: number;
  /** Number of tokens written to the prompt cache (higher creation cost) */
  cacheCreationInputTokens?: number;
  /** Estimated cost in USD based on the pricing table */
  estimatedCost: number;
  /** Which service/integration triggered this request */
  source: AiRequestSource;
  /** Optional session identifier for grouping related requests */
  sessionId?: string;
}

/** Aggregated usage data for a single AI provider */
export interface ProviderSummary {
  /** Provider name */
  provider: AiProvider;
  /** Total number of requests in the period */
  requestCount: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
  /** Total cache-read input tokens across all models */
  totalCacheReadInputTokens?: number;
  /** Total cache-creation input tokens across all models */
  totalCacheCreationInputTokens?: number;
  /** Total estimated cost in USD */
  totalCost: number;
  /** Breakdown by model within this provider */
  models: ModelSummary[];
}

/** Aggregated usage for a specific model */
export interface ModelSummary {
  model: string;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Total cache-read input tokens (prompt cache hits) */
  totalCacheReadInputTokens?: number;
  /** Total cache-creation input tokens (prompt cache writes) */
  totalCacheCreationInputTokens?: number;
  totalCost: number;
}

/** Overall usage summary for a given time period */
export interface UsageSummary {
  /** The period this summary covers ('today', 'week', 'month') */
  period: string;
  /** Per-provider breakdown */
  providers: ProviderSummary[];
  /** Total cost for today in USD */
  totalCostToday: number;
  /** Total cost for the current calendar month in USD */
  totalCostThisMonth: number;
}

// --- OpenClaw Snapshot ---

/** Activity state of an individual OpenClaw agent */
export type OpenClawAgentActivity =
  | 'thinking'
  | 'typing'
  | 'browsing'
  | 'toolCalling'
  | 'idle'
  | 'waiting'
  | 'error'
  | 'sleeping';

/** A single agent within an OpenClaw instance */
export interface OpenClawAgentSnapshot {
  /** Unique agent identifier from the OpenClaw config */
  id: string;
  /** Display name for the agent */
  name: string;
  /** Current activity state */
  activity: OpenClawAgentActivity;
  /** Channel the agent is currently handling (e.g. "telegram", "discord") */
  activeChannel: string | null;
  /** Brief description of what the agent is doing right now */
  currentTask: string | null;
  /** AI model the agent is using (e.g. "claude-sonnet-4-5") */
  model: string | null;
  /** Tokens consumed in the current session */
  tokensUsed: number | null;
  /** Duration of the current session in seconds */
  sessionDuration: number | null;
}

/**
 * Point-in-time snapshot of an OpenClaw instance's state.
 * Collected from the OpenClaw config file and WebSocket RPC.
 * Shape matches the iOS app's OpenClawInfo model.
 */
export interface OpenClawSnapshot {
  /** OpenClaw software version string */
  version: string;
  /** Current state: 'running', 'stopped', or 'unknown' */
  status: string;
  /** Whether the OpenClaw service is currently running */
  isRunning: boolean;
  /** Service uptime in seconds since last restart */
  uptime: number;
  /** Active and total session counts */
  sessions: { active: number; total: number };
  /** Context window token usage */
  context: { used: number; limit: number };
  /** Aggregate token throughput counters */
  tokens: { input: number; output: number };
  /**
   * Per-channel connection status.
   * Keys are lowercase channel names (e.g. "telegram", "discord", "whatsapp").
   */
  channels: Record<string, { connected: boolean }>;
  /** Active agents and their current states */
  agents: OpenClawAgentSnapshot[];
}

/** Full AI usage summary included in status messages (matches iOS AiUsageInfo) */
export interface AiUsageSummary {
  /** Time period this data covers (e.g. "today") */
  period: string;
  /** Per-provider usage breakdown */
  providers: Array<{
    name: string;
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    currency: string;
  }>;
  /** Total estimated AI cost for today in USD */
  totalCostToday: number;
  /** Total estimated AI cost for the current month in USD */
  totalCostThisMonth: number;
}

// --- Relay Communication ---

/** Hello message sent to the relay on initial connection */
export interface HelloMessage {
  type: 'hello';
  deviceToken: string;
  gatewayVersion: string;
  hostname: string;
  platform: string;
  arch: string;
}

/** Periodic status update sent to the relay */
export interface StatusMessage {
  type: 'status';
  deviceToken: string;
  /** ISO 8601 timestamp (must be a string for iOS Codable compatibility) */
  timestamp: string;
  /** Hostname of the gateway machine */
  hostname: string;
  /** Protocol version for the iOS app */
  version: number;
  system: SystemStats;
  /** OpenClaw service snapshot (always included; iOS requires this field) */
  openclaw: OpenClawSnapshot;
  /** Full AI usage summary with per-provider breakdown (always included; iOS requires this field) */
  aiUsage: AiUsageSummary;
}

/** Command received from the relay (triggered by the mobile app) */
export interface CommandMessage {
  type: 'command';
  /** Unique identifier for this command */
  id: string;
  /** The action to perform */
  action: 'pair' | 'unpair' | 'restart' | 'get-usage' | 'get-logs' | 'ping';
  /** Optional payload with command-specific data */
  payload?: Record<string, unknown>;
}

/** Response sent back to the relay after executing a command */
export interface CommandResponse {
  type: 'command-response';
  /** The command ID this is responding to */
  commandId: string;
  /** Whether the command executed successfully */
  success: boolean;
  /** Result data or error message */
  data?: unknown;
  error?: string;
}

/** Pairing confirmation message */
export interface PairConfirmMessage {
  type: 'pair-confirm';
  deviceToken: string;
  pairingCode: string;
}

/** Disconnect notification sent to relay when gateway shuts down */
export interface DisconnectMessage {
  type: 'disconnect';
  deviceToken: string;
  reason: 'quit' | 'unpair';
}

/** Union of all messages the gateway can send to the relay */
export type GatewayOutboundMessage =
  | HelloMessage
  | StatusMessage
  | CommandResponse
  | PairConfirmMessage
  | DisconnectMessage;

/** Union of all messages the gateway can receive from the relay */
export type GatewayInboundMessage = CommandMessage;

// --- Configuration ---

export interface RelayConfig {
  /** Whether relay connection is enabled */
  enabled: boolean;
  /** Relay WebSocket server URL (e.g., wss://relay.clawface.app/gateway) */
  server: string;
  /** Whether to connect to the relay automatically on start */
  autoConnect: boolean;
  /** Interval in ms between status updates (default: 2000) */
  statusInterval: number;
}

export interface AiUsageConfig {
  /** Whether AI usage tracking is enabled */
  enabled: boolean;
  /** Number of days to retain detailed usage data (default: 30) */
  retentionDays: number;
}

/** Top-level monitor configuration */
export interface MonitorConfig {
  relay: RelayConfig;
  aiUsage: AiUsageConfig;
}
