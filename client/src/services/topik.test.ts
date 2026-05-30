/**
 * topik service — URL construction, body/signal threading, envelope unwrap,
 * and error re-throw. Mirrors the diagnostic/reading service test style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStudyDraw, recordTopikAnswer } from './topik';
import { api, ApiError } from './api';
import type { TopikAnswerResult, TopikItem } from '../types/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM: TopikItem = {
  id: '101',
  section: '읽기',
  number: 28,
  level: 4,
  prompt: '이 글의 내용과 같은 것은?',
  options: [
    { id: 'a', kr: '가', en: 'A', correct: false },
    { id: 'b', kr: '나', en: 'B', correct: true },
    { id: 'c', kr: '다', en: 'C', correct: false },
    { id: 'd', kr: '라', en: 'D', correct: false },
  ],
  explanation: 'B is the only consistent summary.',
};

const RESULT: TopikAnswerResult = {
  correct: false,
  correctChoiceId: 'b',
  explanation: 'B is the only consistent summary.',
};

describe('fetchStudyDraw', () => {
  it('POSTs /topik/study and unwraps the items envelope', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ items: [ITEM] });

    const items = await fetchStudyDraw({});

    expect(spy).toHaveBeenCalledWith('/topik/study', {}, undefined);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('101');
  });

  it('forwards only the filter fields that were provided', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ items: [] });

    await fetchStudyDraw({ section: '듣기', level: 'L4', limit: 5 });

    expect(spy).toHaveBeenCalledWith(
      '/topik/study',
      { section: '듣기', level: 'L4', limit: 5 },
      undefined,
    );
  });

  it('omits undefined filter fields rather than sending explicit undefined', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ items: [] });

    await fetchStudyDraw({ level: 'L3' });

    expect(spy).toHaveBeenCalledWith(
      '/topik/study',
      { level: 'L3' },
      undefined,
    );
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({ items: [ITEM] });
    const ctrl = new AbortController();

    await fetchStudyDraw({}, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/topik/study', {}, {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchStudyDraw({})).rejects.toMatchObject({ status: 500 });
  });
});

describe('recordTopikAnswer', () => {
  it('POSTs /topik/:itemId/answer with the body and returns the reveal', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESULT);

    const res = await recordTopikAnswer('101', { picked: 'a', mode: 'study' });

    expect(spy).toHaveBeenCalledWith(
      '/topik/101/answer',
      { picked: 'a', mode: 'study' },
      undefined,
    );
    expect(res.correct).toBe(false);
    expect(res.correctChoiceId).toBe('b');
  });

  it('passes timeMs through when provided', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESULT);

    await recordTopikAnswer('101', { picked: 'b', timeMs: 3200, mode: 'study' });

    expect(spy).toHaveBeenCalledWith(
      '/topik/101/answer',
      { picked: 'b', timeMs: 3200, mode: 'study' },
      undefined,
    );
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESULT);
    const ctrl = new AbortController();

    await recordTopikAnswer('101', { picked: 'a' }, ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/topik/101/answer',
      { picked: 'a' },
      { signal: ctrl.signal },
    );
  });

  it('rethrows ApiError on failure (caller decides whether to swallow)', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('unauthorized', { status: 401, code: 'unauthorized' }),
    );

    await expect(
      recordTopikAnswer('101', { picked: 'a' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
