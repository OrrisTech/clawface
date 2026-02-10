// ============================================================================
// Tests for CodexLogScanner
// ============================================================================
// Verifies JSONL parsing of Codex session logs, delta computation from
// cumulative token totals, incremental scanning, and cache invalidation.
// Uses temporary directories with sample JSONL data.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodexLogScanner } from '../src/codexLogScanner.js';

/** Create a unique temp directory for each test */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-test-'));
}

/** Remove a directory recursively */
function cleanDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a Codex turn_context JSONL line.
 * Tells the scanner which model is being used for subsequent events.
 */
function makeTurnContext(model: string, timestamp: string = '2026-02-07T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'turn_context',
    timestamp,
    payload: { model },
  });
}

/**
 * Build a Codex event_msg JSONL line with cumulative token_count data.
 * Mimics the format Codex writes to session logs.
 */
function makeTokenCountEvent(opts: {
  timestamp?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  model?: string;
}): string {
  const entry: Record<string, unknown> = {
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-02-07T10:01:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: opts.inputTokens ?? 100,
          cached_input_tokens: opts.cachedInputTokens ?? 0,
          output_tokens: opts.outputTokens ?? 50,
        },
      },
    },
  };

  // Add model to info if specified
  if (opts.model) {
    const payload = entry.payload as Record<string, unknown>;
    const info = payload.info as Record<string, unknown>;
    info.model = opts.model;
  }

  return JSON.stringify(entry);
}

/**
 * Build a Codex event_msg JSONL line with per-turn (non-cumulative) token data.
 * Uses last_token_usage instead of total_token_usage.
 */
function makeLastTokenEvent(opts: {
  timestamp?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-02-07T10:01:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: opts.inputTokens ?? 100,
          cached_input_tokens: opts.cachedInputTokens ?? 0,
          output_tokens: opts.outputTokens ?? 50,
        },
      },
    },
  });
}

describe('CodexLogScanner', () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    // Create a sessions directory structure matching Codex's layout
    sessionsDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    cleanDir(tempDir);
  });

  // --------------------------------------------------------------------------
  // Basic parsing
  // --------------------------------------------------------------------------

  describe('basic parsing', () => {
    it('should parse a single token_count event', () => {
      const lines = [
        makeTurnContext('gpt-5'),
        makeTokenCountEvent({ inputTokens: 500, cachedInputTokens: 100, outputTokens: 200 }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].model).toBe('gpt-5');
        expect(entries[0].inputTokens).toBe(500);
        expect(entries[0].cachedInputTokens).toBe(100);
        expect(entries[0].outputTokens).toBe(200);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should compute deltas from cumulative totals', () => {
      // Codex reports cumulative totals that grow with each event.
      // The scanner must compute per-event deltas.
      const lines = [
        makeTurnContext('gpt-5'),
        // First event: cumulative totals = 100/0/50
        makeTokenCountEvent({
          timestamp: '2026-02-07T10:01:00.000Z',
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 50,
        }),
        // Second event: cumulative totals = 300/50/150
        makeTokenCountEvent({
          timestamp: '2026-02-07T10:02:00.000Z',
          inputTokens: 300,
          cachedInputTokens: 50,
          outputTokens: 150,
        }),
        // Third event: cumulative totals = 500/100/250
        makeTokenCountEvent({
          timestamp: '2026-02-07T10:03:00.000Z',
          inputTokens: 500,
          cachedInputTokens: 100,
          outputTokens: 250,
        }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();

        expect(entries).toHaveLength(3);

        // First event delta: 100/0/50 (from zero)
        expect(entries[0].inputTokens).toBe(100);
        expect(entries[0].cachedInputTokens).toBe(0);
        expect(entries[0].outputTokens).toBe(50);

        // Second event delta: 200/50/100
        expect(entries[1].inputTokens).toBe(200);
        expect(entries[1].cachedInputTokens).toBe(50);
        expect(entries[1].outputTokens).toBe(100);

        // Third event delta: 200/50/100
        expect(entries[2].inputTokens).toBe(200);
        expect(entries[2].cachedInputTokens).toBe(50);
        expect(entries[2].outputTokens).toBe(100);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should handle per-turn (last_token_usage) events', () => {
      const lines = [
        makeTurnContext('gpt-5'),
        makeLastTokenEvent({
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 50,
        }),
        makeLastTokenEvent({
          timestamp: '2026-02-07T10:02:00.000Z',
          inputTokens: 200,
          cachedInputTokens: 40,
          outputTokens: 100,
        }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();

        // Per-turn events are used as-is (not cumulative)
        expect(entries).toHaveLength(2);
        expect(entries[0].inputTokens).toBe(100);
        expect(entries[1].inputTokens).toBe(200);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should default model to gpt-5 when no turn_context is present', () => {
      const lines = [
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].model).toBe('gpt-5');
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should normalize model names (strip openai/ prefix)', () => {
      const lines = [
        makeTurnContext('openai/gpt-5'),
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();
        expect(entries[0].model).toBe('gpt-5');
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should clamp cached tokens to not exceed input tokens', () => {
      const lines = [
        makeTurnContext('gpt-5'),
        makeTokenCountEvent({
          inputTokens: 100,
          cachedInputTokens: 200, // More than input tokens
          outputTokens: 50,
        }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();

        // Cached should be clamped to input tokens
        expect(entries[0].cachedInputTokens).toBe(100);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should skip non-token-count event_msg lines', () => {
      const lines = [
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-02-07T10:00:00.000Z',
          payload: { type: 'some_other_event', data: {} },
        }),
        makeTurnContext('gpt-5'),
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Incremental scanning
  // --------------------------------------------------------------------------

  describe('incremental scanning', () => {
    it('should return cached results for unchanged files', () => {
      const lines = [
        makeTurnContext('gpt-5'),
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ];

      const filePath = path.join(sessionsDir, 'session.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(1);

        // Second scan with no changes
        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
        expect(entries2[0].inputTokens).toBe(entries1[0].inputTokens);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should incrementally scan appended content with correct delta computation', () => {
      const filePath = path.join(sessionsDir, 'session.jsonl');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();

        // Write initial content: turn context + first cumulative total
        const initial = [
          makeTurnContext('gpt-5'),
          makeTokenCountEvent({
            timestamp: '2026-02-07T10:01:00.000Z',
            inputTokens: 100,
            outputTokens: 50,
          }),
        ];
        fs.writeFileSync(filePath, initial.join('\n') + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(1);
        expect(entries1[0].inputTokens).toBe(100);

        // Append a second event with higher cumulative totals
        const newEvent = makeTokenCountEvent({
          timestamp: '2026-02-07T10:02:00.000Z',
          inputTokens: 300,
          outputTokens: 150,
        });
        fs.appendFileSync(filePath, newEvent + '\n');

        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(2);
        // Delta from cumulative: 300 - 100 = 200 input, 150 - 50 = 100 output
        expect(entries2[1].inputTokens).toBe(200);
        expect(entries2[1].outputTokens).toBe(100);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Cache invalidation
  // --------------------------------------------------------------------------

  describe('cache invalidation', () => {
    it('should do a full rescan when a file is replaced', () => {
      const filePath = path.join(sessionsDir, 'session.jsonl');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();

        // Initial scan
        const initial = [
          makeTurnContext('gpt-5'),
          makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
          makeTokenCountEvent({
            timestamp: '2026-02-07T10:02:00.000Z',
            inputTokens: 300,
            outputTokens: 150,
          }),
        ];
        fs.writeFileSync(filePath, initial.join('\n') + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(2);

        // Replace file with different content (smaller)
        const replacement = [
          makeTurnContext('gpt-5.1'),
          makeTokenCountEvent({ inputTokens: 999, outputTokens: 888 }),
        ];
        fs.writeFileSync(filePath, replacement.join('\n') + '\n');

        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
        expect(entries2[0].inputTokens).toBe(999);
        expect(entries2[0].model).toBe('gpt-5.1');
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should remove entries for deleted files', () => {
      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();

        const file1 = path.join(sessionsDir, 'session1.jsonl');
        const file2 = path.join(sessionsDir, 'session2.jsonl');

        fs.writeFileSync(file1, [
          makeTurnContext('gpt-5'),
          makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
        ].join('\n') + '\n');

        fs.writeFileSync(file2, [
          makeTurnContext('gpt-5'),
          makeTokenCountEvent({ inputTokens: 200, outputTokens: 100 }),
        ].join('\n') + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(2);

        // Delete one file
        fs.unlinkSync(file2);

        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
        expect(entries2[0].inputTokens).toBe(100);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should clear all cached state when clearCache() is called', () => {
      const filePath = path.join(sessionsDir, 'session.jsonl');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();

        fs.writeFileSync(filePath, [
          makeTurnContext('gpt-5'),
          makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
        ].join('\n') + '\n');

        scanner.scan();
        scanner.clearCache();

        // After clearing, scan should re-parse from scratch
        const entries = scanner.scan();
        expect(entries).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return empty array when no log directories exist', () => {
      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = path.join(tempDir, 'nonexistent');

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(0);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should handle malformed JSON lines gracefully', () => {
      const filePath = path.join(sessionsDir, 'session.jsonl');
      const lines = [
        '{"broken',
        makeTurnContext('gpt-5'),
        'not json',
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();
        // Should parse the valid token event and skip broken lines
        expect(entries).toHaveLength(1);
        expect(entries[0].inputTokens).toBe(100);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });

    it('should handle nested session directories (date partitioned)', () => {
      // Codex may use date-partitioned directories: sessions/2026/02/07/
      const dateDir = path.join(sessionsDir, '2026', '02', '07');
      fs.mkdirSync(dateDir, { recursive: true });

      const filePath = path.join(dateDir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        makeTurnContext('gpt-5'),
        makeTokenCountEvent({ inputTokens: 100, outputTokens: 50 }),
      ].join('\n') + '\n');

      const origEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = tempDir;

      try {
        const scanner = new CodexLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CODEX_HOME = origEnv;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });
});
