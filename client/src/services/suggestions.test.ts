/**
 * suggestions service — weekly vocab + grammar pick unwrapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWeeklyGrammarSuggestions,
  fetchWeeklyVocabSuggestions,
} from './suggestions';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWeeklyVocabSuggestions', () => {
  it('GETs /vocab/suggestions/weekly and unwraps `entries`', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      entries: [
        { id: 1, corpus: 'x', korean: '결과', english: 'result', proficiency: 'L3', theme: null },
      ],
    });

    const got = await fetchWeeklyVocabSuggestions();

    expect(spy).toHaveBeenCalledWith('/vocab/suggestions/weekly', undefined);
    expect(got).toHaveLength(1);
    expect(got[0]?.korean).toBe('결과');
  });

  it('forwards an abort signal', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ entries: [] });
    const ctrl = new AbortController();

    await fetchWeeklyVocabSuggestions(ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/vocab/suggestions/weekly', {
      signal: ctrl.signal,
    });
  });

  it('propagates errors', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    await expect(fetchWeeklyVocabSuggestions()).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('fetchWeeklyGrammarSuggestions', () => {
  it('GETs /grammar/suggestions/weekly and unwraps `patterns`', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({
      patterns: [
        {
          id: 100,
          corpus: 'kgiu_intermediate',
          source_id: 'KGIU-INT-009',
          pattern: '-는 반면에',
          title_en: 'whereas',
          category: 'contrast',
          proficiency: 'L4',
          unit: 'Unit 9',
          source_pages: null,
        },
      ],
    });

    const got = await fetchWeeklyGrammarSuggestions();

    expect(spy).toHaveBeenCalledWith('/grammar/suggestions/weekly', undefined);
    expect(got).toHaveLength(1);
    expect(got[0]?.pattern).toBe('-는 반면에');
  });
});
