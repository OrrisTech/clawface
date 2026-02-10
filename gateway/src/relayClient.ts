// ============================================================================
// OpenClaw Monitor - Relay WebSocket Client
// Maintains a persistent WebSocket connection to the OpenClaw Relay server.
// Sends periodic status updates and receives commands from paired mobile apps.
// Features automatic reconnection with exponential backoff and heartbeat
// ping/pong to detect stale connections.
// ============================================================================

import WebSocket from 'ws';
import os from 'os';
import type {
  HelloMessage,
  DisconnectMessage,
  StatusMessage,
  CommandMessage,
  CommandResponse,
  GatewayOutboundMessage,
} from './types.js';

/** Callback invoked when a command is received from the relay */
type CommandHandler = (cmd: CommandMessage) => void;

/** Callback invoked when the relay sends a pairing code for this gateway to display */
type PairCodeHandler = (code: string) => void;

/** Internal connection states for logging clarity */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // 30 seconds cap
  private baseReconnectDelay: number = 1000; // Start at 1 second
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeoutMs: number = 10000; // Expect pong within 10s
  private pongReceived: boolean = true;
  private state: ConnectionState = 'disconnected';
  private shouldReconnect: boolean = true;

  constructor(
    private relayUrl: string,
    private deviceToken: string,
    private gatewayVersion: string,
    private onCommand: CommandHandler,
    private onPairCode?: PairCodeHandler,
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Establish a WebSocket connection to the relay server.
   * Sends a hello message upon connection and starts the heartbeat loop.
   * If the connection drops, it will automatically reconnect with backoff.
   */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      return; // Already connected or in progress
    }

    this.shouldReconnect = true;
    this.state = 'connecting';

    // Append the deviceToken as a query parameter so the relay can
    // identify this gateway and route to the correct Durable Object.
    const wsUrl = new URL(this.relayUrl);
    wsUrl.searchParams.set('deviceToken', this.deviceToken);
    console.log(`[RelayClient] Connecting to ${wsUrl.toString()}...`);

    this.ws = new WebSocket(wsUrl.toString());

    this.ws.on('open', () => {
      this.state = 'connected';
      this.reconnectAttempts = 0;
      console.log('[RelayClient] Connected to relay server');

      // Send hello message to identify this gateway
      const hello: HelloMessage = {
        type: 'hello',
        deviceToken: this.deviceToken,
        gatewayVersion: this.gatewayVersion,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
      };
      this.send(hello);

      // Start heartbeat pings to detect stale connections
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('pong', () => {
      // Relay responded to our ping; connection is alive
      this.pongReceived = true;
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[RelayClient] Connection closed (code=${code}, reason=${reason.toString()})`);
      this.cleanup();
      if (this.shouldReconnect) {
        this.reconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error(`[RelayClient] WebSocket error: ${err.message}`);
      // The 'close' event will fire after this, triggering reconnection
    });
  }

  /**
   * Send a status update to the relay. Silently drops the message if not
   * connected (status updates are best-effort; the next one will succeed).
   */
  sendStatus(status: StatusMessage): void {
    if (this.state !== 'connected') return;
    this.send(status);
  }

  /**
   * Send a command response back to the relay.
   */
  sendCommandResponse(response: CommandResponse): void {
    if (this.state !== 'connected') return;
    this.send(response);
  }

  /**
   * Send a disconnect notification to the relay so paired iOS apps
   * know to re-pair next time. Call this before disconnect().
   */
  sendDisconnect(deviceToken: string, reason: 'quit' | 'unpair' = 'quit'): void {
    if (this.state !== 'connected') return;
    const msg: DisconnectMessage = { type: 'disconnect', deviceToken, reason };
    this.send(msg);
  }

  /**
   * Disconnect gracefully. Stops heartbeat, disables auto-reconnect, and
   * closes the WebSocket.
   */
  disconnect(): void {
    console.log('[RelayClient] Disconnecting...');
    this.shouldReconnect = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'Gateway shutting down');
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  /** Whether the client currently has an active connection to the relay */
  get isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Send a JSON message over the WebSocket. Catches and logs send errors
   * (e.g. if the connection drops between the readyState check and send).
   */
  private send(message: GatewayOutboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      console.error('[RelayClient] Failed to send message:', err);
    }
  }

  /**
   * Parse and route incoming messages from the relay.
   * Currently only 'command' messages are expected from the server.
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'command' && message.action && message.id) {
        this.onCommand(message as CommandMessage);
      } else if (message.type === 'pair_code' && message.code) {
        // The relay generated a pairing code for this gateway to display
        console.log(`[RelayClient] Received pairing code from relay: ${message.code}`);
        if (this.onPairCode) {
          this.onPairCode(message.code);
        }
      } else {
        console.log('[RelayClient] Received unknown message type:', message.type);
      }
    } catch (err) {
      console.error('[RelayClient] Failed to parse incoming message:', err);
    }
  }

  /**
   * Start a heartbeat loop that sends WebSocket pings at regular intervals.
   * If the relay doesn't respond with a pong in time, the connection is
   * assumed dead and we force-close it to trigger reconnection.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true;

    this.heartbeatInterval = setInterval(() => {
      if (!this.pongReceived) {
        // No pong since the last ping; connection is stale
        console.warn('[RelayClient] Heartbeat timeout, forcing reconnect');
        this.ws?.terminate();
        return;
      }

      this.pongReceived = false;
      try {
        this.ws?.ping();
      } catch {
        // If ping fails, the close handler will trigger reconnect
      }
    }, this.heartbeatTimeoutMs);
  }

  /** Stop the heartbeat timer */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Reconnect to the relay with exponential backoff.
   * Delay doubles each attempt, capped at maxReconnectDelay (30s).
   * A small random jitter is added to avoid thundering herd if multiple
   * gateways reconnect simultaneously.
   */
  private reconnect(): void {
    this.state = 'reconnecting';
    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );
    // Add jitter: +/- 20%
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    const actualDelay = Math.round(delay + jitter);

    console.log(
      `[RelayClient] Reconnecting in ${actualDelay}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, actualDelay);
  }

  /** Clean up heartbeat timer when connection is lost or closed */
  private cleanup(): void {
    this.stopHeartbeat();
  }
}
