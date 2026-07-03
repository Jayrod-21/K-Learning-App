/**
 * grammarScheduler — verdict→rating mapping unit tests (FU-NF-42, contract A5).
 *
 * The state-transition math moved to the shared engine (services/fsrs.ts,
 * tested in fsrs.test.ts); this file pins the grammar-drill-specific half:
 * the Claude verdict → FSRS rating mapping, including the usesPattern=false
 * override. Pure — no DB, no clock.
 */
import { describe, expect, it } from 'vitest';
import { ratingFromVerdict } from '../../src/services/grammarScheduler';

describe('ratingFromVerdict', () => {
  it('maps each verdict to its rating when the pattern is used', () => {
    expect(ratingFromVerdict('incorrect', true)).toBe('again');
    expect(ratingFromVerdict('needs_work', true)).toBe('hard');
    expect(ratingFromVerdict('good', true)).toBe('good');
    expect(ratingFromVerdict('excellent', true)).toBe('easy');
  });

  it('forces "again" when the target pattern was NOT used, regardless of verdict', () => {
    // The headline override: fluency does not count if the drilled pattern is absent.
    expect(ratingFromVerdict('excellent', false)).toBe('again');
    expect(ratingFromVerdict('good', false)).toBe('again');
    expect(ratingFromVerdict('needs_work', false)).toBe('again');
    expect(ratingFromVerdict('incorrect', false)).toBe('again');
  });
});
