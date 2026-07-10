/**
 * Token-bucket rate limiter tests.
 */

import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../../../src/services/claude/rate_limit';
import { ClaudeRateLimitError } from '../../../src/services/claude/errors';

const limits = {
  enrich: 6,
  recognize_grammar: 3,
  grade_writing: 1,
  diagnostic_item: 2,
  image_ocr: 2,
  generate_conversation: 2,
  generate_grammar_drill: 2,
  score_grammar_drill: 2,
  generate_writing_prompt: 2,
  generate_story: 2,
} as const;

describe('TokenBucketLimiter', () => {
  it('allows up to capacity in burst', () => {
    const t0 = 1_000_000_000;
    const limiter = new TokenBucketLimiter(limits, () => t0);
    for (let i = 0; i < 6; i += 1) limiter.consume('enrich', 'u1');
    expect(() => limiter.consume('enrich', 'u1')).toThrow(ClaudeRateLimitError);
  });

  it('refills over time', () => {
    let now = 1_000_000_000;
    const limiter = new TokenBucketLimiter(limits, () => now);
    for (let i = 0; i < 6; i += 1) limiter.consume('enrich', 'u1');
    expect(() => limiter.consume('enrich', 'u1')).toThrow(ClaudeRateLimitError);
    // 10 seconds → enrich rate = 6/60 = 0.1/s → +1 token in 10s.
    now += 10_000;
    expect(() => limiter.consume('enrich', 'u1')).not.toThrow();
  });

  it('isolates buckets by user', () => {
    const limiter = new TokenBucketLimiter(limits, () => 1_000_000_000);
    for (let i = 0; i < 6; i += 1) limiter.consume('enrich', 'u1');
    expect(() => limiter.consume('enrich', 'u2')).not.toThrow();
  });

  it('isolates buckets by route', () => {
    const limiter = new TokenBucketLimiter(limits, () => 1_000_000_000);
    limiter.consume('grade_writing', 'u1');
    expect(() => limiter.consume('grade_writing', 'u1')).toThrow(ClaudeRateLimitError);
    expect(() => limiter.consume('enrich', 'u1')).not.toThrow();
  });
});
