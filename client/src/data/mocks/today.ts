/**
 * Today screen fixture + loader. Mirrors `TODAY` in data.js.
 *
 * Real wiring (Pass 4): `services/plan.ts` `fetchToday()` returns this shape
 * from `GET /plan/today`.
 */
import type { TodayPlan } from '../../types/domain';
import { mockDelay } from './_delay';

export const TODAY_FIXTURE: TodayPlan = {
  reviewCount: 24,
  reading: {
    title: '도시화와 환경',
    mins: 3,
    level: 'L4',
    tag: 'Reading',
  },
  listening: {
    title: 'KBS — 재택근무 확산',
    mins: 4,
    level: 'L3→L4',
    tag: 'Listening',
  },
  writing: {
    title: 'Paragraph in 합쇼체 — defend remote work',
    mins: 8,
    level: 'L4',
    tag: 'Writing',
  },
  // Listening is the design's default emphasis; the live endpoint overrides
  // this with the user's weakest modality from their diagnostic snapshot.
  largestGap: 'Listening',
};

/** Async loader — 60–120 ms simulated delay then resolves with the fixture. */
export async function loadTodayMock(): Promise<TodayPlan> {
  await mockDelay();
  return TODAY_FIXTURE;
}
