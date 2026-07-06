/**
 * Skill-series fixture + loader (F-017 — Today's "Progress by skill").
 *
 * Mock-fallback for `fetchSkillSeries` (the `/topik|/vocab|/grammar /series`
 * fan-out). Shapes mirror the wire contract exactly: ascending `YYYY-MM-DD`
 * dates, activity days only (gaps are absent, not zero-filled), accuracy in
 * 0–100 with `unit: '%'`, vocab as a daily review count. `writing` is the
 * client-only `metric: 'none'` sentinel — no series route exists for it, so
 * the carousel shows its placeholder panel.
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
    unit: 'cards',
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
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-10', value: 39 },
      { date: '2026-06-14', value: 45 },
      { date: '2026-06-18', value: 43 },
      { date: '2026-06-22', value: 50 },
      { date: '2026-06-26', value: 54 },
      { date: '2026-06-30', value: 52 },
    ],
  },
  // No /writing/series route — the client-only sentinel (placeholder panel).
  writing: { metric: 'none', unit: '', points: [] },
};

/** Mock loader — the `useEndpointOrMock` fallback for `fetchSkillSeries`. */
export async function loadSkillSeriesMock(): Promise<AllSkillSeries> {
  await mockDelay();
  return SKILL_SERIES_FIXTURE;
}
