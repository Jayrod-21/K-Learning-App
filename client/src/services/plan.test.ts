/**
 * plan service — URL construction, server→domain mapping, signal threading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchToday, type PlanTodayResponse } from './plan';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const SERVER: PlanTodayResponse = {
  dueCount: 24,
  reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
  listening: { title: 'KBS — 재택근무', mins: 4, level: 'L3→L4', tag: 'Listening' },
  writing: { title: 'Paragraph in 합쇼체', mins: 8, level: 'L4', tag: 'Writing' },
  largestGap: 'Listening',
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

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );

    await expect(fetchToday()).rejects.toMatchObject({ status: 500 });
  });
});
