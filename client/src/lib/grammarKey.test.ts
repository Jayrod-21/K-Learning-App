/**
 * grammarKey — always emits a server-valid GR- key (F2).
 *
 * Moved from pages/Reference.test.tsx when the Reference page dissolved
 * (Overhaul P1.2) — these are pure lib tests and belong next to the lib.
 * The server's BankBodySchema requires /^GR-[a-z0-9_-]{1,64}$/; a raw
 * source_id ("KGIU-INT-009") or Korean pattern would be rejected with a 400.
 */
import { describe, expect, it } from 'vitest';
import { grammarKey } from './grammarKey';
import type { KgiuEntrySummary } from '../types/domain';

const GR_KEY = /^GR-[a-z0-9_-]{1,64}$/;

const base: Omit<KgiuEntrySummary, 'id' | 'source_id' | 'pattern'> = {
  corpus: 'kgiu_intermediate',
  title_en: null,
  category: null,
  proficiency: null,
  unit: null,
  source_pages: null,
};

const make = (
  over: Partial<KgiuEntrySummary> & Pick<KgiuEntrySummary, 'id'>,
): KgiuEntrySummary => ({
  source_id: null,
  pattern: '-는 반면에',
  ...base,
  ...over,
});

describe('grammarKey — always emits a server-valid GR- key (F2)', () => {
  it('slugifies an ASCII source_id to the allowed alphabet', () => {
    const key = grammarKey(make({ id: 100, source_id: 'KGIU-INT-009' }));
    expect(key).toBe('GR-kgiu-int-009');
    expect(key).toMatch(GR_KEY);
  });

  it('falls back to kgiu-${id} when source_id is null', () => {
    const key = grammarKey(make({ id: 42, source_id: null }));
    expect(key).toBe('GR-kgiu-42');
    expect(key).toMatch(GR_KEY);
  });

  it('falls back to kgiu-${id} when source_id slugs to empty (all-Korean)', () => {
    // A Korean source_id has no [a-z0-9_-] chars → slug collapses to '' →
    // kgiu-${id} fallback rather than an invalid `GR-` key.
    const key = grammarKey(make({ id: 7, source_id: '한국어' }));
    expect(key).toBe('GR-kgiu-7');
    expect(key).toMatch(GR_KEY);
  });

  it('a Korean pattern never leaks into the key', () => {
    const key = grammarKey(make({ id: 3, source_id: null, pattern: '-(으)면' }));
    expect(key).toMatch(GR_KEY);
    expect(key).not.toContain('(');
    expect(key).not.toContain('으');
  });

  it('truncates an over-long slug to 64 chars (after the GR- prefix)', () => {
    const longId = 'a'.repeat(200);
    const key = grammarKey(make({ id: 9, source_id: longId }));
    expect(key.startsWith('GR-')).toBe(true);
    expect(key.slice(3).length).toBe(64);
    expect(key).toMatch(GR_KEY);
  });

  it('collapses runs of disallowed chars and trims edges', () => {
    const key = grammarKey(make({ id: 1, source_id: '--A  B__C!!--' }));
    // lowercase, collapse non-alnum runs to single '-', trim edges; '_' kept.
    expect(key).toBe('GR-a-b__c');
    expect(key).toMatch(GR_KEY);
  });
});
