// ============================================================================
// Tests for PairManager
// Verifies pairing code format, expiry logic, rotation behavior, and the
// onNewCode callback. Uses vi.useFakeTimers() to test time-dependent
// behavior without waiting for real 5-minute intervals.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PairManager } from '../src/pairManager.js';

describe('PairManager', () => {
  let pairManager: PairManager;

  beforeEach(() => {
    pairManager = new PairManager();
  });

  afterEach(() => {
    pairManager.stopRotation();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Code generation
  // --------------------------------------------------------------------------

  describe('generateCode()', () => {
    it('should return a code in CLAW-XXXX format', () => {
      const code = pairManager.generateCode();
      expect(code).toMatch(/^CLAW-[A-Z0-9]{4}$/);
    });

    it('should only use the safe alphabet (no 0, O, 1, I, l)', () => {
      // Generate many codes and check none contain ambiguous characters
      const ambiguousChars = /[0O1Il]/;
      for (let i = 0; i < 100; i++) {
        const code = pairManager.generateCode();
        const suffix = code.slice(5); // Remove "CLAW-" prefix
        expect(suffix).not.toMatch(ambiguousChars);
      }
    });

    it('should generate unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        codes.add(pairManager.generateCode());
      }
      // With a 31-char alphabet and 4-char suffix, collision in 50 attempts
      // is extremely unlikely (~50/31^4 = 50/923521 < 0.01%)
      expect(codes.size).toBe(50);
    });

    it('should set the current code after generation', () => {
      const code = pairManager.generateCode();
      expect(pairManager.getCurrentCode()).toBe(code);
    });
  });

  // --------------------------------------------------------------------------
  // Code validity and expiry
  // --------------------------------------------------------------------------

  describe('isCodeValid() / getCurrentCode()', () => {
    it('should return false before any code is generated', () => {
      expect(pairManager.isCodeValid()).toBe(false);
      expect(pairManager.getCurrentCode()).toBeNull();
    });

    it('should return true immediately after generating a code', () => {
      pairManager.generateCode();
      expect(pairManager.isCodeValid()).toBe(true);
    });

    it('should return the code when valid', () => {
      const code = pairManager.generateCode();
      expect(pairManager.getCurrentCode()).toBe(code);
    });

    it('should expire after 5 minutes', () => {
      vi.useFakeTimers();

      pairManager.generateCode();
      expect(pairManager.isCodeValid()).toBe(true);

      // Advance time by 4 minutes 59 seconds -- still valid
      vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000);
      expect(pairManager.isCodeValid()).toBe(true);

      // Advance past the 5-minute mark
      vi.advanceTimersByTime(2000);
      expect(pairManager.isCodeValid()).toBe(false);
      expect(pairManager.getCurrentCode()).toBeNull();
    });

    it('should replace old code when generating a new one', () => {
      const code1 = pairManager.generateCode();
      const code2 = pairManager.generateCode();

      expect(code1).not.toBe(code2);
      expect(pairManager.getCurrentCode()).toBe(code2);
    });
  });

  // --------------------------------------------------------------------------
  // Display
  // --------------------------------------------------------------------------

  describe('displayCode()', () => {
    it('should print the code to console without errors', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      pairManager.generateCode();
      pairManager.displayCode(pairManager.getCurrentCode()!);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      // The output should contain the code
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('CLAW-');
      expect(output).toContain('Pair with OpenClaw Monitor');
    });
  });

  // --------------------------------------------------------------------------
  // onNewCode callback
  // --------------------------------------------------------------------------

  describe('onNewCode callback', () => {
    it('should invoke the callback when a code is generated', () => {
      const callback = vi.fn();
      const pm = new PairManager(callback);

      const code = pm.generateCode();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(code);

      pm.stopRotation();
    });

    it('should invoke the callback on each rotation', () => {
      vi.useFakeTimers();
      const callback = vi.fn();
      // Suppress console.log from displayCode during rotation
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const pm = new PairManager(callback);
      pm.startRotation();

      // Initial code generation during startRotation
      expect(callback).toHaveBeenCalledTimes(1);

      // Advance time by 5 minutes to trigger first rotation
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(callback).toHaveBeenCalledTimes(2);

      // Advance another 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(callback).toHaveBeenCalledTimes(3);

      pm.stopRotation();
    });
  });

  // --------------------------------------------------------------------------
  // Rotation
  // --------------------------------------------------------------------------

  describe('startRotation() / stopRotation()', () => {
    it('should generate a code immediately on startRotation', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      pairManager.startRotation();

      expect(pairManager.isCodeValid()).toBe(true);
      expect(pairManager.getCurrentCode()).toMatch(/^CLAW-[A-Z0-9]{4}$/);
    });

    it('should generate a new code every 5 minutes', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      pairManager.startRotation();
      const firstCode = pairManager.getCurrentCode();

      // Advance 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      const secondCode = pairManager.getCurrentCode();

      expect(secondCode).not.toBe(firstCode);
      expect(secondCode).toMatch(/^CLAW-[A-Z0-9]{4}$/);
    });

    it('should stop generating codes after stopRotation', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      pairManager.startRotation();
      const firstCode = pairManager.getCurrentCode();

      pairManager.stopRotation();

      // Advance 10 minutes -- no new code should be generated
      vi.advanceTimersByTime(10 * 60 * 1000);

      // The code should have expired (5 min TTL) and not been replaced
      expect(pairManager.isCodeValid()).toBe(false);
      expect(pairManager.getCurrentCode()).toBeNull();
    });

    it('should handle multiple start/stop cycles', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // First cycle
      pairManager.startRotation();
      expect(pairManager.isCodeValid()).toBe(true);
      pairManager.stopRotation();

      // Second cycle
      pairManager.startRotation();
      expect(pairManager.isCodeValid()).toBe(true);
      const code = pairManager.getCurrentCode();
      expect(code).toMatch(/^CLAW-[A-Z0-9]{4}$/);

      pairManager.stopRotation();
    });

    it('should reset the rotation timer when startRotation is called again', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      pairManager.startRotation();
      const code1 = pairManager.getCurrentCode();

      // Advance 3 minutes then restart rotation
      vi.advanceTimersByTime(3 * 60 * 1000);
      pairManager.startRotation();
      const code2 = pairManager.getCurrentCode();

      // A new code should have been generated
      expect(code2).not.toBe(code1);

      // The new code should be valid for the full 5 minutes from restart
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(pairManager.isCodeValid()).toBe(true);
    });
  });
});
