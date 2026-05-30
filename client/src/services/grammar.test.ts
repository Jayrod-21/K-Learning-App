/**
 * grammar service — KGIU + bank + identify URL/body wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bankPattern,
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
