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
    // Wave 2 (B6) + F-134: the live endpoint always sends the exact bank
    // row's id AND its full prompt body (the tile previews the real text).
    promptId: 42,
    promptKr:
      '재택근무가 우리 생활에 주는 장점과 단점에 대해 200~300자로 쓰십시오.',
  },
  // Listening is the design's default emphasis; the live endpoint overrides
  // this with the user's weakest modality from their diagnostic snapshot.
  largestGap: 'Listening',
  // F-212 P4 — the evidence-driven "Recommended next" pick. The mock mirrors
  // the live envelope's happy path (a sufficient-estimate, weakest-dimension
  // pick) so the mock path renders the featured card; the live endpoint sends
  // `null` at cold-start instead (all dimensions insufficient), which renders
  // NO card — the fixture deliberately exercises the card-present branch.
  recommendation: {
    dimension: 'listening',
    exploratory: false,
    reasonCode: 'weakest_dimension',
    reasonEn: 'Listening is currently your weakest measured skill.',
    reasonKr: '현재 측정된 실력 중 듣기가 가장 약해요.',
    level: 'L3',
    deepLink: '/learn/listen?corpus=iyagi&episode=12',
    title: '이야기 #12 — 서울의 겨울',
    mins: 6,
    corpus: 'iyagi',
    episodeNumber: 12,
  },
};

/** Async loader — 60–120 ms simulated delay then resolves with the fixture. */
export async function loadTodayMock(): Promise<TodayPlan> {
  await mockDelay();
  return TODAY_FIXTURE;
}
