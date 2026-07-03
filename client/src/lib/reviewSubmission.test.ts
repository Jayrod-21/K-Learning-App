/**
 * buildReviewSubmission — the wire-payload contract for
 * `POST /vocab/cards/:id/reviews`.
 *
 * Server-authoritative scheduling: this is the regression pin for the old
 * Pass-3 stub that hardcoded `scheduled_days_after: 0` (making every rated
 * card come straight back as due). The payload must carry the rating + the
 * optimistic-concurrency version snapshot and NOTHING scheduling-related —
 * the server owns the FSRS transition and `due_at`.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewSubmission } from './reviewSubmission';
import type { DueCard } from '../types/domain';

const CARD: DueCard = {
  id: 101,
  face: '영향',
  due_at: '2026-07-01T00:00:00Z',
  stability: '0',
  difficulty: '5',
  fsrs_state: 'new',
  vocab_entry_id: 1,
  grammar_entry_id: null,
  source_sentence_id: null,
  topik_item_id: null,
  version: 1,
};

describe('buildReviewSubmission', () => {
  it('sends only the rating + expected_version (server owns the interval)', () => {
    const sub = buildReviewSubmission(CARD, 'good');
    expect(sub).toEqual({ rating: 'good', expected_version: 1 });
    // Exhaustive key check — a reintroduced client-side scheduling field
    // (state_after, scheduled_days_after, …) must fail this test.
    expect(Object.keys(sub).sort()).toEqual(['expected_version', 'rating']);
  });

  it('no longer sends the hardcoded scheduled_days_after: 0 stub', () => {
    const sub = buildReviewSubmission(CARD, 'again');
    expect(sub).not.toHaveProperty('scheduled_days_after');
    expect(sub).not.toHaveProperty('state_after');
    expect(sub).not.toHaveProperty('stability_after');
    expect(sub).not.toHaveProperty('difficulty_after');
  });

  it('threads the per-card version snapshot into expected_version', () => {
    const v7: DueCard = { ...CARD, version: 7 };
    expect(buildReviewSubmission(v7, 'easy').expected_version).toBe(7);
    expect(buildReviewSubmission(v7, 'easy').rating).toBe('easy');
  });
});
