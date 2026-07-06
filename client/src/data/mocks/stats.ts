/**
 * Skill-series fixture + loader (F-017 — Today's "Progress by skill").
 *
 * Mock-fallback for `fetchSkillSeries` (the `/topik|/vocab|/grammar|/writing
 * /series` fan-out). Shapes mirror the wire contract exactly: ascending
 * `YYYY-MM-DD` dates, activity days only (gaps are absent, not zero-filled),
 * TOPIK accuracy in 0–100 with `unit: '%'`, vocab as a daily review COUNT
 * with `unit: 'reviews'`, grammar as a daily average drill SCORE with
 * `unit: 'pts'`, and writing (F-014) as a daily average grade SCORE
 * normalized to percent-of-max with `unit: '%'` (so Q53/30 and Q54/50 days
 * are comparable — the real routes' metrics; grammar/writing are `score`,
 * never `accuracy`).
 */
import type { AllSkillSeries } from '../../types/domain';
import { mockDelay } from './_delay';

export const SKILL_SERIES_FIXTURE: AllSkillSeries = {
  reading: {
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-08', value: 58 },
      { date: '2026-06-10', value: 61 },
      { date: '2026-06-13', value: 57 },
      { date: '2026-06-15', value: 66 },
      { date: '2026-06-18', value: 64 },
      { date: '2026-06-21', value: 70 },
      { date: '2026-06-24', value: 68 },
      { date: '2026-06-27', value: 73 },
      { date: '2026-06-30', value: 74 },
    ],
  },
  listening: {
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-09', value: 42 },
      { date: '2026-06-12', value: 47 },
      { date: '2026-06-16', value: 44 },
      { date: '2026-06-19', value: 51 },
      { date: '2026-06-23', value: 55 },
      { date: '2026-06-26', value: 53 },
      { date: '2026-06-30', value: 58 },
    ],
  },
  vocab: {
    metric: 'count',
    unit: 'reviews',
    points: [
      { date: '2026-06-08', value: 12 },
      { date: '2026-06-09', value: 20 },
      { date: '2026-06-11', value: 16 },
      { date: '2026-06-14', value: 25 },
      { date: '2026-06-17', value: 18 },
      { date: '2026-06-20', value: 31 },
      { date: '2026-06-23', value: 24 },
      { date: '2026-06-26', value: 28 },
      { date: '2026-06-29', value: 35 },
    ],
  },
  grammar: {
    metric: 'score',
    unit: 'pts',
    points: [
      { date: '2026-06-10', value: 39 },
      { date: '2026-06-14', value: 45 },
      { date: '2026-06-18', value: 43 },
      { date: '2026-06-22', value: 50 },
      { date: '2026-06-26', value: 54 },
      { date: '2026-06-30', value: 52 },
    ],
  },
  // Real /writing/series wire shape (F-014): per-day average grade score
  // normalized to percent-of-max. Sparser than the other skills — grading an
  // essay costs a Claude call, so writing days are rarer than review days.
  writing: {
    metric: 'score',
    unit: '%',
    points: [
      { date: '2026-06-11', value: 57 },
      { date: '2026-06-16', value: 60 },
      { date: '2026-06-21', value: 55 },
      { date: '2026-06-25', value: 66 },
      { date: '2026-06-29', value: 71 },
    ],
  },
};

/** Mock loader — the `useEndpointOrMock` fallback for `fetchSkillSeries`. */
export async function loadSkillSeriesMock(): Promise<AllSkillSeries> {
  await mockDelay();
  return SKILL_SERIES_FIXTURE;
}
