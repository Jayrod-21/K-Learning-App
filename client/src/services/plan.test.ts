/**
 * plan service — URL construction, server→domain mapping, signal threading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchToday, type PlanTodayResponse } from './plan';
import { api, ApiError } from './api';
import type { Recommendation } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

/** F-212 P4 — a server-shaped recommendation (weakest-dimension pick). */
const RECOMMENDATION: Recommendation = {
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
};

const SERVER: PlanTodayResponse = {
  dueCount: 24,
  reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
  listening: { title: 'KBS — 재택근무', mins: 4, level: 'L3→L4', tag: 'Listening' },
  writing: { title: 'Paragraph in 합쇼체', mins: 8, level: 'L4', tag: 'Writing' },
  largestGap: 'Listening',
  recommendation: RECOMMENDATION,
};

describe('fetchToday', () => {
  it('GETs /plan/today and maps dueCount → reviewCount', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(SERVER);

    const plan = await fetchToday();

    expect(spy).toHaveBeenCalledWith('/plan/today', undefined);
    expect(plan.reviewCount).toBe(24);
    expect(plan.reading?.title).toBe('도시화와 환경');
    expect(plan.listening?.tag).toBe('Listening');
    expect(plan.writing?.mins).toBe(8);
    expect(plan.largestGap).toBe('Listening');
  });

  it('passes an AbortSignal through to the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(SERVER);
    const ctrl = new AbortController();

    await fetchToday(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/plan/today', { signal: ctrl.signal });
  });

  it('preserves null tasks (empty corpus) and null largestGap', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      ...SERVER,
      reading: null,
      largestGap: null,
    } satisfies PlanTodayResponse);

    const plan = await fetchToday();

    expect(plan.reading).toBeNull();
    expect(plan.listening).not.toBeNull();
    expect(plan.largestGap).toBeNull();
  });

  // ── F-212 P4 — recommendation mapping ──────────────────────────

  it('maps the recommendation through untouched, including its deep-link id fields', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce(SERVER);

    const plan = await fetchToday();

    expect(plan.recommendation).toEqual(RECOMMENDATION);
  });

  it('maps alternatives through only when the server sends them', async () => {
    const alt: Recommendation = {
      ...RECOMMENDATION,
      dimension: 'vocab',
      reasonCode: 'due_backlog',
      reasonEn: 'You have vocabulary reviews piling up.',
      reasonKr: '밀린 어휘 복습이 있어요.',
      deepLink: '/learn/vocab?study=due',
      title: 'Due vocabulary review',
      mins: 5,
    };
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      ...SERVER,
      alternatives: [alt],
    } satisfies PlanTodayResponse);

    const plan = await fetchToday();

    expect(plan.alternatives).toEqual([alt]);
  });

  it('normalizes an explicit null recommendation (cold-start) to null', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      ...SERVER,
      recommendation: null,
    } satisfies PlanTodayResponse);

    const plan = await fetchToday();

    expect(plan.recommendation).toBeNull();
  });

  it('normalizes an ABSENT recommendation field (older server color, blue/green skew) to null with no alternatives key', async () => {
    const legacy: PlanTodayResponse = { ...SERVER };
    delete legacy.recommendation;
    vi.spyOn(api, 'get').mockResolvedValueOnce(legacy);

    const plan = await fetchToday();

    expect(plan.recommendation).toBeNull();
    // No fabricated empty-array stand-in either — the key is simply absent.
    expect('alternatives' in plan).toBe(false);
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );

    await expect(fetchToday()).rejects.toMatchObject({ status: 500 });
  });
});
