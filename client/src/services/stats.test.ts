/**
 * stats service — the three-endpoint fan-out, `days` forwarding, signal
 * threading, the synthesized `writing` sentinel, and all-or-nothing failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSkillSeries } from './stats';
import type { SingleSeriesResponse, TopikSeriesResponse } from './stats';
import { api, ApiError } from './api';
import type { SkillSeries } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

const READING: SkillSeries = {
  metric: 'accuracy',
  unit: '%',
  points: [
    { date: '2026-06-08', value: 58 },
    { date: '2026-06-30', value: 74 },
  ],
};
const LISTENING: SkillSeries = {
  metric: 'accuracy',
  unit: '%',
  points: [{ date: '2026-06-30', value: 51 }],
};
const VOCAB: SkillSeries = {
  metric: 'count',
  unit: 'cards',
  points: [{ date: '2026-06-29', value: 35 }],
};
const GRAMMAR: SkillSeries = {
  metric: 'accuracy',
  unit: '%',
  points: [],
};

const TOPIK_RES: TopikSeriesResponse = { reading: READING, listening: LISTENING };
const VOCAB_RES: SingleSeriesResponse = { series: VOCAB };
const GRAMMAR_RES: SingleSeriesResponse = { series: GRAMMAR };

/** api.get stub that answers each of the three series routes. */
function stubApiGet() {
  return vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/topik/series') return Promise.resolve(TOPIK_RES);
    if (url === '/vocab/series') return Promise.resolve(VOCAB_RES);
    if (url === '/grammar/series') return Promise.resolve(GRAMMAR_RES);
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
}

describe('fetchSkillSeries', () => {
  it('GETs all three series routes and assembles the five-skill result', async () => {
    const spy = stubApiGet();

    const all = await fetchSkillSeries();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith('/topik/series', { params: { days: 30 } });
    expect(spy).toHaveBeenCalledWith('/vocab/series', { params: { days: 30 } });
    expect(spy).toHaveBeenCalledWith('/grammar/series', { params: { days: 30 } });

    expect(all.reading).toEqual(READING);
    expect(all.listening).toEqual(LISTENING);
    expect(all.vocab).toEqual(VOCAB);
    expect(all.grammar).toEqual(GRAMMAR);
  });

  it('synthesizes the client-only empty writing series (no route)', async () => {
    stubApiGet();

    const all = await fetchSkillSeries();

    expect(all.writing).toEqual({ metric: 'none', unit: '', points: [] });

    // Fresh object per call — one caller mutating it must not leak to another.
    const again = await fetchSkillSeries();
    expect(again.writing).not.toBe(all.writing);
  });

  it('forwards a non-default days window to every route', async () => {
    const spy = stubApiGet();

    await fetchSkillSeries(7);

    expect(spy).toHaveBeenCalledWith('/topik/series', { params: { days: 7 } });
    expect(spy).toHaveBeenCalledWith('/vocab/series', { params: { days: 7 } });
    expect(spy).toHaveBeenCalledWith('/grammar/series', { params: { days: 7 } });
  });

  it('threads one AbortSignal through to all three requests', async () => {
    const spy = stubApiGet();
    const ctrl = new AbortController();

    await fetchSkillSeries(30, ctrl.signal);

    for (const url of ['/topik/series', '/vocab/series', '/grammar/series']) {
      expect(spy).toHaveBeenCalledWith(url, {
        params: { days: 30 },
        signal: ctrl.signal,
      });
    }
  });

  it('rejects the whole fan-out when any one route fails (all-or-nothing)', async () => {
    vi.spyOn(api, 'get').mockImplementation((url: string) =>
      url === '/vocab/series'
        ? Promise.reject(
            new ApiError('server error', { status: 500, code: 'server_error' }),
          )
        : Promise.resolve(url === '/topik/series' ? TOPIK_RES : GRAMMAR_RES),
    );

    await expect(fetchSkillSeries()).rejects.toMatchObject({ status: 500 });
  });
});
