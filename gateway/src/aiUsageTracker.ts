// ============================================================================
// OpenClaw Monitor - AI Usage Tracker
// Logs AI API requests with token counts and costs into a local SQLite
// database. Provides aggregated usage summaries by provider, model, and
// time period. Uses better-sqlite3 for synchronous, concurrency-safe access.
// ============================================================================

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type {
  AiRequestLog,
  AiProvider,
  UsageSummary,
  ProviderSummary,
  ModelSummary,
} from './types.js';
import { normalizeCodexModel, normalizeClaudeModel } from './modelNormalizer.js';
import { ClaudeLogScanner } from './claudeLogScanner.js';
import { CodexLogScanner } from './codexLogScanner.js';

// ============================================================================
// Model pricing table
// ============================================================================
// Comprehensive pricing ported from CodexBar's CostUsagePricing.swift.
// Costs are per 1M tokens in USD. Cache and tiered pricing included where
// applicable.
// ============================================================================

/**
 * Pricing entry for a single model.
 * input/output are per-1M-token rates in USD.
 * Optional cacheRead/cacheCreation rates for prompt caching.
 * Optional aboveThreshold tier for models with tiered pricing.
 */
interface PricingEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** When present, tokens above this threshold use the higher rates */
  aboveThreshold?: {
    thresholdTokens: number;
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
}

/**
 * Comprehensive pricing table covering all known models.
 * Ported from CodexBar's CostUsagePricing.swift.
 * Models not in this table default to zero cost (still logged).
 */
const MODEL_PRICING: Record<string, PricingEntry> = {
  // ---------------------------------------------------------------------------
  // OpenAI / Codex models
  // ---------------------------------------------------------------------------
  'gpt-5': {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.125,
  },
  'gpt-5-codex': {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.125,
  },
  'gpt-5.1': {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.125,
  },
  'gpt-5.2': {
    input: 1.75,
    output: 14.0,
    cacheRead: 0.175,
  },
  'gpt-5.2-codex': {
    input: 1.75,
    output: 14.0,
    cacheRead: 0.175,
  },
  'gpt-4o': {
    input: 2.50,
    output: 10.0,
  },
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.60,
  },

  // ---------------------------------------------------------------------------
  // Anthropic / Claude models
  // ---------------------------------------------------------------------------
  'claude-haiku-4-5': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  },
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  },
  'claude-opus-4-5': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
  },
  'claude-opus-4-5-20251101': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
  },
  'claude-sonnet-4-5': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    aboveThreshold: {
      thresholdTokens: 200_000,
      input: 6.0,
      output: 22.5,
      cacheRead: 0.6,
      cacheCreation: 7.5,
    },
  },
  'claude-sonnet-4-5-20250929': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    aboveThreshold: {
      thresholdTokens: 200_000,
      input: 6.0,
      output: 22.5,
      cacheRead: 0.6,
      cacheCreation: 7.5,
    },
  },
  'claude-opus-4-1': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheCreation: 18.75,
  },
  'claude-opus-4-20250514': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheCreation: 18.75,
  },
  'claude-opus-4-6': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
    aboveThreshold: {
      thresholdTokens: 200_000,
      input: 10.0,
      output: 37.5,
      cacheRead: 1.0,
      cacheCreation: 12.5,
    },
  },
  'claude-opus-4-6-20260205': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
    aboveThreshold: {
      thresholdTokens: 200_000,
      input: 10.0,
      output: 37.5,
      cacheRead: 1.0,
      cacheCreation: 12.5,
    },
  },
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    aboveThreshold: {
      thresholdTokens: 200_000,
      input: 6.0,
      output: 22.5,
      cacheRead: 0.6,
      cacheCreation: 7.5,
    },
  },

  // ---------------------------------------------------------------------------
  // Google Gemini models
  // ---------------------------------------------------------------------------
  'gemini-2.0-flash': {
    input: 0.10,
    output: 0.40,
  },

  // ---------------------------------------------------------------------------
  // DeepSeek models
  // ---------------------------------------------------------------------------
  'deepseek-v3': {
    input: 0.27,
    output: 1.10,
  },
  'deepseek-r1': {
    input: 0.55,
    output: 2.19,
  },
};

export class AiUsageTracker {
  private db: Database.Database;
  private claudeScanner = new ClaudeLogScanner();
  private codexScanner = new CodexLogScanner();

  /**
   * Create or open the AI usage database.
   * @param dbPath - Path to the SQLite file. Defaults to ~/.openclaw/ai-usage.db
   */
  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(os.homedir(), '.openclaw', 'ai-usage.db');

    // Ensure the parent directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent read/write performance
    this.db.pragma('journal_mode = WAL');

    this.initDb();
  }

  // --------------------------------------------------------------------------
  // Schema initialization
  // --------------------------------------------------------------------------

  /**
   * Create the usage log table and indexes if they don't already exist.
   * The schema is designed for efficient time-range queries and per-provider
   * aggregation. Includes cache token columns for prompt caching support.
   */
  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ai_requests_timestamp
        ON ai_requests(timestamp);

      CREATE INDEX IF NOT EXISTS idx_ai_requests_provider
        ON ai_requests(provider, timestamp);
    `);

    // Migration: add cache token columns to existing databases
    this.migrateAddCacheColumns();

    // Migration: deduplicate existing rows BEFORE creating the unique index
    // (unique index creation would fail if duplicates exist)
    this.migrateDeduplicateRows();

    // Migration: recalculate costs for opus-4-6 (was 3x overpriced at $15/$75 instead of $5/$25)
    this.migrateRecalculateOpus46Costs();

    // Now safe to add the unique dedup index (duplicates have been removed)
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_requests_dedup' +
      ' ON ai_requests(timestamp, provider, model, source, input_tokens, output_tokens)'
    );
  }

  /**
   * Add cache token columns if they don't exist (safe migration for existing DBs).
   */
  private migrateAddCacheColumns(): void {
    const columns = this.db.pragma('table_info(ai_requests)') as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));
    if (!columnNames.has('cache_read_input_tokens')) {
      this.db.exec('ALTER TABLE ai_requests ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.has('cache_creation_input_tokens')) {
      this.db.exec('ALTER TABLE ai_requests ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * Remove duplicate rows that accumulated before the unique index was added.
   * Keeps only the row with the lowest id for each (timestamp, provider, model, source, input_tokens, output_tokens).
   */
  private migrateDeduplicateRows(): void {
    const result = this.db.prepare(`
      DELETE FROM ai_requests
      WHERE id NOT IN (
        SELECT MIN(id) FROM ai_requests
        GROUP BY timestamp, provider, model, source, input_tokens, output_tokens
      )
    `).run();
    if (result.changes > 0) {
      console.log(`[AiUsageTracker] Deduplicated ${result.changes} duplicate rows`);
    }
  }

  /**
   * Recalculate costs for claude-opus-4-6 rows that were stored with the
   * incorrect $15/$75 pricing (should be $5/$25 with >200k tier).
   */
  private migrateRecalculateOpus46Costs(): void {
    const rows = this.db.prepare(
      "SELECT id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens FROM ai_requests WHERE model = 'claude-opus-4-6'"
    ).all() as Array<{ id: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>;

    if (rows.length === 0) return;

    const update = this.db.prepare('UPDATE ai_requests SET estimated_cost = ? WHERE id = ?');
    let fixed = 0;
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const newCost = this.calculateCost('claude-opus-4-6', row.input_tokens, row.output_tokens, row.cache_read_input_tokens, row.cache_creation_input_tokens);
        update.run(newCost, row.id);
        fixed++;
      }
    });
    txn();
    if (fixed > 0) {
      console.log(`[AiUsageTracker] Recalculated costs for ${fixed} claude-opus-4-6 rows (was 3x overpriced)`);
    }
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  /**
   * Log a single AI API request. If a pre-calculated cost is provided (e.g.
   * from Claude Code's costUSD field), it is used directly. Otherwise the cost
   * is estimated from the pricing table and token counts.
   *
   * @param entry - The request data (without estimatedCost, which is computed)
   * @param preCalculatedCost - Optional pre-calculated cost in USD from the source
   */
  logRequest(entry: Omit<AiRequestLog, 'estimatedCost'>, preCalculatedCost?: number): void {
    // Normalize the model name so pricing lookups match the canonical table keys
    const normalizedModel = this.normalizeModel(entry.model, entry.provider);

    // Prefer pre-calculated cost from the source (e.g. Claude Code's costUSD)
    const estimatedCost = preCalculatedCost ?? this.calculateCost(
      normalizedModel,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadInputTokens ?? 0,
      entry.cacheCreationInputTokens ?? 0,
    );

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ai_requests (timestamp, provider, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, estimated_cost, source, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.timestamp,
      entry.provider,
      normalizedModel,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadInputTokens ?? 0,
      entry.cacheCreationInputTokens ?? 0,
      estimatedCost,
      entry.source,
      entry.sessionId ?? null,
    );
  }

  /**
   * Normalize a model name based on its provider.
   * Delegates to the appropriate normalizer for OpenAI/Codex vs Anthropic/Claude.
   */
  private normalizeModel(model: string, provider: AiProvider): string {
    switch (provider) {
      case 'openai':
        return normalizeCodexModel(model);
      case 'anthropic':
        return normalizeClaudeModel(model);
      default:
        return model.trim();
    }
  }

  // --------------------------------------------------------------------------
  // Cost calculation
  // --------------------------------------------------------------------------

  /**
   * Calculate the estimated cost of a request using the pricing table.
   * Supports cache token pricing and tiered pricing (above-threshold rates).
   * Returns 0 for unknown models (still logged, just no cost assigned).
   *
   * @param model - Normalized model identifier
   * @param inputTokens - Number of input tokens (non-cached portion)
   * @param outputTokens - Number of output tokens
   * @param cacheReadTokens - Number of cache-read input tokens
   * @param cacheCreationTokens - Number of cache-creation input tokens
   * @returns Estimated cost in USD
   */
  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheCreationTokens: number = 0,
  ): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;

    // Helper: compute tiered cost for a token count. If the model has an
    // above-threshold tier, tokens below the threshold use the base rate and
    // tokens above use the higher rate.
    const tieredCost = (
      tokens: number,
      baseRate: number,
      aboveRate: number | undefined,
      threshold: number | undefined,
    ): number => {
      if (threshold == null || aboveRate == null) {
        return (tokens / 1_000_000) * baseRate;
      }
      const below = Math.min(tokens, threshold);
      const above = Math.max(tokens - threshold, 0);
      return (below / 1_000_000) * baseRate + (above / 1_000_000) * aboveRate;
    };

    const tier = pricing.aboveThreshold;
    const threshold = tier?.thresholdTokens;

    const inputCost = tieredCost(
      Math.max(0, inputTokens),
      pricing.input,
      tier?.input,
      threshold,
    );
    const outputCost = tieredCost(
      Math.max(0, outputTokens),
      pricing.output,
      tier?.output,
      threshold,
    );
    const cacheReadCost = tieredCost(
      Math.max(0, cacheReadTokens),
      pricing.cacheRead ?? 0,
      tier?.cacheRead,
      threshold,
    );
    const cacheCreationCost = tieredCost(
      Math.max(0, cacheCreationTokens),
      pricing.cacheCreation ?? 0,
      tier?.cacheCreation,
      threshold,
    );

    const total = inputCost + outputCost + cacheReadCost + cacheCreationCost;

    // Round to 6 decimal places to avoid floating-point noise
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  // --------------------------------------------------------------------------
  // Aggregation
  // --------------------------------------------------------------------------

  /**
   * Get an aggregated usage summary for a given time period.
   * Always includes today's and this month's total cost regardless of the
   * requested period, since those are shown prominently in the UI.
   *
   * @param period - 'today', 'week', or 'month'
   * @returns Usage summary with per-provider and per-model breakdowns
   */
  getUsageSummary(period: 'today' | 'week' | 'month'): UsageSummary {
    const now = new Date();

    // Calculate the start timestamp for the requested period
    const periodStart = this.getPeriodStartTimestamp(period, now);

    // Query: aggregate by provider and model within the requested period
    const rows = this.db.prepare(`
      SELECT
        provider,
        model,
        COUNT(*) as request_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_read_input_tokens) as total_cache_read,
        SUM(cache_creation_input_tokens) as total_cache_creation,
        SUM(estimated_cost) as total_cost
      FROM ai_requests
      WHERE timestamp >= ?
      GROUP BY provider, model
      ORDER BY provider, total_cost DESC
    `).all(periodStart) as Array<{
      provider: string;
      model: string;
      request_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read: number;
      total_cache_creation: number;
      total_cost: number;
    }>;

    // Build per-provider summaries with nested model breakdowns
    const providerMap = new Map<string, ProviderSummary>();

    for (const row of rows) {
      let provSummary = providerMap.get(row.provider);
      if (!provSummary) {
        provSummary = {
          provider: row.provider as AiProvider,
          requestCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          models: [],
        };
        providerMap.set(row.provider, provSummary);
      }

      const modelSummary: ModelSummary = {
        model: row.model,
        requestCount: row.request_count,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        totalCacheReadInputTokens: row.total_cache_read || undefined,
        totalCacheCreationInputTokens: row.total_cache_creation || undefined,
        totalCost: row.total_cost,
      };

      provSummary.models.push(modelSummary);
      provSummary.requestCount += row.request_count;
      provSummary.totalInputTokens += row.total_input_tokens;
      provSummary.totalOutputTokens += row.total_output_tokens;
      provSummary.totalCacheReadInputTokens = (provSummary.totalCacheReadInputTokens ?? 0) + row.total_cache_read;
      provSummary.totalCacheCreationInputTokens = (provSummary.totalCacheCreationInputTokens ?? 0) + row.total_cache_creation;
      provSummary.totalCost += row.total_cost;
    }

    // Compute today's cost and this month's cost (always included)
    const todayStart = this.getPeriodStartTimestamp('today', now);
    const monthStart = this.getPeriodStartTimestamp('month', now);

    const totalCostToday = this.getTotalCostSince(todayStart);
    const totalCostThisMonth = this.getTotalCostSince(monthStart);

    return {
      period,
      providers: Array.from(providerMap.values()),
      totalCostToday: Math.round(totalCostToday * 100) / 100,
      totalCostThisMonth: Math.round(totalCostThisMonth * 100) / 100,
    };
  }

  /**
   * Calculate the Unix timestamp (ms) for the start of a time period.
   */
  private getPeriodStartTimestamp(period: 'today' | 'week' | 'month', now: Date): number {
    switch (period) {
      case 'today': {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return start.getTime();
      }
      case 'week': {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
        return start.getTime();
      }
      case 'month': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return start.getTime();
      }
    }
  }

  /**
   * Sum all estimated costs since a given timestamp.
   */
  private getTotalCostSince(sinceTimestamp: number): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) as total
      FROM ai_requests
      WHERE timestamp >= ?
    `).get(sinceTimestamp) as { total: number };
    return row.total;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Remove detailed request logs older than the retention period (default 30 days).
   * This helps keep the database file small on long-running gateways.
   *
   * @param retentionDays - Number of days of detailed data to keep
   */
  cleanupOldData(retentionDays: number = 30): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const result = this.db.prepare(`
      DELETE FROM ai_requests WHERE timestamp < ?
    `).run(cutoff);

    if (result.changes > 0) {
      // Reclaim disk space after a large deletion
      this.db.pragma('optimize');
    }
  }

  // --------------------------------------------------------------------------
  // Local log scanning
  // --------------------------------------------------------------------------

  /**
   * Scan local Claude Code and Codex JSONL log files and feed the results
   * into the usage database via logRequest().
   *
   * This method uses the ClaudeLogScanner and CodexLogScanner to find and
   * parse JSONL files, then logs each usage entry as an AI request. The
   * scanners handle incremental scanning internally, so repeated calls are
   * efficient (only new/changed data is re-parsed).
   *
   * @returns The number of new entries logged
   */
  scanLocalLogs(): number {
    let count = 0;

    // Scan Claude logs
    const claudeEntries = this.claudeScanner.scan();
    for (const entry of claudeEntries) {
      this.logRequest({
        timestamp: new Date(entry.timestamp).getTime(),
        provider: 'anthropic',
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadInputTokens: entry.cacheReadInputTokens,
        cacheCreationInputTokens: entry.cacheCreationInputTokens,
        source: 'claude-code',
      }, entry.costUSD);
      count++;
    }

    // Scan Codex logs
    const codexEntries = this.codexScanner.scan();
    for (const entry of codexEntries) {
      this.logRequest({
        timestamp: new Date(entry.timestamp).getTime(),
        provider: 'openai',
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadInputTokens: entry.cachedInputTokens,
        source: 'api',
      });
      count++;
    }

    return count;
  }

  /**
   * Close the database connection gracefully.
   * Should be called when the monitor is shutting down.
   */
  close(): void {
    this.db.close();
  }
}
