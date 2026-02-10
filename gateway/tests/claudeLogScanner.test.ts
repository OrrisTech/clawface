// ============================================================================
// Tests for ClaudeLogScanner
// ============================================================================
// Verifies JSONL parsing, deduplication of streaming chunks, incremental
// scanning (only new bytes are re-parsed), and cache invalidation when
// files change. Uses temporary directories with sample JSONL data.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeLogScanner } from '../src/claudeLogScanner.js';

/** Create a unique temp directory for each test */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-test-'));
}

/** Remove a directory recursively */
function cleanDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a Claude assistant JSONL line.
 * Mimics the format Claude Code writes to conversation logs.
 */
function makeAssistantLine(opts: {
  messageId?: string;
  requestId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  timestamp?: string;
}): string {
  const entry = {
    type: 'assistant',
    timestamp: opts.timestamp ?? '2026-02-07T10:00:00.000Z',
    requestId: opts.requestId ?? 'req_001',
    message: {
      id: opts.messageId ?? 'msg_001',
      model: opts.model ?? 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: opts.cacheCreationInputTokens ?? 0,
      },
    },
  };
  return JSON.stringify(entry);
}

describe('ClaudeLogScanner', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    // Create a projects directory structure matching Claude's layout
    projectDir = path.join(tempDir, 'projects', 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    cleanDir(tempDir);
  });

  // --------------------------------------------------------------------------
  // Basic parsing
  // --------------------------------------------------------------------------

  describe('basic parsing', () => {
    it('should parse a single assistant message with usage', () => {
      const line = makeAssistantLine({
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 500,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      });

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      // Override CLAUDE_CONFIG_DIR to point to our temp directory
      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].model).toBe('claude-sonnet-4-5');
        expect(entries[0].inputTokens).toBe(500);
        expect(entries[0].outputTokens).toBe(200);
        expect(entries[0].cacheReadInputTokens).toBe(100);
        expect(entries[0].cacheCreationInputTokens).toBe(50);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should parse multiple messages from the same file', () => {
      const lines = [
        makeAssistantLine({
          messageId: 'msg_001',
          requestId: 'req_001',
          inputTokens: 100,
          outputTokens: 50,
        }),
        makeAssistantLine({
          messageId: 'msg_002',
          requestId: 'req_002',
          inputTokens: 200,
          outputTokens: 100,
        }),
        makeAssistantLine({
          messageId: 'msg_003',
          requestId: 'req_003',
          inputTokens: 300,
          outputTokens: 150,
        }),
      ];

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();

        expect(entries).toHaveLength(3);
        expect(entries.reduce((sum, e) => sum + e.inputTokens, 0)).toBe(600);
        expect(entries.reduce((sum, e) => sum + e.outputTokens, 0)).toBe(300);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should skip non-assistant lines', () => {
      const lines = [
        JSON.stringify({ type: 'user', timestamp: '2026-02-07T10:00:00Z', message: { content: 'hello' } }),
        makeAssistantLine({ messageId: 'msg_001', requestId: 'req_001' }),
        JSON.stringify({ type: 'system', timestamp: '2026-02-07T10:00:00Z' }),
      ];

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should skip lines with zero tokens', () => {
      const line = makeAssistantLine({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(0);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should normalize model names (strip date suffixes)', () => {
      const line = makeAssistantLine({
        model: 'claude-sonnet-4-5-20250929',
      });

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        // Date suffix should be stripped for known models
        expect(entries[0].model).toBe('claude-sonnet-4-5');
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  describe('deduplication', () => {
    it('should deduplicate streaming chunks with the same message.id + requestId', () => {
      // Claude emits multiple lines per message during streaming, each with
      // cumulative usage. We should only count the first (which has final totals).
      const lines = [
        makeAssistantLine({
          messageId: 'msg_stream_1',
          requestId: 'req_stream_1',
          inputTokens: 100,
          outputTokens: 10,
        }),
        // Same message+request, higher output (streaming chunk)
        makeAssistantLine({
          messageId: 'msg_stream_1',
          requestId: 'req_stream_1',
          inputTokens: 100,
          outputTokens: 50,
        }),
        // Same message+request, final chunk
        makeAssistantLine({
          messageId: 'msg_stream_1',
          requestId: 'req_stream_1',
          inputTokens: 100,
          outputTokens: 100,
        }),
      ];

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();

        // Should only have 1 entry (deduplicated)
        expect(entries).toHaveLength(1);
        // Should use the first occurrence's values
        expect(entries[0].outputTokens).toBe(10);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should not deduplicate entries with different message IDs', () => {
      const lines = [
        makeAssistantLine({ messageId: 'msg_001', requestId: 'req_001' }),
        makeAssistantLine({ messageId: 'msg_002', requestId: 'req_002' }),
      ];

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(2);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Incremental scanning
  // --------------------------------------------------------------------------

  describe('incremental scanning', () => {
    it('should return cached results for unchanged files', () => {
      const line = makeAssistantLine({ messageId: 'msg_001', requestId: 'req_001' });
      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();

        // First scan
        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(1);

        // Second scan (no changes) - should return same cached results
        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
        expect(entries2[0].inputTokens).toBe(entries1[0].inputTokens);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should incrementally scan new content appended to a file', () => {
      const filePath = path.join(projectDir, 'conversation.jsonl');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();

        // Write initial content
        const line1 = makeAssistantLine({
          messageId: 'msg_001',
          requestId: 'req_001',
          inputTokens: 100,
          outputTokens: 50,
        });
        fs.writeFileSync(filePath, line1 + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(1);

        // Append new content (simulate new conversation turn)
        const line2 = makeAssistantLine({
          messageId: 'msg_002',
          requestId: 'req_002',
          inputTokens: 200,
          outputTokens: 100,
          timestamp: '2026-02-07T11:00:00.000Z',
        });
        fs.appendFileSync(filePath, line2 + '\n');

        // Second scan should pick up the new entry
        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(2);
        expect(entries2[1].inputTokens).toBe(200);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Cache invalidation
  // --------------------------------------------------------------------------

  describe('cache invalidation', () => {
    it('should do a full rescan when a file is deleted and re-created', () => {
      const filePath = path.join(projectDir, 'conversation.jsonl');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();

        // Initial scan with 2 entries
        const lines = [
          makeAssistantLine({ messageId: 'msg_001', requestId: 'req_001', inputTokens: 100 }),
          makeAssistantLine({ messageId: 'msg_002', requestId: 'req_002', inputTokens: 200 }),
        ];
        fs.writeFileSync(filePath, lines.join('\n') + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(2);

        // Delete and re-create with different content (smaller file)
        fs.writeFileSync(filePath, makeAssistantLine({
          messageId: 'msg_003',
          requestId: 'req_003',
          inputTokens: 999,
        }) + '\n');

        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
        expect(entries2[0].inputTokens).toBe(999);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should remove entries for deleted files', () => {
      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();

        // Create two files
        const file1 = path.join(projectDir, 'conv1.jsonl');
        const file2 = path.join(projectDir, 'conv2.jsonl');

        fs.writeFileSync(file1, makeAssistantLine({
          messageId: 'msg_a1', requestId: 'req_a1',
        }) + '\n');
        fs.writeFileSync(file2, makeAssistantLine({
          messageId: 'msg_b1', requestId: 'req_b1',
        }) + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(2);

        // Delete one file
        fs.unlinkSync(file2);

        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should clear all cached state when clearCache() is called', () => {
      const filePath = path.join(projectDir, 'conversation.jsonl');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();

        fs.writeFileSync(filePath, makeAssistantLine({
          messageId: 'msg_001',
          requestId: 'req_001',
        }) + '\n');

        const entries1 = scanner.scan();
        expect(entries1).toHaveLength(1);

        scanner.clearCache();

        // After clearing, scan should re-parse the file
        const entries2 = scanner.scan();
        expect(entries2).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Day key extraction
  // --------------------------------------------------------------------------

  describe('day key extraction', () => {
    it('should extract day key from ISO timestamp', () => {
      const line = makeAssistantLine({
        timestamp: '2026-02-07T14:30:00.000Z',
      });

      const filePath = path.join(projectDir, 'conversation.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(1);
        // Day key should be present and in YYYY-MM-DD format
        expect(entries[0].dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Empty / missing directories
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return empty array when no log directories exist', () => {
      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'nonexistent');

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        expect(entries).toHaveLength(0);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });

    it('should handle malformed JSON lines gracefully', () => {
      const filePath = path.join(projectDir, 'conversation.jsonl');
      const lines = [
        '{"broken json',
        makeAssistantLine({ messageId: 'msg_001', requestId: 'req_001' }),
        'not json at all',
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const origEnv = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;

      try {
        const scanner = new ClaudeLogScanner();
        const entries = scanner.scan();
        // Should parse the valid line and skip the broken ones
        expect(entries).toHaveLength(1);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_CONFIG_DIR = origEnv;
        } else {
          delete process.env.CLAUDE_CONFIG_DIR;
        }
      }
    });
  });
});
