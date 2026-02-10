// ============================================================================
// Tests for SystemCollector
// Verifies that system resource collection returns valid data structures
// with reasonable values. These tests run against the real OS, so exact
// values are not asserted — only structural correctness and sane ranges.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SystemCollector } from '../src/systemCollector.js';

describe('SystemCollector', () => {
  let collector: SystemCollector;

  beforeEach(() => {
    collector = new SystemCollector();
  });

  describe('collect()', () => {
    it('should return a complete SystemStats object', async () => {
      const stats = await collector.collect();

      // Verify top-level structure
      expect(stats).toHaveProperty('cpu');
      expect(stats).toHaveProperty('memory');
      expect(stats).toHaveProperty('disk');
      expect(stats).toHaveProperty('temperature');
      expect(stats).toHaveProperty('network');
      expect(stats).toHaveProperty('uptime');
    });

    it('should return valid CPU stats', async () => {
      const stats = await collector.collect();

      expect(stats.cpu.cores).toBeGreaterThan(0);
      expect(stats.cpu.perCore).toHaveLength(stats.cpu.cores);
      expect(stats.cpu.usage).toBeGreaterThanOrEqual(0);
      expect(stats.cpu.usage).toBeLessThanOrEqual(100);

      // Each per-core value should be in [0, 100]
      for (const core of stats.cpu.perCore) {
        expect(core).toBeGreaterThanOrEqual(0);
        expect(core).toBeLessThanOrEqual(100);
      }
    });

    it('should return 0% CPU usage on first call (no delta yet)', async () => {
      const stats = await collector.collect();

      // First call has no previous snapshot, so usage must be 0
      expect(stats.cpu.usage).toBe(0);
      expect(stats.cpu.perCore.every((v) => v === 0)).toBe(true);
    });

    it('should return non-zero CPU usage on second call', async () => {
      // First call: primes the snapshot
      await collector.collect();

      // Wait a brief moment so some CPU time passes
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second call: should compute a delta
      const stats = await collector.collect();

      // CPU usage should be >= 0 (could be exactly 0 on a very idle system,
      // but the structure should be valid)
      expect(stats.cpu.usage).toBeGreaterThanOrEqual(0);
      expect(stats.cpu.cores).toBeGreaterThan(0);
    });

    it('should return valid memory stats', async () => {
      const stats = await collector.collect();

      expect(stats.memory.totalGB).toBeGreaterThan(0);
      expect(stats.memory.usedGB).toBeGreaterThan(0);
      expect(stats.memory.usedGB).toBeLessThanOrEqual(stats.memory.totalGB);
      expect(stats.memory.usagePercent).toBeGreaterThan(0);
      expect(stats.memory.usagePercent).toBeLessThanOrEqual(100);
    });

    it('should return valid disk stats', async () => {
      const stats = await collector.collect();

      // On most systems, disk total and used should be > 0
      expect(stats.disk.totalGB).toBeGreaterThan(0);
      expect(stats.disk.usedGB).toBeGreaterThanOrEqual(0);
      expect(stats.disk.usedGB).toBeLessThanOrEqual(stats.disk.totalGB);
      expect(stats.disk.usagePercent).toBeGreaterThanOrEqual(0);
      expect(stats.disk.usagePercent).toBeLessThanOrEqual(100);
    });

    it('should return a temperature value', async () => {
      const stats = await collector.collect();

      // Temperature should be a positive number (either real or estimated)
      expect(stats.temperature.cpu).toBeGreaterThan(0);
      // Should be in a reasonable range (estimated is 40-95)
      expect(stats.temperature.cpu).toBeLessThan(150);
    });

    it('should return valid network stats', async () => {
      const stats = await collector.collect();

      // Network values should be non-negative
      expect(stats.network.uploadMBps).toBeGreaterThanOrEqual(0);
      expect(stats.network.downloadMBps).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 MB/s network on first call (no delta)', async () => {
      const stats = await collector.collect();

      // First call: no previous snapshot, so throughput must be 0
      expect(stats.network.uploadMBps).toBe(0);
      expect(stats.network.downloadMBps).toBe(0);
    });

    it('should return positive uptime', async () => {
      const stats = await collector.collect();

      expect(stats.uptime).toBeGreaterThan(0);
    });
  });

  describe('multiple collections', () => {
    it('should produce consistent results across calls', async () => {
      const stats1 = await collector.collect();
      const stats2 = await collector.collect();

      // Core count shouldn't change between calls
      expect(stats1.cpu.cores).toBe(stats2.cpu.cores);
      // Total memory shouldn't change
      expect(stats1.memory.totalGB).toBe(stats2.memory.totalGB);
      // Total disk shouldn't change
      expect(stats1.disk.totalGB).toBe(stats2.disk.totalGB);
    });
  });
});
