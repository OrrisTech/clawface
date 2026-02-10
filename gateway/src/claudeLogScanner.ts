// ============================================================================
// OpenClaw Monitor - Claude JSONL Log Scanner
// ============================================================================
// Scans Claude Code's local JSONL conversation logs to extract token usage
// data. Supports incremental scanning (only reads new bytes in files that
// have grown since last scan) and deduplication of streaming chunks.
//
// Ported from CodexBar's CostUsageScanner+Claude.swift.
//
// Log locations:
//   ~/.config/claude/projects/**/*.jsonl
//   ~/.claude/projects/**/*.jsonl
//   Or directories specified by CLAUDE_CONFIG_DIR env var
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeClaudeModel } from './modelNormalizer.js';

// ============================================================================
// Types
// ============================================================================

/** A single usage entry extracted from a Claude JSONL log line. */
export interface ClaudeUsageEntry {
  /** ISO date string (YYYY-MM-DD) in local timezone */
  dayKey: string;
  /** The model that produced this response */
  model: string;
  /** Number of regular input tokens */
  inputTokens: number;
  /** Number of output tokens */
  outputTokens: number;
  /** Number of cache-read input tokens */
  cacheReadInputTokens: number;
  /** Number of cache-creation input tokens */
  cacheCreationInputTokens: number;
  /** ISO 8601 timestamp from the log line */
  timestamp: string;
  /** Pre-calculated cost in USD from Claude Code (if available) */
  costUSD?: number;
}

/**
 * Per-file scan state for incremental scanning.
 * Stored so that on subsequent scans, unchanged files can be skipped entirely
 * and grown files can be scanned from where we left off.
 */
interface FileScanState {
  /** Absolute file path */
  filePath: string;
  /** File size in bytes at last scan */
  lastSize: number;
  /** File modification time (ms since epoch) at last scan */
  lastMtimeMs: number;
  /** Byte offset where we stopped reading */
  lastOffset: number;
  /** Usage entries extracted from this file */
  entries: ClaudeUsageEntry[];
}

// ============================================================================
// ClaudeLogScanner
// ============================================================================

/**
 * Scans Claude Code JSONL log files for usage data.
 *
 * Each scan pass:
 * 1. Discovers all .jsonl files under the Claude projects directories.
 * 2. Skips files whose size and mtime haven't changed since last scan.
 * 3. For files that grew, reads only the new bytes from lastOffset.
 * 4. Deduplicates streaming chunks by message.id + requestId (keeps last).
 * 5. Returns all usage entries found.
 */
export class ClaudeLogScanner {
  // Cache of per-file scan state keyed by absolute file path
  private fileStates = new Map<string, FileScanState>();

  /**
   * Scan all Claude JSONL log files and return usage entries.
   * Uses incremental scanning to avoid re-parsing unchanged files.
   *
   * @returns Array of usage entries across all scanned files
   */
  scan(): ClaudeUsageEntry[] {
    const roots = this.getProjectRoots();
    const allEntries: ClaudeUsageEntry[] = [];
    const touchedPaths = new Set<string>();

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

      // Recursively find all .jsonl files under this root
      const jsonlFiles = this.findJsonlFiles(root);

      for (const filePath of jsonlFiles) {
        touchedPaths.add(filePath);
        const entries = this.scanFile(filePath);
        allEntries.push(...entries);
      }
    }

    // Remove cached states for files that no longer exist
    for (const cachedPath of this.fileStates.keys()) {
      if (!touchedPaths.has(cachedPath)) {
        this.fileStates.delete(cachedPath);
      }
    }

    return allEntries;
  }

  /**
   * Clear the internal scan cache, forcing a full rescan on next call.
   */
  clearCache(): void {
    this.fileStates.clear();
  }

  // --------------------------------------------------------------------------
  // Directory discovery
  // --------------------------------------------------------------------------

  /**
   * Determine the root directories to scan for Claude JSONL logs.
   *
   * If CLAUDE_CONFIG_DIR is set, its comma-separated paths are used.
   * Each path gets "/projects" appended unless it already ends with "projects".
   * Otherwise falls back to the two default locations:
   *   ~/.config/claude/projects
   *   ~/.claude/projects
   */
  private getProjectRoots(): string[] {
    const envVal = process.env.CLAUDE_CONFIG_DIR?.trim();

    if (envVal) {
      const roots: string[] = [];
      for (const part of envVal.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (path.basename(trimmed) === 'projects') {
          roots.push(trimmed);
        } else {
          roots.push(path.join(trimmed, 'projects'));
        }
      }
      return roots;
    }

    const home = os.homedir();
    return [
      path.join(home, '.config', 'claude', 'projects'),
      path.join(home, '.claude', 'projects'),
    ];
  }

  /**
   * Recursively find all .jsonl files under a directory.
   * Skips hidden files and directories.
   */
  private findJsonlFiles(dir: string): string[] {
    const results: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      // Skip hidden files/directories
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // File scanning
  // --------------------------------------------------------------------------

  /**
   * Scan a single JSONL file, using incremental scanning when possible.
   *
   * Incremental scanning logic:
   * - If the file's size and mtime match the cached state, return cached entries.
   * - If the file grew (size > lastSize), read only from lastOffset onward
   *   and merge the new entries with cached ones.
   * - If the file shrunk or mtime changed without size growth, do a full rescan.
   */
  private scanFile(filePath: string): ClaudeUsageEntry[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return [];
    }

    const size = stat.size;
    const mtimeMs = stat.mtimeMs;

    if (size <= 0) return [];

    const cached = this.fileStates.get(filePath);

    // File unchanged: return cached entries
    if (cached && cached.lastSize === size && cached.lastMtimeMs === mtimeMs) {
      return cached.entries;
    }

    // File grew: read only the new portion (incremental scan)
    if (cached && size > cached.lastSize && cached.lastOffset > 0 && cached.lastOffset <= size) {
      const newEntries = this.parseFile(filePath, cached.lastOffset);
      const mergedEntries = [...cached.entries, ...newEntries];

      this.fileStates.set(filePath, {
        filePath,
        lastSize: size,
        lastMtimeMs: mtimeMs,
        lastOffset: size,
        entries: mergedEntries,
      });

      return mergedEntries;
    }

    // Full rescan: file is new, shrunk, or offset is invalid
    const entries = this.parseFile(filePath, 0);

    this.fileStates.set(filePath, {
      filePath,
      lastSize: size,
      lastMtimeMs: mtimeMs,
      lastOffset: size,
      entries,
    });

    return entries;
  }

  /**
   * Parse a JSONL file from a given byte offset.
   *
   * Reads the file line by line from the offset, looking for lines that:
   * 1. Have "type":"assistant" (response messages, not user messages)
   * 2. Contain a "usage" field with token counts
   *
   * Deduplicates by message.id + requestId: Claude streams multiple lines
   * per message with cumulative usage counts. We keep only the first
   * occurrence of each message+request pair (which has the full counts).
   *
   * @param filePath - Absolute path to the JSONL file
   * @param startOffset - Byte offset to start reading from
   * @returns Parsed usage entries
   */
  private parseFile(filePath: string, startOffset: number): ClaudeUsageEntry[] {
    let content: string;
    try {
      const buffer = Buffer.alloc(0);
      const fd = fs.openSync(filePath, 'r');
      try {
        const fileSize = fs.fstatSync(fd).size;
        const readSize = fileSize - startOffset;
        if (readSize <= 0) {
          fs.closeSync(fd);
          return [];
        }
        const readBuffer = Buffer.alloc(readSize);
        fs.readSync(fd, readBuffer, 0, readSize, startOffset);
        content = readBuffer.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }

    // Track seen message+request IDs to deduplicate streaming chunks.
    // Claude emits multiple lines per message with cumulative usage. We keep
    // the LAST occurrence (which has the final cumulative totals).
    const entryByKey = new Map<string, ClaudeUsageEntry>();
    const keylessEntries: ClaudeUsageEntry[] = [];

    const lines = content.split('\n');

    for (const line of lines) {
      if (!line) continue;

      // Fast pre-filter: skip lines that clearly don't match.
      // This avoids the cost of JSON.parse on non-matching lines.
      if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue;
      if (!line.includes('"usage"')) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // Must be an assistant message with usage data
      if (obj.type !== 'assistant') continue;

      const tsText = obj.timestamp as string | undefined;
      if (!tsText) continue;

      const dayKey = dayKeyFromISO(tsText);
      if (!dayKey) continue;

      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const model = message.model as string | undefined;
      if (!model || model === '<synthetic>') continue;

      const usage = message.usage as Record<string, unknown> | undefined;
      if (!usage) continue;

      const inputTokens = Math.max(0, toInt(usage.input_tokens));
      const outputTokens = Math.max(0, toInt(usage.output_tokens));
      const cacheReadInputTokens = Math.max(0, toInt(usage.cache_read_input_tokens));
      const cacheCreationInputTokens = Math.max(0, toInt(usage.cache_creation_input_tokens));

      // Skip entries with zero tokens across all fields
      if (inputTokens === 0 && outputTokens === 0 &&
          cacheReadInputTokens === 0 && cacheCreationInputTokens === 0) {
        continue;
      }

      // Use pre-calculated cost from Claude Code if available
      const costUSD = typeof obj.costUSD === 'number' ? obj.costUSD : undefined;

      const entry: ClaudeUsageEntry = {
        dayKey,
        model: normalizeClaudeModel(model),
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        timestamp: tsText,
        costUSD,
      };

      // Deduplicate by message.id + requestId — keep last (final cumulative totals)
      const messageId = message.id as string | undefined;
      const requestId = obj.requestId as string | undefined;
      if (messageId && requestId) {
        entryByKey.set(`${messageId}:${requestId}`, entry);
      } else {
        keylessEntries.push(entry);
      }
    }

    return [...entryByKey.values(), ...keylessEntries];
  }
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Safely convert a value to an integer.
 * Handles numbers, strings, and null/undefined.
 */
function toInt(value: unknown): number {
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value === 'string') return parseInt(value, 10) || 0;
  return 0;
}

/**
 * Extract a YYYY-MM-DD day key from an ISO 8601 timestamp string.
 * Converts from UTC to the local timezone so the day boundary matches
 * the user's perspective.
 *
 * @param isoText - ISO 8601 timestamp (e.g. "2025-01-15T14:30:00.000Z")
 * @returns Day key string (e.g. "2025-01-15") or null if parsing fails
 */
function dayKeyFromISO(isoText: string): string | null {
  const date = new Date(isoText);
  if (isNaN(date.getTime())) return null;

  // Convert to local timezone components for the day key
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
