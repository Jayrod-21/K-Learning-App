/**
 * normalize — per-source outcome + difficulty-b mapping unit tests (F-212 P1).
 *
 * Pure — no DB, no clock. Each block pins one leg's raw-signal → normalized
 * mapping; the parity block pins that the ability layer scores difficulty
 * with THE diagnostic's proficiencyToNumber (one home for the locked
 * anchors), not a duplicated literal table.
 */
import { describe, expect, it } from 'vitest';
import { proficiencyToNumber as catProficiencyToNumber } from '../../../src/services/diagnostic/cat.js';
import {
  FSRS_RATING_OUTCOME,
  TOPIK_PAPER_ANCHORS,
  WRITING_RUBRIC_ANCHORS,
  proficiencyToNumber,
} from '../../../src/services/ability/anchors.js';
import {
  normalizeRow,
  type RawAbilityEvidenceRow,
} from '../../../src/services/ability/normalize.js';

/** A raw view row with every signal absent; tests override the leg's own. */
function rawRow(overrides: Partial<RawAbilityEvidenceRow>): RawAbilityEvidenceRow {
  return {
    user_id: '1',
    dimension: 'vocab',
    source: 'fsrs',
    source_id: '10',
    item_key: null,
    occurred_at: new Date('2026-08-01T09:00:00.000Z'),
    outcome_raw_correct: null,
    outcome_raw_rating: null,
    outcome_raw_score: null,
    outcome_raw_max: null,
    diff_served: null,
    diff_topik_paper: null,
    diff_proficiency: null,
    ...overrides,
  };
}

describe('normalizeRow — outcome per source', () => {
  it('topik: is_correct → 1 / 0', () => {
    const base = { source: 'topik', dimension: 'reading' } as const;
    expect(normalizeRow(rawRow({ ...base, outcome_raw_correct: true })).outcome).toBe(1);
    expect(normalizeRow(rawRow({ ...base, outcome_raw_correct: false })).outcome).toBe(0);
  });

  it('fsrs: again/hard/good/easy → 0 / 0.33 / 0.67 / 1.0', () => {
    expect(normalizeRow(rawRow({ outcome_raw_rating: 'again' })).outcome).toBe(0);
    expect(normalizeRow(rawRow({ outcome_raw_rating: 'hard' })).outcome).toBe(0.33);
    expect(normalizeRow(rawRow({ outcome_raw_rating: 'good' })).outcome).toBe(0.67);
    expect(normalizeRow(rawRow({ outcome_raw_rating: 'easy' })).outcome).toBe(1.0);
  });

  it('grammar_drill: score 73 of max 100 → 0.73', () => {
    const row = rawRow({
      source: 'grammar_drill',
      dimension: 'grammar',
      outcome_raw_score: 73,
      outcome_raw_max: 100,
    });
    expect(normalizeRow(row).outcome).toBeCloseTo(0.73);
  });

  it('writing: 42 of 50 → 0.84', () => {
    const row = rawRow({
      source: 'writing',
      dimension: 'writing',
      item_key: 'topik_ii_54',
      outcome_raw_score: 42,
      outcome_raw_max: 50,
    });
    expect(normalizeRow(row).outcome).toBeCloseTo(0.84);
  });

  it('hanja: the 4-way rating wins over the derived correct boolean', () => {
    // cardReview.ts derives correct = (rating !== 'again'); a 'hard' review
    // is therefore correct=true — but 'hard' is a WEAK pass, and the rating
    // is the richer signal, so the outcome is 0.33, not 1.
    const row = rawRow({
      source: 'hanja',
      outcome_raw_correct: true,
      outcome_raw_rating: 'hard',
    });
    expect(normalizeRow(row).outcome).toBe(0.33);
  });

  it('diagnostic: is_correct → 1 / 0 (a skip is graded false)', () => {
    const base = { source: 'diagnostic', dimension: 'listening' } as const;
    expect(normalizeRow(rawRow({ ...base, outcome_raw_correct: true })).outcome).toBe(1);
    expect(normalizeRow(rawRow({ ...base, outcome_raw_correct: false })).outcome).toBe(0);
  });

  it('guards max > 0 and clamps the ratio into [0, 1]', () => {
    // max = 0 is impossible under the DB CHECK — a row carrying it has no
    // usable outcome signal and must throw, not divide by zero.
    expect(() =>
      normalizeRow(rawRow({ outcome_raw_score: 5, outcome_raw_max: 0 })),
    ).toThrow(/no raw outcome signal/);
    expect(
      normalizeRow(rawRow({ outcome_raw_score: 120, outcome_raw_max: 100 })).outcome,
    ).toBe(1);
  });

  it('throws loudly on a row with NO raw outcome signal (view-contract drift)', () => {
    expect(() => normalizeRow(rawRow({}))).toThrow(/no raw outcome signal/);
  });
});

describe('normalizeRow — difficulty b per signal', () => {
  it('diff_served passes through on the 0–6 scale (diagnostic leg)', () => {
    const row = rawRow({
      source: 'diagnostic',
      outcome_raw_correct: true,
      diff_served: '3.50',
    });
    expect(normalizeRow(row).b).toBe(3.5);
  });

  it('diff_proficiency maps through proficiencyToNumber', () => {
    const base = { outcome_raw_rating: 'good' } as const;
    expect(normalizeRow(rawRow({ ...base, diff_proficiency: 'L1' })).b).toBe(1);
    expect(normalizeRow(rawRow({ ...base, diff_proficiency: 'L4' })).b).toBe(4);
    expect(normalizeRow(rawRow({ ...base, diff_proficiency: 'L5+' })).b).toBe(5.5);
  });

  it('diff_proficiency wins over the paper anchor (more specific signal)', () => {
    const row = rawRow({
      source: 'topik',
      outcome_raw_correct: true,
      diff_proficiency: 'L2',
      diff_topik_paper: 'TOPIK II',
    });
    expect(normalizeRow(row).b).toBe(2);
  });

  it('topik paper anchors: TOPIK I → 2, TOPIK II → 4 (untagged items)', () => {
    const base = { source: 'topik', outcome_raw_correct: true } as const;
    expect(normalizeRow(rawRow({ ...base, diff_topik_paper: 'TOPIK I' })).b).toBe(2);
    expect(normalizeRow(rawRow({ ...base, diff_topik_paper: 'TOPIK II' })).b).toBe(4);
  });

  it('writing rubric anchors: Q53 → 3.5, Q54 → 5 (prompt-less attempts)', () => {
    const base = {
      source: 'writing',
      dimension: 'writing',
      outcome_raw_score: 20,
      outcome_raw_max: 30,
    } as const;
    expect(normalizeRow(rawRow({ ...base, item_key: 'topik_ii_53' })).b).toBe(3.5);
    expect(normalizeRow(rawRow({ ...base, item_key: 'topik_ii_54' })).b).toBe(5.0);
    // free_write (056) has no anchor — difficulty genuinely unknown.
    expect(normalizeRow(rawRow({ ...base, item_key: 'free_write' })).b).toBeNull();
  });

  it('grammar_drill: no difficulty signal → b = null', () => {
    const row = rawRow({
      source: 'grammar_drill',
      dimension: 'grammar',
      item_key: 'GR-eo-yo',
      outcome_raw_score: 73,
      outcome_raw_max: 100,
    });
    expect(normalizeRow(row).b).toBeNull();
  });
});

describe('normalizeRow — shape', () => {
  it('carries ids as strings, the timestamp as ISO-8601, and the key/dims verbatim', () => {
    const row = normalizeRow(
      rawRow({
        user_id: '7',
        source_id: '42',
        source: 'topik',
        dimension: 'reading',
        item_key: '99',
        outcome_raw_correct: true,
        occurred_at: new Date('2026-08-01T09:00:00.000Z'),
      }),
    );
    expect(row).toEqual({
      userId: '7',
      dimension: 'reading',
      source: 'topik',
      sourceId: '42',
      itemKey: '99',
      outcome: 1,
      b: null,
      occurredAt: '2026-08-01T09:00:00.000Z',
    });
  });
});

describe('anchor parity — one home for the locked constants', () => {
  it('re-exports THE diagnostic proficiencyToNumber (same function object)', () => {
    // The parity contract: the ability layer must not duplicate the L1=1 …
    // L5+=5.5 literal table. Identity (not just value) equality proves the
    // re-export — a copy-paste would fail this even with matching values.
    expect(proficiencyToNumber).toBe(catProficiencyToNumber);
  });

  it('locks the anchor tables', () => {
    expect(TOPIK_PAPER_ANCHORS).toEqual({ 'TOPIK I': 2.0, 'TOPIK II': 4.0 });
    expect(WRITING_RUBRIC_ANCHORS).toEqual({ topik_ii_53: 3.5, topik_ii_54: 5.0 });
    expect(FSRS_RATING_OUTCOME).toEqual({ again: 0, hard: 0.33, good: 0.67, easy: 1.0 });
  });
});
