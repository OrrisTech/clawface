// ============================================================================
// Tests for AiUsageTracker
// Verifies request logging, cost calculation, period-based aggregation,
// and old-data cleanup. Uses a temporary SQLite database file per test
// to ensure isolation.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AiUsageTracker } from '../src/aiUsageTracker.js';

/** Generate a unique temp DB path for each test */
function tempDbPath(): string {
  return path.join(os.tmpdir(), `openclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('AiUsageTracker', () => {
  let tracker: AiUsageTracker;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    tracker = new AiUsageTracker(dbPath);
  });

  afterEach(() => {
    tracker.close();
    // Clean up temp DB files
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  // --------------------------------------------------------------------------
  // logRequest
  // --------------------------------------------------------------------------

  describe('logRequest()', () => {
    it('should log a request and include it in the summary', () => {
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0].provider).toBe('anthropic');
      expect(summary.providers[0].requestCount).toBe(1);
      expect(summary.providers[0].totalInputTokens).toBe(1000);
      expect(summary.providers[0].totalOutputTokens).toBe(500);
    });

    it('should log multiple requests from different providers', () => {
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 2000,
        outputTokens: 1000,
        source: 'telegram',
      });

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers).toHaveLength(2);

      const anthropic = summary.providers.find(p => p.provider === 'anthropic');
      const openai = summary.providers.find(p => p.provider === 'openai');
      expect(anthropic).toBeDefined();
      expect(openai).toBeDefined();
      expect(anthropic!.requestCount).toBe(1);
      expect(openai!.requestCount).toBe(1);
    });

    it('should aggregate multiple requests for the same model', () => {
      for (let i = 0; i < 5; i++) {
        tracker.logRequest({
          timestamp: Date.now(),
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          inputTokens: 100,
          outputTokens: 50,
          source: 'discord',
        });
      }

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0].requestCount).toBe(5);
      expect(summary.providers[0].totalInputTokens).toBe(500);
      expect(summary.providers[0].totalOutputTokens).toBe(250);
    });

    it('should store optional sessionId', () => {
      // This should not throw; sessionId is optional metadata
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        source: 'api',
        sessionId: 'session-abc-123',
      });

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers[0].requestCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Cost calculation
  // --------------------------------------------------------------------------

  describe('cost calculation', () => {
    it('should calculate cost correctly for claude-sonnet-4-5', () => {
      // Pricing: input $3.0/1M, output $15.0/1M (base)
      // Tiered: above 200k tokens: input $6.0/1M, output $22.5/1M
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      // Input: 200k @ $3.0 + 800k @ $6.0 = 0.6 + 4.8 = 5.4
      // Output: 200k @ $15.0 + 800k @ $22.5 = 3.0 + 18.0 = 21.0
      // Total: 5.4 + 21.0 = 26.4
      expect(summary.totalCostToday).toBe(26.4);
    });

    it('should calculate cost correctly for gpt-4o-mini', () => {
      // Pricing: input $0.15/1M, output $0.60/1M
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 10_000_000,
        outputTokens: 5_000_000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      // Expected: (10M / 1M * 0.15) + (5M / 1M * 0.60) = 1.5 + 3.0 = 4.5
      expect(summary.totalCostToday).toBe(4.5);
    });

    it('should calculate cost correctly for deepseek-r1', () => {
      // Pricing: input $0.55/1M, output $2.19/1M
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'deepseek',
        model: 'deepseek-r1',
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        source: 'telegram',
      });

      const summary = tracker.getUsageSummary('today');
      // Expected: (2M / 1M * 0.55) + (1M / 1M * 2.19) = 1.10 + 2.19 = 3.29
      expect(summary.totalCostToday).toBe(3.29);
    });

    it('should return zero cost for unknown models', () => {
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'other',
        model: 'some-unknown-model',
        inputTokens: 50000,
        outputTokens: 25000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      expect(summary.totalCostToday).toBe(0);
      // Request should still be counted
      expect(summary.providers[0].requestCount).toBe(1);
      expect(summary.providers[0].totalInputTokens).toBe(50000);
    });

    it('should accumulate costs across multiple requests', () => {
      // claude-sonnet-4-5: input $3.0/1M base, $6.0/1M above 200k
      // 1M input => 200k @ $3.0 + 800k @ $6.0 = 0.6 + 4.8 = 5.4
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        source: 'api',
      });
      // gpt-4o: input $2.50/1M, output $10.0/1M
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 1_000_000,
        outputTokens: 0,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      // Expected: 5.4 + 2.50 = 7.90
      expect(summary.totalCostToday).toBe(7.9);
    });
  });

  // --------------------------------------------------------------------------
  // getUsageSummary - period filtering
  // --------------------------------------------------------------------------

  describe('getUsageSummary()', () => {
    it('should return empty summary when no requests exist', () => {
      const summary = tracker.getUsageSummary('today');
      expect(summary.period).toBe('today');
      expect(summary.providers).toHaveLength(0);
      expect(summary.totalCostToday).toBe(0);
      expect(summary.totalCostThisMonth).toBe(0);
    });

    it('should filter by "today" period correctly', () => {
      const now = Date.now();

      // Request from today
      tracker.logRequest({
        timestamp: now,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      // Request from 2 days ago (should be excluded from "today")
      tracker.logRequest({
        timestamp: now - 2 * 24 * 60 * 60 * 1000,
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 2000,
        outputTokens: 1000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      // Only the anthropic request should appear in the "today" providers
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0].provider).toBe('anthropic');
    });

    it('should include past-week requests in "week" period', () => {
      const now = Date.now();

      // Request from today
      tracker.logRequest({
        timestamp: now,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      // Request from 3 days ago (within the week)
      tracker.logRequest({
        timestamp: now - 3 * 24 * 60 * 60 * 1000,
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 2000,
        outputTokens: 1000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('week');
      expect(summary.period).toBe('week');
      // Both requests should appear
      expect(summary.providers).toHaveLength(2);
    });

    it('should include all month requests in "month" period', () => {
      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

      // Request on the 1st of this month
      tracker.logRequest({
        timestamp: firstOfMonth + 1000,
        provider: 'google',
        model: 'gemini-2.0-flash',
        inputTokens: 5000,
        outputTokens: 2000,
        source: 'api',
      });

      // Request now
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('month');
      expect(summary.period).toBe('month');
      expect(summary.providers).toHaveLength(2);
    });

    it('should always include totalCostToday and totalCostThisMonth', () => {
      // claude-sonnet-4-5: 1M input with tiered pricing
      // 200k @ $3.0 + 800k @ $6.0 = 0.6 + 4.8 = 5.4
      tracker.logRequest({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        source: 'api',
      });

      // Even when querying for "week", today/month costs should be populated
      const summary = tracker.getUsageSummary('week');
      expect(summary.totalCostToday).toBe(5.4);
      expect(summary.totalCostThisMonth).toBeGreaterThanOrEqual(5.4);
    });

    it('should provide per-model breakdown within a provider', () => {
      const now = Date.now();

      tracker.logRequest({
        timestamp: now,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      tracker.logRequest({
        timestamp: now,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 2000,
        outputTokens: 1000,
        source: 'api',
      });

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers).toHaveLength(1);
      const anthropic = summary.providers[0];
      expect(anthropic.models).toHaveLength(2);
      expect(anthropic.requestCount).toBe(2);
      expect(anthropic.totalInputTokens).toBe(3000);
      expect(anthropic.totalOutputTokens).toBe(1500);

      const modelNames = anthropic.models.map(m => m.model).sort();
      expect(modelNames).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5']);
    });
  });

  // --------------------------------------------------------------------------
  // cleanupOldData
  // --------------------------------------------------------------------------

  describe('cleanupOldData()', () => {
    it('should delete records older than the retention period', () => {
      const now = Date.now();

      // Record from 60 days ago (should be deleted with 30-day retention)
      tracker.logRequest({
        timestamp: now - 60 * 24 * 60 * 60 * 1000,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      // Record from today (should be kept)
      tracker.logRequest({
        timestamp: now,
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 2000,
        outputTokens: 1000,
        source: 'api',
      });

      // Before cleanup: both should be visible in a month-spanning query
      // (the old record is outside the "month" window, so query "today"
      // and ensure the record from today is there)

      tracker.cleanupOldData(30);

      // After cleanup: only today's record should remain
      // Use a very wide period to check total count
      const summary = tracker.getUsageSummary('month');
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0].provider).toBe('openai');
    });

    it('should keep records within the retention period', () => {
      const now = Date.now();

      // Record from 3 days ago (within 30-day retention)
      tracker.logRequest({
        timestamp: now - 3 * 24 * 60 * 60 * 1000,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      tracker.cleanupOldData(30);

      // Record should still be there (visible in the week view)
      const summary = tracker.getUsageSummary('week');
      expect(summary.providers).toHaveLength(1);
    });

    it('should handle cleanup with custom retention days', () => {
      const now = Date.now();

      // Record from 5 days ago
      tracker.logRequest({
        timestamp: now - 5 * 24 * 60 * 60 * 1000,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        source: 'api',
      });

      // Cleanup with 3-day retention should delete it
      tracker.cleanupOldData(3);

      const summary = tracker.getUsageSummary('month');
      expect(summary.providers).toHaveLength(0);
    });

    it('should be a no-op when there is nothing to clean', () => {
      // No records at all; cleanup should not throw
      tracker.cleanupOldData(30);

      const summary = tracker.getUsageSummary('today');
      expect(summary.providers).toHaveLength(0);
    });
  });
});
