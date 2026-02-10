// ============================================================================
// OpenClaw Monitor - Codex JSONL Log Scanner
// ============================================================================
// Scans OpenAI Codex's local JSONL session logs to extract token usage data.
// Supports incremental scanning and delta computation for cumulative totals.
//
// Ported from CodexBar's CostUsageScanner.swift (Codex section).
//
// Log location:
//   ~/.codex/sessions/**/*.jsonl
//   Or the directory specified by CODEX_HOME env var
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeCodexModel } from './modelNormalizer.js';

// ============================================================================
// Types
// ============================================================================

/** A single usage entry extracted from a Codex JSONL log line. */
export interface CodexUsageEntry {
  /** ISO date string (YYYY-MM-DD) in local timezone */
  dayKey: string;
  /** The model that produced this response */
  model: string;
  /** Delta input tokens for this event */
  inputTokens: number;
  /** Delta cached input tokens for this event */
  cachedInputTokens: number;
  /** Delta output tokens for this event */
  outputTokens: number;
  /** ISO 8601 timestamp from the log line */
  timestamp: string;
}

/**
 * Per-file scan state for incremental scanning.
 * Stores byte offsets and cumulative totals for delta computation.
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
  /** Last known cumulative totals (for delta computation) */
  lastTotals: CumulativeTotals | null;
  /** Last known model name from turn_context events */
  lastModel: string | null;
  /** Usage entries extracted from this file */
  entries: CodexUsageEntry[];
}

/** Cumulative token totals from the most recent event_msg in a session. */
interface CumulativeTotals {
  input: number;
  cached: number;
  output: number;
}

// ============================================================================
// CodexLogScanner
// ============================================================================

/**
 * Scans Codex JSONL session logs for usage data.
 *
 * Codex logs have a different structure from Claude logs:
 * - Each session has its own JSONL file
 * - Token counts are reported as cumulative totals in event_msg entries
 * - We compute deltas from consecutive total_token_usage events
 * - turn_context events tell us which model is being used
 */
export class CodexLogScanner {
  // Cache of per-file scan state keyed by absolute file path
  private fileStates = new Map<string, FileScanState>();

  /**
   * Scan all Codex JSONL log files and return usage entries.
   * Uses incremental scanning to avoid re-parsing unchanged files.
   *
   * @returns Array of usage entries across all scanned files
   */
  scan(): CodexUsageEntry[] {
    const roots = this.getSessionRoots();
    const allEntries: CodexUsageEntry[] = [];
    const touchedPaths = new Set<string>();

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

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
   * Determine the root directories to scan for Codex session logs.
   *
   * If CODEX_HOME is set, uses that. Otherwise defaults to ~/.codex.
   * Also checks for an archived_sessions sibling directory.
   */
  private getSessionRoots(): string[] {
    const envHome = process.env.CODEX_HOME?.trim();
    const codexHome = envHome || path.join(os.homedir(), '.codex');
    const sessionsDir = path.join(codexHome, 'sessions');
    const archivedDir = path.join(codexHome, 'archived_sessions');

    const roots = [sessionsDir];
    if (fs.existsSync(archivedDir)) {
      roots.push(archivedDir);
    }

    return roots;
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
   * Scan a single JSONL file with incremental scanning support.
   *
   * For Codex files, incremental scanning also requires carrying forward
   * the cumulative totals from the previous scan, since delta computation
   * depends on knowing the last reported totals.
   */
  private scanFile(filePath: string): CodexUsageEntry[] {
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
      const result = this.parseFile(filePath, cached.lastOffset, cached.lastModel, cached.lastTotals);
      const mergedEntries = [...cached.entries, ...result.entries];

      this.fileStates.set(filePath, {
        filePath,
        lastSize: size,
        lastMtimeMs: mtimeMs,
        lastOffset: size,
        lastTotals: result.lastTotals,
        lastModel: result.lastModel,
        entries: mergedEntries,
      });

      return mergedEntries;
    }

    // Full rescan
    const result = this.parseFile(filePath, 0, null, null);

    this.fileStates.set(filePath, {
      filePath,
      lastSize: size,
      lastMtimeMs: mtimeMs,
      lastOffset: size,
      lastTotals: result.lastTotals,
      lastModel: result.lastModel,
      entries: result.entries,
    });

    return result.entries;
  }

  /**
   * Parse a Codex JSONL file from a given byte offset.
   *
   * Codex log entries have two relevant types:
   * - "turn_context": Contains the model name for subsequent events.
   *   Payload structure: { model: "gpt-5" } or { info: { model: "gpt-5" } }
   * - "event_msg" with payload.type == "token_count": Contains cumulative
   *   token usage in payload.info.total_token_usage.
   *
   * Since token counts are cumulative per session, we compute deltas by
   * subtracting the previous totals from the current ones.
   *
   * @param filePath - Absolute path to the JSONL file
   * @param startOffset - Byte offset to start reading from
   * @param initialModel - Carried-forward model name from previous scan
   * @param initialTotals - Carried-forward cumulative totals from previous scan
   * @returns Parsed entries and final state for incremental scanning
   */
  private parseFile(
    filePath: string,
    startOffset: number,
    initialModel: string | null,
    initialTotals: CumulativeTotals | null,
  ): { entries: CodexUsageEntry[]; lastModel: string | null; lastTotals: CumulativeTotals | null } {
    let content: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const fileSize = fs.fstatSync(fd).size;
        const readSize = fileSize - startOffset;
        if (readSize <= 0) {
          fs.closeSync(fd);
          return { entries: [], lastModel: initialModel, lastTotals: initialTotals };
        }
        const readBuffer = Buffer.alloc(readSize);
        fs.readSync(fd, readBuffer, 0, readSize, startOffset);
        content = readBuffer.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { entries: [], lastModel: initialModel, lastTotals: initialTotals };
    }

    const entries: CodexUsageEntry[] = [];
    let currentModel = initialModel;
    let previousTotals = initialTotals;

    const lines = content.split('\n');

    for (const line of lines) {
      if (!line) continue;

      // Fast pre-filter: skip lines that don't contain relevant event types
      const isEventMsg = line.includes('"type":"event_msg"') || line.includes('"type": "event_msg"');
      const isTurnContext = line.includes('"type":"turn_context"') || line.includes('"type": "turn_context"');

      if (!isEventMsg && !isTurnContext) continue;

      // For event_msg, also require token_count payload
      if (isEventMsg && !line.includes('"token_count"')) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const type = obj.type as string;
      const tsText = obj.timestamp as string | undefined;

      // Handle turn_context: update the current model
      if (type === 'turn_context') {
        const payload = obj.payload as Record<string, unknown> | undefined;
        if (payload) {
          const modelFromPayload = payload.model as string | undefined;
          const info = payload.info as Record<string, unknown> | undefined;
          const modelFromInfo = info?.model as string | undefined;
          currentModel = modelFromPayload ?? modelFromInfo ?? currentModel;
        }
        continue;
      }

      // Handle event_msg with token_count payload
      if (type !== 'event_msg') continue;
      if (!tsText) continue;

      const dayKey = dayKeyFromISO(tsText);
      if (!dayKey) continue;

      const payload = obj.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      if (payload.type !== 'token_count') continue;

      const info = payload.info as Record<string, unknown> | undefined;

      // Determine the model name: check info, payload, then fall back to
      // the most recent turn_context model, defaulting to "gpt-5"
      const modelFromInfo = (info?.model as string) ??
                            (info?.model_name as string) ??
                            (payload.model as string) ??
                            (obj.model as string);
      const model = modelFromInfo ?? currentModel ?? 'gpt-5';

      // Extract cumulative totals or per-turn deltas
      const total = info?.total_token_usage as Record<string, unknown> | undefined;
      const last = info?.last_token_usage as Record<string, unknown> | undefined;

      let deltaInput = 0;
      let deltaCached = 0;
      let deltaOutput = 0;

      if (total) {
        // Cumulative totals: compute delta from previous totals
        const input = toInt(total.input_tokens);
        const cached = toInt(total.cached_input_tokens ?? total.cache_read_input_tokens);
        const output = toInt(total.output_tokens);

        deltaInput = Math.max(0, input - (previousTotals?.input ?? 0));
        deltaCached = Math.max(0, cached - (previousTotals?.cached ?? 0));
        deltaOutput = Math.max(0, output - (previousTotals?.output ?? 0));

        previousTotals = { input, cached, output };
      } else if (last) {
        // Per-turn usage: use directly as delta
        deltaInput = Math.max(0, toInt(last.input_tokens));
        deltaCached = Math.max(0, toInt(last.cached_input_tokens ?? last.cache_read_input_tokens));
        deltaOutput = Math.max(0, toInt(last.output_tokens));
      } else {
        continue;
      }

      // Skip zero-delta entries
      if (deltaInput === 0 && deltaCached === 0 && deltaOutput === 0) continue;

      // Clamp cached tokens to not exceed input tokens
      const cachedClamped = Math.min(deltaCached, deltaInput);

      entries.push({
        dayKey,
        model: normalizeCodexModel(model),
        inputTokens: deltaInput,
        cachedInputTokens: cachedClamped,
        outputTokens: deltaOutput,
        timestamp: tsText,
      });
    }

    return { entries, lastModel: currentModel, lastTotals: previousTotals };
  }
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Safely convert a value to an integer.
 */
function toInt(value: unknown): number {
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value === 'string') return parseInt(value, 10) || 0;
  return 0;
}

/**
 * Extract a YYYY-MM-DD day key from an ISO 8601 timestamp string.
 * Converts from UTC to the local timezone.
 */
function dayKeyFromISO(isoText: string): string | null {
  const date = new Date(isoText);
  if (isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
