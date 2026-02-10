// ============================================================================
// OpenClaw Monitor - Model Name Normalizer
// Strips vendor prefixes, date suffixes, and platform-specific formatting
// from model names so they match the canonical pricing table keys.
// Ported from CodexBar's CostUsagePricing.swift normalizeCodexModel() and
// normalizeClaudeModel() functions.
// ============================================================================

// Set of canonical Claude model keys that we allow date-suffix stripping for.
// If stripping the date suffix yields a key in this set, we use the base name.
// This prevents accidental stripping on unknown models.
const KNOWN_CLAUDE_BASES = new Set([
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4-20250514',
  'claude-opus-4-1',
  'claude-sonnet-4-20250514',
  'claude-opus-4-6',
]);

// Set of canonical Codex model keys for -codex suffix stripping.
const KNOWN_CODEX_BASES = new Set([
  'gpt-5',
  'gpt-5.1',
  'gpt-5.2',
]);

/**
 * Normalize a Codex/OpenAI model name for pricing lookup.
 *
 * Strips:
 * - "openai/" vendor prefix (e.g. "openai/gpt-5" -> "gpt-5")
 * - "-codex" suffix when the base name is a known model
 *   (e.g. "gpt-5-codex" -> "gpt-5", but "gpt-5.2-codex" -> "gpt-5.2")
 *
 * @param raw - Raw model name from the API response or log entry
 * @returns Normalized model name suitable for pricing table lookup
 */
export function normalizeCodexModel(raw: string): string {
  let trimmed = raw.trim();

  // Strip "openai/" vendor prefix
  if (trimmed.startsWith('openai/')) {
    trimmed = trimmed.slice('openai/'.length);
  }

  // Strip "-codex" suffix if the base name is a known model
  const codexIdx = trimmed.indexOf('-codex');
  if (codexIdx !== -1) {
    const base = trimmed.slice(0, codexIdx);
    if (KNOWN_CODEX_BASES.has(base)) {
      return base;
    }
  }

  return trimmed;
}

/**
 * Normalize a Claude/Anthropic model name for pricing lookup.
 *
 * Strips:
 * - "anthropic." vendor prefix (e.g. "anthropic.claude-sonnet-4-5" -> "claude-sonnet-4-5")
 * - Vertex AI nested prefix where the model is after a dot
 *   (e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5-20250929")
 * - Vertex AI "@version" suffix (e.g. "claude-opus-4-5@20251101" -> "claude-opus-4-5-20251101")
 * - "-vN:M" version suffix (e.g. "claude-sonnet-4-5-v1:0" -> "claude-sonnet-4-5")
 * - "-YYYYMMDD" date suffix when the base name is a known model
 *
 * @param raw - Raw model name from the API response or log entry
 * @returns Normalized model name suitable for pricing table lookup
 */
export function normalizeClaudeModel(raw: string): string {
  let trimmed = raw.trim();

  // Strip "anthropic." vendor prefix
  if (trimmed.startsWith('anthropic.')) {
    trimmed = trimmed.slice('anthropic.'.length);
  }

  // Handle Vertex AI nested prefixes: extract the last segment starting with "claude-"
  // e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5-20250929-v1:0"
  if (trimmed.includes('claude-')) {
    const lastDotIdx = trimmed.lastIndexOf('.');
    if (lastDotIdx !== -1) {
      const tail = trimmed.slice(lastDotIdx + 1);
      if (tail.startsWith('claude-')) {
        trimmed = tail;
      }
    }
  }

  // Strip Vertex AI "-vN:M" version suffix (e.g. "-v1:0", "-v2:1")
  const versionMatch = trimmed.match(/-v\d+:\d+$/);
  if (versionMatch) {
    trimmed = trimmed.slice(0, -versionMatch[0].length);
  }

  // Strip Vertex AI "@version" suffix and convert to dash format
  // e.g. "claude-opus-4-5@20251101" -> "claude-opus-4-5-20251101"
  if (trimmed.includes('@')) {
    trimmed = trimmed.replace('@', '-');
  }

  // Strip "-YYYYMMDD" date suffix if the base name is a known model
  const dateMatch = trimmed.match(/-\d{8}$/);
  if (dateMatch) {
    const base = trimmed.slice(0, -dateMatch[0].length);
    if (KNOWN_CLAUDE_BASES.has(base)) {
      return base;
    }
  }

  return trimmed;
}
