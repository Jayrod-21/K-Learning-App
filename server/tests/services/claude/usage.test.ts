/**
 * Cost / usage tests.
 *
 * The cost formula was wrong before the B4 fix-pass: it subtracted
 * cachedInputTokens from inputTokens before applying the input rate,
 * double-discounting cached reads (Anthropic's `input_tokens` already
 * excludes cached reads). It also ignored cache_creation_input_tokens
 * (cache writes were silently free in the cost report).
 *
 * The current formula trusts each token field as Anthropic reports it
 * and multiplies by its own rate. See FIX_REPORT_B.md §B4-S1.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryUsageStore,
  computeCostUsd,
} from '../../../src/services/claude/usage';

describe('computeCostUsd', () => {
  it('computes haiku 4.5 rate correctly (no cache)', () => {
    // 1M input @ $1/M, 0 cached read, 0 cache create, 1M output @ $5/M = 1 + 5 = 6
    const cost = computeCostUsd('claude-haiku-4-5', 1_000_000, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 6);
  });

  it('cached input tokens are billed at the cached rate (NOT subtracted from input)', () => {
    // Haiku: input $1/M, cached $0.10/M.
    // Anthropic reports `input_tokens` as ALREADY non-cached; cached reads
    // are a separate field. The old (broken) formula subtracted cached
    // from input — that would double-discount. The current formula must
    // add their respective contributions independently.
    // 500k non-cached input + 500k cached read + 0 output
    //   = 500_000/1M * 1.0 + 500_000/1M * 0.10
    //   = 0.5 + 0.05 = 0.55
    const cost = computeCostUsd('claude-haiku-4-5', 500_000, 500_000, 0, 0);
    expect(cost).toBeCloseTo(0.55, 6);
  });

  it('cache-creation tokens are billed at 1.25x input', () => {
    // Sonnet: input $3/M; cache_create = $3 * 1.25 = $3.75/M.
    // 200k cache_creation only.
    const cost = computeCostUsd('claude-sonnet-4-6', 0, 0, 200_000, 0);
    expect(cost).toBeCloseTo((200_000 * 3.75) / 1_000_000, 6);
  });

  it('full call: input + cached read + cache write + output sums correctly', () => {
    // Sonnet rates: input 3, cachedInput 0.3, cacheCreation 3.75, output 15.
    // 100k input, 200k cached, 50k cache_create, 80k output.
    const cost = computeCostUsd('claude-sonnet-4-6', 100_000, 200_000, 50_000, 80_000);
    const expected =
      (100_000 * 3 +
        200_000 * 0.3 +
        50_000 * 3.75 +
        80_000 * 15) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('computes sonnet 4.6 rate correctly (no cache)', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', 1_000_000, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it('computes opus 4.7 rate correctly (~5x sonnet, no cache)', () => {
    const cost = computeCostUsd('claude-opus-4-7', 1_000_000, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(15 + 75, 6);
  });

  it('returns 0 for an all-zero call', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', 0, 0, 0, 0);
    expect(cost).toBe(0);
  });

  it('clamps negative cost to zero (safety against weird SDK outputs)', () => {
    // Anthropic should never report negative tokens, but if it ever does we
    // clamp rather than poison the cost table.
    const cost = computeCostUsd('claude-sonnet-4-6', -1000, 0, 0, 0);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe('InMemoryUsageStore', () => {
  it('records a call with computed cost', async () => {
    const store = new InMemoryUsageStore();
    await store.record({
      requestId: 'req-1',
      userId: 1,
      route: 'enrich',
      model: 'claude-haiku-4-5',
      wasCacheHit: false,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      latencyMs: 100,
    });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.costEstimateUsd).toBeCloseTo(6, 6);
  });

  it('records a cache hit with zero cost', async () => {
    const store = new InMemoryUsageStore();
    await store.record({
      requestId: 'req-2',
      userId: 1,
      route: 'enrich',
      model: 'claude-haiku-4-5',
      wasCacheHit: true,
      inputTokens: 1_000_000, // ignored for cache hits
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      latencyMs: 1,
    });
    expect(store.records[0]!.costEstimateUsd).toBe(0);
  });
});
