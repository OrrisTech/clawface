// ============================================================================
// OpenClaw Monitor - Shared Type Definitions (Single Source of Truth)
// ============================================================================
// Canonical TypeScript interfaces for the data protocol used across all
// three components: Gateway (Mac), Relay (Cloudflare Workers), and App (iPhone).
//
// All projects should import from this package instead of defining their own
// types. This ensures protocol consistency across the entire system.
//
// Data flow:
//   Gateway --[StatusMessage]--> Relay --[StatusMessage]--> App
//   App --[CommandMessage]--> Relay --[CommandMessage]--> Gateway
// ============================================================================

// ============================================================================
// Section 1: System Resource Metrics
// ============================================================================
// These interfaces describe the hardware/OS stats collected by the Gateway.
// The Gateway collects these every ~2 seconds and sends them in StatusMessage.
// ============================================================================

/** CPU usage statistics including per-core breakdown. */
export interface CpuStats {
  /** Overall CPU usage percentage (0-100) */
  usage: number;
  /** Number of logical CPU cores */
  cores: number;
  /** Usage percentage for each individual core */
  perCore: number[];
}

/** RAM usage statistics. */
export interface MemoryStats {
  /** Memory usage as a percentage (0-100) */
  usagePercent: number;
  /** Memory currently in use, in gigabytes */
  usedGB: number;
  /** Total system memory, in gigabytes */
  totalGB: number;
}

/** Disk usage statistics for the primary volume. */
export interface DiskStats {
  /** Disk usage as a percentage (0-100) */
  usagePercent: number;
  /** Disk space currently used, in gigabytes */
  usedGB: number;
  /** Total disk capacity, in gigabytes */
  totalGB: number;
}

/** Temperature sensor readings. */
export interface TemperatureStats {
  /** CPU temperature in degrees Celsius */
  cpu: number;
}

/** Network throughput statistics. */
export interface NetworkStats {
  /** Upload speed in megabytes per second */
  uploadMBps: number;
  /** Download speed in megabytes per second */
  downloadMBps: number;
}

/**
 * Complete snapshot of all system resource statistics.
 * Nested inside StatusMessage.system.
 */
export interface SystemStats {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStats;
  temperature: TemperatureStats;
  network: NetworkStats;
  /** System uptime in seconds */
  uptime: number;
}

// ============================================================================
// Section 2: OpenClaw Application Metrics
// ============================================================================
// Describes the state of the OpenClaw gateway application itself,
// including session counts, context window usage, and channel connectivity.
// ============================================================================

/** Active and total session counts for OpenClaw. */
export interface OpenClawSessions {
  /** Currently active sessions */
  active: number;
  /** Total sessions since last restart */
  total: number;
}

/** Context window usage for the active AI model. */
export interface OpenClawContext {
  /** Tokens used in the current context */
  used: number;
  /** Maximum context window size */
  limit: number;
}

/** Token counts for the current period. */
export interface OpenClawTokens {
  /** Total input tokens consumed */
  input: number;
  /** Total output tokens generated */
  output: number;
}

/** Connection status for a single chat channel. */
export interface ChannelStatus {
  /** Whether the channel bot is currently connected */
  connected: boolean;
}

/** Connection status for all integrated chat channels. */
export interface OpenClawChannels {
  telegram: ChannelStatus;
  discord: ChannelStatus;
}

// ---- Agent Activity Tracking ----

/** What an individual agent is currently doing. */
export type AgentActivityState =
  | 'thinking'     // Processing/reasoning
  | 'typing'       // Generating response text
  | 'browsing'     // Opening websites/apps
  | 'toolCalling'  // Calling external tools/APIs
  | 'idle'         // No active task
  | 'waiting'      // Waiting for user input
  | 'error'        // Something went wrong
  | 'sleeping';    // Agent paused/disabled

/** Individual agent info within an OpenClaw instance. */
export interface AgentInfo {
  /** Unique agent identifier */
  id: string;
  /** Display name for the agent */
  name: string;
  /** Current activity state */
  activity: AgentActivityState;
  /** Active channel the agent is working on (telegram, discord, web, etc.) */
  activeChannel?: string;
  /** Brief description of the current task */
  currentTask?: string;
  /** AI model the agent is using */
  model?: string;
  /** Tokens consumed in the current session */
  tokensUsed?: number;
  /** Duration of the current session in seconds */
  sessionDuration?: number;
}

/**
 * OpenClaw application state and metrics.
 * Nested inside StatusMessage.openclaw.
 */
export interface OpenClawInfo {
  /** OpenClaw gateway software version */
  version: string;
  /** Current operational status */
  status: 'running' | 'stopped' | 'error';
  /** OpenClaw process uptime in seconds */
  uptime: number;
  /** Session counts */
  sessions: OpenClawSessions;
  /** Context window usage */
  context: OpenClawContext;
  /** Token consumption */
  tokens: OpenClawTokens;
  /** Chat channel connectivity */
  channels: OpenClawChannels;
  /** Active agents in this OpenClaw instance */
  agents: AgentInfo[];
}

/** Derived office environment metrics, normalized 0-100. */
export interface OfficeEnvironment {
  /** Normalized temperature (0-100) */
  temperature: number;
  /** Busy level derived from CPU + sessions (0-100) */
  busyLevel: number;
  /** Network activity level (0-100) */
  networkActivity: number;
}

// ============================================================================
// Section 3: AI Usage Tracking
// ============================================================================
// Tracks AI API consumption across providers and models.
// Used for cost monitoring and the AI Usage tab in the app.
// ============================================================================

/** Supported AI provider identifiers. */
export type AiProviderName = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'other';

/** Source of the AI request (which service triggered it). */
export type AiRequestSource = 'telegram' | 'discord' | 'api' | 'claude-code' | 'other';

/**
 * A single logged AI API request with token counts and cost.
 * Used internally by the Gateway for detailed tracking; not sent in StatusMessage.
 */
export interface AiRequestLog {
  /** Unix timestamp in milliseconds when the request was made */
  timestamp: number;
  /** The AI provider that served the request */
  provider: AiProviderName;
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

/** Aggregated usage for a specific model within a provider. */
export interface ModelSummary {
  /** Model identifier (e.g., 'claude-sonnet-4-5') */
  model: string;
  /** Total number of requests */
  requestCount: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
  /** Total cache-read input tokens (prompt cache hits) */
  totalCacheReadInputTokens?: number;
  /** Total cache-creation input tokens (prompt cache writes) */
  totalCacheCreationInputTokens?: number;
  /** Total estimated cost in USD */
  totalCost: number;
}

/**
 * Per-provider usage summary sent in StatusMessage.aiUsage.providers[].
 * Displayed in the AI Usage tab with per-model breakdown.
 */
export interface AiProviderSummary {
  /** Provider display name */
  name: string;
  /** Provider identifier */
  provider: AiProviderName | string;
  /** Total requests in the summary period */
  requests: number;
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens generated */
  outputTokens: number;
  /** Total cache-read input tokens across all models */
  cacheReadInputTokens?: number;
  /** Total cache-creation input tokens across all models */
  cacheCreationInputTokens?: number;
  /** Estimated total cost in USD */
  estimatedCost: number;
  /** Currency code (default: 'USD') */
  currency: string;
  /** Optional per-model breakdown (for detailed view) */
  models?: ModelSummary[];
}

/**
 * AI usage summary for the current period.
 * Nested inside StatusMessage.aiUsage.
 */
export interface AiUsageInfo {
  /** The time period this summary covers (e.g., 'today', 'week') */
  period: string;
  /** Per-provider usage breakdown */
  providers: AiProviderSummary[];
  /** Total cost across all providers for today, in USD */
  totalCostToday: number;
  /** Total cost across all providers for this calendar month, in USD */
  totalCostThisMonth: number;
}

// ============================================================================
// Section 3b: Pricing, Rate Limits, and Provider Cost Types
// ============================================================================
// Pricing tiers for model cost calculation, rate window snapshots for
// tracking API usage limits, and provider-level cost/budget snapshots.
// ============================================================================

/**
 * A pricing tier that activates above a token threshold.
 * Some models (e.g. Claude Sonnet 4.5) charge higher rates for inputs
 * exceeding a threshold (e.g. 200k tokens).
 */
export interface PricingTier {
  /** Input token count above which this tier's rates apply */
  thresholdTokens: number;
  /** Input cost per 1M tokens in this tier (USD) */
  inputCostPer1M: number;
  /** Output cost per 1M tokens in this tier (USD) */
  outputCostPer1M: number;
  /** Cache-read input cost per 1M tokens in this tier (USD) */
  cacheReadCostPer1M?: number;
  /** Cache-creation input cost per 1M tokens in this tier (USD) */
  cacheCreationCostPer1M?: number;
}

/**
 * Pricing entry for a single model.
 * Contains base rates and optional above-threshold tier for tiered pricing.
 */
export interface ModelPricing {
  /** Base input cost per 1M tokens (USD) */
  inputCostPer1M: number;
  /** Base output cost per 1M tokens (USD) */
  outputCostPer1M: number;
  /** Cache-read input cost per 1M tokens (USD) */
  cacheReadCostPer1M?: number;
  /** Cache-creation input cost per 1M tokens (USD) */
  cacheCreationCostPer1M?: number;
  /** Optional tiered pricing that applies above a token threshold */
  aboveThreshold?: PricingTier;
}

/**
 * Snapshot of a rate-limit window (e.g. 5-hour or weekly usage budget).
 * Mirrors CodexBar's RateWindow struct.
 */
export interface RateWindow {
  /** Percentage of the window budget already used (0-100) */
  usedPercent: number;
  /** Duration of the rate-limit window in minutes (e.g. 300 for 5 hours) */
  windowMinutes: number;
  /** ISO 8601 timestamp when the window resets */
  resetsAt?: string;
  /** Human-readable reset description (e.g. "Resets in 2h 30m") */
  resetDescription?: string;
}

/**
 * Provider-level spend/budget snapshot (e.g. Claude monthly spend vs limit).
 * Mirrors CodexBar's ProviderCostSnapshot struct.
 */
export interface ProviderCostSnapshot {
  /** Amount spent in the current period */
  used: number;
  /** Budget limit for the period (undefined if unlimited) */
  limit?: number;
  /** ISO 4217 currency code (e.g. "USD") */
  currencyCode: string;
  /** Human-readable period label (e.g. "Monthly") */
  period: string;
  /** ISO 8601 timestamp when the billing period resets */
  resetsAt?: string;
}

// ============================================================================
// Section 4: StatusMessage (Gateway -> Relay -> App)
// ============================================================================
// The primary data payload. Sent by the Gateway every ~2 seconds.
// The Relay forwards it to all connected Client apps unchanged.
// ============================================================================

/**
 * Full status message sent from Gateway through Relay to all connected Apps.
 * This is the main data payload of the entire system. The Gateway produces it
 * every ~2 seconds, and the Relay forwards it to all paired iPhone apps.
 */
export interface StatusMessage {
  type: 'status';
  /** Protocol version number for forward compatibility */
  version: number;
  /** ISO 8601 timestamp from the Gateway */
  timestamp: string;
  /** Mac hostname for display in the app */
  hostname: string;
  /** System resource metrics */
  system: SystemStats;
  /** OpenClaw application state */
  openclaw: OpenClawInfo;
  /** AI API usage summary */
  aiUsage: AiUsageInfo;
}

// ============================================================================
// Section 5: CommandMessage (App -> Relay -> Gateway)
// ============================================================================
// Commands sent from the iPhone app to the Gateway for remote control.
// ============================================================================

/** Supported command actions that the App can send to the Gateway. */
export type CommandAction =
  | 'restart'       // Restart the OpenClaw gateway process
  | 'get-usage'     // Request detailed AI usage data
  | 'get-logs'      // Request recent log entries
  | 'ping'          // Connectivity check
  | 'pair'          // Initiate pairing (internal use)
  | 'unpair';       // Remove pairing (internal use)

/**
 * Command message sent from the App to the Gateway via the Relay.
 * Each command has a unique ID so the Gateway can send back a response.
 */
export interface CommandMessage {
  type: 'command';
  /** Unique command identifier for correlating with CommandResponse */
  id: string;
  /** The action to perform on the Gateway */
  action: CommandAction;
  /** Optional command-specific parameters */
  params?: Record<string, unknown>;
}

/**
 * Response sent by the Gateway after executing a command.
 * Routed back through the Relay to the requesting App.
 */
export interface CommandResponse {
  type: 'command-response';
  /** The command ID this is responding to */
  commandId: string;
  /** Whether the command executed successfully */
  success: boolean;
  /** Result data (command-specific) */
  data?: unknown;
  /** Error message if success is false */
  error?: string;
}

// ============================================================================
// Section 6: Gateway <-> Relay Handshake Messages
// ============================================================================
// These messages handle the initial connection and pairing flow.
// ============================================================================

/**
 * Hello message sent by the Gateway when it first connects to the Relay.
 * Contains device identification and platform info so the Relay can
 * create/find the correct Durable Object instance.
 */
export interface GatewayHello {
  type: 'hello';
  /** Unique device identifier (persisted on the Mac) */
  deviceToken: string;
  /** Gateway software version string */
  gatewayVersion: string;
  /** Mac hostname for display */
  hostname: string;
  /** OS platform (e.g., 'darwin') */
  platform: string;
  /** CPU architecture (e.g., 'arm64') */
  arch: string;
}

/**
 * Pairing code message sent from Relay to Gateway after connection.
 * The Gateway displays this code so the user can enter it on the iPhone app.
 */
export interface RelayPairCode {
  type: 'pair_code';
  /** The pairing code in format "CLAW-XXXX" (4 uppercase alphanumeric chars) */
  code: string;
  /** ISO 8601 expiry timestamp (codes are valid for 5 minutes) */
  expiresAt: string;
}

/**
 * Acknowledgment sent from Relay to Gateway/Client for connection status.
 */
export interface RelayAck {
  type: 'ack';
  /** Connection state */
  status: 'connected' | 'paired' | 'error';
  /** Human-readable message */
  message?: string;
}

/**
 * Notification sent to clients when the gateway goes offline.
 * The Relay sends this when it detects the Gateway WebSocket has closed
 * or the heartbeat has timed out.
 */
export interface GatewayOfflineNotice {
  type: 'gateway_offline';
  /** ISO 8601 timestamp when the disconnection was detected */
  timestamp: string;
}

/**
 * Pairing confirmation sent by the Gateway to the Relay.
 * Used internally during the pairing flow.
 */
export interface PairConfirmMessage {
  type: 'pair-confirm';
  /** Device token for the Gateway */
  deviceToken: string;
  /** The pairing code that was confirmed */
  pairingCode: string;
}

// ============================================================================
// Section 7: Pairing REST API
// ============================================================================
// Types for the POST /pair REST endpoint on the Relay.
// ============================================================================

/**
 * POST /pair request body.
 * The App sends a pairing code (and gateway device token) to link to a Gateway.
 */
export interface PairRequest {
  /** The CLAW-XXXX code entered by the user */
  code: string;
  /** Gateway device token (obtained from QR code or manual entry) */
  gatewayId: string;
}

/**
 * POST /pair response body.
 * On success, returns a session token for the WebSocket connection.
 */
export interface PairResponse {
  /** Whether pairing succeeded */
  success: boolean;
  /** Gateway device token (for reconnection) */
  gatewayId?: string;
  /** Session token to authenticate future WebSocket connections */
  sessionToken?: string;
  /** Mac hostname for display in the app */
  hostname?: string;
  /** Error message if success is false */
  error?: string;
}

// ============================================================================
// Section 8: Alert Rules and Notifications
// ============================================================================
// User-configurable alert rules evaluated on the App side against incoming
// StatusMessage data. When a rule triggers, an AlertNotification is created.
// ============================================================================

/** Comparison operator for alert rule conditions. */
export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/** Severity level for alert notifications. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * A user-defined alert rule that triggers when a monitored metric
 * crosses a threshold. Rules are evaluated locally on the App against
 * each incoming StatusMessage.
 *
 * Example: Alert when CPU usage > 90% for more than 30 seconds.
 */
export interface AlertRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable rule name (e.g., "High CPU Usage") */
  name: string;
  /** Whether this rule is currently active */
  enabled: boolean;
  /** Dot-notation path to the metric in StatusMessage (e.g., "system.cpu.usage") */
  metric: string;
  /** Comparison operator */
  operator: AlertOperator;
  /** Threshold value to compare against */
  threshold: number;
  /** How long the condition must persist before triggering (in seconds) */
  durationSeconds: number;
  /** Alert severity level */
  severity: AlertSeverity;
  /** Optional cooldown period between repeated alerts (in seconds) */
  cooldownSeconds?: number;
}

/**
 * A triggered alert notification.
 * Created when an AlertRule condition is met. Displayed in the app's
 * notification center and optionally pushed as an iOS notification.
 */
export interface AlertNotification {
  /** Unique notification identifier */
  id: string;
  /** The rule that triggered this notification */
  ruleId: string;
  /** Rule name (copied for display without needing to look up the rule) */
  ruleName: string;
  /** Severity level */
  severity: AlertSeverity;
  /** The actual metric value that triggered the alert */
  currentValue: number;
  /** The threshold that was exceeded */
  threshold: number;
  /** ISO 8601 timestamp when the alert was triggered */
  triggeredAt: string;
  /** Whether the user has acknowledged/dismissed this notification */
  acknowledged: boolean;
}

// ============================================================================
// Section 9: Monitor Configuration
// ============================================================================
// Top-level configuration for the Gateway monitor service.
// ============================================================================

/** Configuration for the relay WebSocket connection. */
export interface RelayConfig {
  /** Whether relay connection is enabled */
  enabled: boolean;
  /** Relay WebSocket server URL (e.g., "wss://relay.clawface.app/gateway") */
  server: string;
  /** Whether to connect to the relay automatically on start */
  autoConnect: boolean;
  /** Interval in milliseconds between status updates (default: 2000) */
  statusInterval: number;
}

/** Configuration for AI usage tracking. */
export interface AiUsageConfig {
  /** Whether AI usage tracking is enabled */
  enabled: boolean;
  /** Number of days to retain detailed usage data (default: 30) */
  retentionDays: number;
}

/**
 * Top-level monitor configuration used by the Gateway service.
 * Loaded from a config file on the Mac.
 */
export interface MonitorConfig {
  /** Relay connection settings */
  relay: RelayConfig;
  /** AI usage tracking settings */
  aiUsage: AiUsageConfig;
}

// ============================================================================
// Section 10: Message Union Types
// ============================================================================
// Convenient union types for message routing and parsing.
// ============================================================================

/** All messages the Gateway can send to the Relay. */
export type GatewayOutboundMessage =
  | GatewayHello
  | StatusMessage
  | CommandResponse
  | PairConfirmMessage;

/** All messages the Gateway can receive from the Relay. */
export type GatewayInboundMessage =
  | CommandMessage
  | RelayPairCode;

/** All messages the App can receive from the Relay. */
export type AppInboundMessage =
  | StatusMessage
  | CommandResponse
  | RelayAck
  | GatewayOfflineNotice;

/** All messages the App can send to the Relay. */
export type AppOutboundMessage = CommandMessage;

/**
 * Mood types for the app's face animation system.
 * Each mood corresponds to a different facial expression and color scheme.
 * Derived from the current StatusMessage values by the mood engine.
 */
export type Mood =
  | 'happy'
  | 'busy'
  | 'sleepy'
  | 'stressed'
  | 'alert'
  | 'worried'
  | 'spending'
  | 'disconnected';

// ============================================================================
// Section 11: Protocol Constants
// ============================================================================
// Shared constants used across components.
// ============================================================================

/** Current protocol version. Increment when making breaking changes. */
export const PROTOCOL_VERSION = 1;

/** Default interval (ms) between Gateway status messages. */
export const DEFAULT_STATUS_INTERVAL = 2000;

/** How long a pairing code remains valid (ms). */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

/** Regex pattern for validating pairing code format. */
export const PAIR_CODE_PATTERN = /^CLAW-[A-Z2-9]{4}$/;
