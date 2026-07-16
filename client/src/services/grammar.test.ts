/**
 * grammar service — KGIU + bank + identify URL/body wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bankPattern,
  fetchGrammarMastery,
  fetchGrammarSavedFromUploads,
  getPattern,
  identifyPattern,
  listBanked,
  listPatterns,
} from './grammar';
import { api, ApiError } from './api';
import type { BankGrammarBody } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listPatterns', () => {
  it('GETs /grammar/kgiu and unwraps entries', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [{ id: 1, corpus: 'x', source_id: null, pattern: '은/는', title_en: null, category: null, proficiency: null, unit: null, source_pages: null }],
    });

    const out = await listPatterns({ q: '은' });

    expect(spy).toHaveBeenCalledWith('/grammar/kgiu', { params: { q: '은' } });
    expect(out).toHaveLength(1);
  });

  it('omits undefined opts entirely', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ entries: [] });

    await listPatterns();

    expect(spy).toHaveBeenCalledWith('/grammar/kgiu', { params: {} });
  });

  it('coerces the BIGINT string id off the wire to the declared number', async () => {
    // The list route returns rows raw — pg serialises BIGINT `id` as a JSON
    // STRING; sibling routes Number() it. Without boundary coercion a strict
    // `===` against a converted detail id silently never matches.
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [{ id: '12', corpus: 'x', source_id: null, pattern: '은/는', title_en: null, category: null, proficiency: null, unit: null, source_pages: null }],
    });

    const out = await listPatterns();

    expect(out[0]?.id).toBe(12);
    expect(typeof out[0]?.id).toBe('number');
  });
});

describe('getPattern', () => {
  it('GETs /grammar/kgiu/:id', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ id: 99 });

    await getPattern(99);

    expect(spy).toHaveBeenCalledWith('/grammar/kgiu/99', undefined);
  });
});

describe('bankPattern', () => {
  it('POSTs /grammar/bank with the body', async () => {
    const body: BankGrammarBody = {
      pattern_key: 'GR-eun-neun',
      pattern_display: '은/는',
      summary_en: 'topic marker',
      proficiency: 'basic',
      category: 'particle',
    };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ id: 5 });

    const out = await bankPattern(body);

    expect(spy).toHaveBeenCalledWith('/grammar/bank', body, undefined);
    expect(out.id).toBe(5);
  });

  it('surfaces 409 on idempotency conflict', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('conflict', { status: 409, code: 'conflict' }),
    );

    await expect(
      bankPattern({
        pattern_key: 'GR-x',
        pattern_display: 'x',
        summary_en: 'x',
        proficiency: 'L3',
        category: 'x',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('listBanked', () => {
  it('GETs /grammar/bank', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ entries: [] });

    const out = await listBanked();

    expect(spy).toHaveBeenCalledWith('/grammar/bank', undefined);
    expect(out.entries).toEqual([]);
  });

  it('coerces each banked row BIGINT string id to the declared number', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [
        {
          id: '44',
          pattern_key: 'GR-x',
          pattern_display: 'x',
          summary_en: 'x',
          proficiency: 'L3',
          category: 'x',
          register: null,
          discovered_via: 'reading',
          created_at: 'x',
          graduated_at: null,
        },
      ],
    });

    const out = await listBanked();

    expect(out.entries[0]?.id).toBe(44);
    expect(typeof out.entries[0]?.id).toBe('number');
  });
});

describe('identifyPattern', () => {
  it('POSTs /grammar/identify with the body', async () => {
    const body = { highlightSpan: '은/는', fullSentence: '나는 학생이에요.' };
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ result: { pattern_key: 'GR-eun-neun' } });

    const out = await identifyPattern(body);

    expect(spy).toHaveBeenCalledWith('/grammar/identify', body, undefined);
    expect(out.result).toEqual({ pattern_key: 'GR-eun-neun' });
  });

  it('surfaces network failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(
      identifyPattern({ highlightSpan: 'x', fullSentence: 'y' }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});

describe('fetchGrammarMastery (F-099)', () => {
  const PAGE = {
    summary: { new: 1, learning: 0, reviewing: 0, mastered: 1, total: 2 },
    patterns: [
      {
        id: 7,
        pattern: '-아/어 버리다',
        summaryEn: 'completion / regret',
        bucket: 'mastered',
        stability: 28,
        dueAt: null,
      },
    ],
    total: 2,
  };

  it('GETs /grammar/mastery with bucket/limit/offset params', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PAGE);

    const out = await fetchGrammarMastery({
      bucket: 'mastered',
      limit: 30,
      offset: 0,
    });

    expect(spy).toHaveBeenCalledWith('/grammar/mastery', {
      params: { bucket: 'mastered', limit: 30, offset: 0 },
    });
    expect(out).toEqual(PAGE);
  });

  it('omits undefined opts entirely (no bucket key riding along)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PAGE);

    await fetchGrammarMastery();

    expect(spy).toHaveBeenCalledWith('/grammar/mastery', { params: {} });
  });

  it('threads the AbortSignal through', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(PAGE);
    const ctrl = new AbortController();

    await fetchGrammarMastery({}, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/grammar/mastery', {
      params: {},
      signal: ctrl.signal,
    });
  });
});

describe('fetchGrammarSavedFromUploads (F-056)', () => {
  it('GETs /grammar/saved-from-uploads (signal threaded) and returns the full envelope', async () => {
    const envelope = {
      groups: [
        {
          upload: { id: 3, title: '새 문법책' },
          entries: [
            { id: 41, pattern: '-는 반면에', summary: 'whereas', savedAt: '2026-07-10T00:00:00Z' },
          ],
        },
      ],
      total: 1,
      truncated: false,
    };
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(envelope);
    const ctrl = new AbortController();

    const out = await fetchGrammarSavedFromUploads(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/grammar/saved-from-uploads', {
      signal: ctrl.signal,
    });
    expect(out).toEqual(envelope);
  });

  it('empty case: passes { groups: [], total: 0, truncated: false } through untouched (no signal → no options)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      groups: [],
      total: 0,
      truncated: false,
    });

    const out = await fetchGrammarSavedFromUploads();

    expect(spy).toHaveBeenCalledWith('/grammar/saved-from-uploads', undefined);
    expect(out.groups).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    await expect(fetchGrammarSavedFromUploads()).rejects.toBeInstanceOf(ApiError);
  });
});
