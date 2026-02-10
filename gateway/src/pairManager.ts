// ============================================================================
// OpenClaw Monitor - Pair Manager
// Generates and manages time-limited pairing codes used to link a mobile
// device to this gateway. Codes follow the format CLAW-XXXX where X is an
// alphanumeric character (excluding easily confused ones like 0/O, 1/I/l).
// Codes rotate automatically every 5 minutes.
// ============================================================================

import crypto from 'crypto';

/** Duration in milliseconds before a pairing code expires (5 minutes) */
const CODE_TTL_MS = 5 * 60 * 1000;

/**
 * Alphabet for generating pairing codes.
 * Excludes ambiguous characters (0, O, 1, I, l) to reduce user entry errors.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export class PairManager {
  /** The currently active pairing code, or null if none generated yet */
  private currentCode: string | null = null;

  /** Unix timestamp (ms) when the current code expires */
  private codeExpiry: number = 0;

  /** Timer handle for the automatic rotation interval */
  private rotationTimer: NodeJS.Timeout | null = null;

  /** Optional callback invoked whenever a new code is generated */
  private onNewCode: ((code: string) => void) | null = null;

  /** Optional listener for code changes (used by Electron desktop app). */
  private codeChangeListener: ((code: string, expiresAt: number) => void) | null = null;

  /**
   * @param onNewCode - Optional callback called each time a new code is generated.
   *                    Useful for sending the code to the relay server.
   */
  constructor(onNewCode?: (code: string) => void) {
    this.onNewCode = onNewCode ?? null;
  }

  /** Register a listener for code changes (notifies the Electron UI). */
  setCodeChangeListener(listener: (code: string, expiresAt: number) => void): void {
    this.codeChangeListener = listener;
  }

  // --------------------------------------------------------------------------
  // Code generation
  // --------------------------------------------------------------------------

  /**
   * Generate a new random pairing code in the format CLAW-XXXX.
   * The code is cryptographically random to prevent guessing.
   *
   * @returns The new pairing code string
   */
  generateCode(): string {
    const suffix = this.randomString(4);
    const code = `CLAW-${suffix}`;

    this.currentCode = code;
    this.codeExpiry = Date.now() + CODE_TTL_MS;

    if (this.onNewCode) {
      this.onNewCode(code);
    }

    return code;
  }

  /**
   * Generate a cryptographically random string of the given length
   * using the safe alphabet.
   */
  private randomString(length: number): string {
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return result;
  }

  /**
   * Set a pairing code received from the relay server.
   * When connected to a relay, the relay is the authority on pairing codes
   * (it stores the code→deviceToken mapping for the /pair endpoint).
   * This replaces any locally generated code and displays it.
   */
  setRelayCode(code: string): void {
    this.currentCode = code;
    this.codeExpiry = Date.now() + CODE_TTL_MS;
    this.displayCode(code);
  }

  // --------------------------------------------------------------------------
  // Display
  // --------------------------------------------------------------------------

  /** The relay server URL embedded in QR codes so the app knows where to connect */
  private relayUrl: string = 'wss://relay.clawface.app/gateway';

  /**
   * Set the relay server URL that will be encoded into QR codes.
   * Call this before startRotation() if using a custom relay URL.
   */
  setRelayUrl(url: string): void {
    this.relayUrl = url;
  }

  /**
   * Print the pairing code and a scannable QR code to the terminal.
   * The QR code encodes a JSON payload with the pairing code and relay URL,
   * so the iPhone app can auto-pair by scanning it.
   */
  async displayCode(code: string): Promise<void> {
    // Notify desktop app listener if registered
    this.codeChangeListener?.(code, this.codeExpiry);

    // Only print to terminal if running in a TTY (skip in Electron)
    if (!process.stdout.isTTY) return;

    const remainingMs = this.codeExpiry - Date.now();
    const remainingMin = Math.max(0, Math.ceil(remainingMs / 60000));

    const lines = [
      '',
      '  +--------------------------------+',
      '  |  Pair with ClawFace            |',
      '  |                                |',
      `  |      ${code.padEnd(26)}|`,
      '  |                                |',
      '  |  Scan QR or enter code in app  |',
      `  |  Expires in ${String(remainingMin).padStart(1)} minute${remainingMin === 1 ? ' ' : 's'}${' '.repeat(14 - String(remainingMin).length)}|`,
      '  +--------------------------------+',
      '',
    ];

    console.log(lines.join('\n'));

    // Generate a QR code containing the pairing info as JSON.
    // The app parses this to auto-fill the code and relay URL.
    // Lazy-import qrcode-terminal so it doesn't crash in Electron where
    // the package is excluded from the bundle (it's terminal-only).
    try {
      const qrcode = await import('qrcode-terminal');
      const qrPayload = JSON.stringify({ code, relay: this.relayUrl });
      qrcode.default.generate(qrPayload, { small: true }, (qr: string) => {
        console.log(qr);
      });
    } catch {
      // qrcode-terminal not available (e.g. Electron build) — skip
    }
  }

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  /**
   * Check whether the current pairing code is still valid (not expired).
   * Returns false if no code has been generated yet or if the TTL has elapsed.
   */
  isCodeValid(): boolean {
    if (!this.currentCode) return false;
    return Date.now() < this.codeExpiry;
  }

  /**
   * Get the current active pairing code, or null if expired/not generated.
   */
  getCurrentCode(): string | null {
    if (!this.isCodeValid()) return null;
    return this.currentCode;
  }

  // --------------------------------------------------------------------------
  // Rotation
  // --------------------------------------------------------------------------

  /**
   * Start automatic code rotation. A new code is generated immediately,
   * then every CODE_TTL_MS (5 minutes) thereafter. Each new code is
   * displayed in the terminal.
   */
  startRotation(): void {
    this.stopRotation();

    // Generate and display the first code immediately
    const code = this.generateCode();
    this.displayCode(code);

    // Set up the rotation interval
    this.rotationTimer = setInterval(() => {
      const newCode = this.generateCode();
      this.displayCode(newCode);
    }, CODE_TTL_MS);
  }

  /**
   * Stop the automatic code rotation timer.
   */
  stopRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }
}
