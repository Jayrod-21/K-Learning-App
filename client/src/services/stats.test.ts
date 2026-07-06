/**
 * stats service — the four-endpoint fan-out, `days` forwarding, signal
 * threading, and per-skill degradation on route failure (never a rejection,
 * never fabricated data). Fixtures carry the REAL wire metrics: topik
 * accuracy/%, vocab count/reviews, grammar score/pts, writing score/%
 * (F-014 — normalized percent-of-max).
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
  unit: 'reviews',
  points: [{ date: '2026-06-29', value: 35 }],
};
// Real wire shape for grammar is score/pts (never accuracy/%); empty points
// also keep the empty-series passthrough covered.
const GRAMMAR: SkillSeries = {
  metric: 'score',
  unit: 'pts',
  points: [],
};
// Real wire shape for writing (F-014) is score/% — per-day average grade
// normalized to percent-of-max, so Q53/30 and Q54/50 days are comparable.
const WRITING: SkillSeries = {
  metric: 'score',
  unit: '%',
  points: [
    { date: '2026-06-25', value: 66 },
    { date: '2026-06-29', value: 71 },
  ],
};

/** What a failed route must degrade to — the honest placeholder. */
const UNAVAILABLE: SkillSeries = { metric: 'none', unit: '', points: [] };

const TOPIK_RES: TopikSeriesResponse = { reading: READING, listening: LISTENING };
const VOCAB_RES: SingleSeriesResponse = { series: VOCAB };
const GRAMMAR_RES: SingleSeriesResponse = { series: GRAMMAR };
const WRITING_RES: SingleSeriesResponse = { series: WRITING };

const ALL_ROUTES = [
  '/topik/series',
  '/vocab/series',
  '/grammar/series',
  '/writing/series',
] as const;

/** The happy-path response for one series route. */
function responseFor(url: string): unknown {
  if (url === '/topik/series') return TOPIK_RES;
  if (url === '/vocab/series') return VOCAB_RES;
  if (url === '/grammar/series') return GRAMMAR_RES;
  if (url === '/writing/series') return WRITING_RES;
  throw new Error(`unexpected url: ${url}`);
}

/** api.get stub answering the four series routes; `failing` ones reject. */
function stubApiGet(failing: readonly string[] = []) {
  return vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (failing.includes(url)) {
      return Promise.reject(
        new ApiError('server error', { status: 500, code: 'server_error' }),
      );
    }
    try {
      return Promise.resolve(responseFor(url));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error('bad url'));
    }
  });
}

describe('fetchSkillSeries', () => {
  it('GETs all four series routes and assembles the five-skill result', async () => {
    const spy = stubApiGet();

    const all = await fetchSkillSeries();

    expect(spy).toHaveBeenCalledTimes(4);
    for (const url of ALL_ROUTES) {
      expect(spy).toHaveBeenCalledWith(url, { params: { days: 30 } });
    }

    expect(all.reading).toEqual(READING);
    expect(all.listening).toEqual(LISTENING);
    expect(all.vocab).toEqual(VOCAB);
    expect(all.grammar).toEqual(GRAMMAR);
    // Writing is the REAL wire series as of F-014 — never synthesized.
    expect(all.writing).toEqual(WRITING);
  });

  it('forwards a non-default days window to every route', async () => {
    const spy = stubApiGet();

    await fetchSkillSeries(7);

    for (const url of ALL_ROUTES) {
      expect(spy).toHaveBeenCalledWith(url, { params: { days: 7 } });
    }
  });

  it('threads one AbortSignal through to all four requests', async () => {
    const spy = stubApiGet();
    const ctrl = new AbortController();

    await fetchSkillSeries(30, ctrl.signal);

    for (const url of ALL_ROUTES) {
      expect(spy).toHaveBeenCalledWith(url, {
        params: { days: 30 },
        signal: ctrl.signal,
      });
    }
  });

  // ── Per-skill degradation (no fabricated data) ──────────────
  // A rejected route must NEVER reject the fan-out: rejection would trip
  // useEndpointOrMock's fallback and paint all five panels with fixture
  // numbers as if real. The failed skill degrades to the `metric: 'none'`
  // placeholder ("No data yet") while the others keep their real data.

  it('degrades only the failed skill to the placeholder; the rest stay real', async () => {
    stubApiGet(['/vocab/series']);

    const all = await fetchSkillSeries();

    expect(all.vocab).toEqual(UNAVAILABLE);
    expect(all.reading).toEqual(READING);
    expect(all.listening).toEqual(LISTENING);
    expect(all.grammar).toEqual(GRAMMAR);
    expect(all.writing).toEqual(WRITING);
  });

  it('degrades writing to the placeholder when /writing/series fails', async () => {
    stubApiGet(['/writing/series']);

    const all = await fetchSkillSeries();

    // Placeholder — NOT a fabricated score series and NOT a rejection.
    expect(all.writing).toEqual(UNAVAILABLE);
    expect(all.reading).toEqual(READING);
    expect(all.listening).toEqual(LISTENING);
    expect(all.vocab).toEqual(VOCAB);
    expect(all.grammar).toEqual(GRAMMAR);
  });

  it('degrades BOTH topik skills when the shared /topik/series route fails', async () => {
    stubApiGet(['/topik/series']);

    const all = await fetchSkillSeries();

    expect(all.reading).toEqual(UNAVAILABLE);
    expect(all.listening).toEqual(UNAVAILABLE);
    expect(all.vocab).toEqual(VOCAB);
    expect(all.grammar).toEqual(GRAMMAR);
    expect(all.writing).toEqual(WRITING);
  });

  it('resolves with all placeholders on a total outage (still never rejects)', async () => {
    stubApiGet([...ALL_ROUTES]);

    const all = await fetchSkillSeries();

    expect(all.reading).toEqual(UNAVAILABLE);
    expect(all.listening).toEqual(UNAVAILABLE);
    expect(all.vocab).toEqual(UNAVAILABLE);
    expect(all.grammar).toEqual(UNAVAILABLE);
    expect(all.writing).toEqual(UNAVAILABLE);

    // Fresh placeholder objects per call — one caller mutating a degraded
    // series must not leak into another caller's result.
    const again = await fetchSkillSeries();
    expect(again.writing).not.toBe(all.writing);
  });

  it('still rejects on cancellation — an abort is not "no data"', async () => {
    const ctrl = new AbortController();
    vi.spyOn(api, 'get').mockImplementation(() =>
      // Axios rejects in-flight requests when their signal aborts.
      Promise.reject(
        new ApiError('request canceled', { status: 0, code: 'canceled' }),
      ),
    );
    ctrl.abort();

    await expect(fetchSkillSeries(30, ctrl.signal)).rejects.toMatchObject({
      code: 'canceled',
    });
  });
});
