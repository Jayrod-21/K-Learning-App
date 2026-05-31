/**
 * topik service — URL construction, body/signal threading, envelope unwrap,
 * and error re-throw. Mirrors the diagnostic/reading service test style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMockTest,
  fetchStudyDraw,
  recordTopikAnswer,
  submitMockTest,
} from './topik';
import { api, ApiError } from './api';
import type {
  MockResult,
  MockSubmitBody,
  MockTest,
  TopikAnswerResult,
  TopikItem,
} from '../types/domain';

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

const MOCK_TEST: MockTest = {
  sourceTest: 7,
  section: 'reading',
  items: [
    {
      id: '1001',
      section: '읽기',
      number: 1,
      level: 4,
      prompt: '이 글의 내용과 같은 것은?',
      options: [
        { id: 'a', kr: '가', en: 'A' },
        { id: 'b', kr: '나', en: 'B' },
        { id: 'c', kr: '다', en: 'C' },
        { id: 'd', kr: '라', en: 'D' },
      ],
    },
  ],
};

describe('fetchMockTest', () => {
  it('POSTs /topik/mock with just the section and returns the stripped envelope', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_TEST);

    const res = await fetchMockTest('reading');

    expect(spy).toHaveBeenCalledWith(
      '/topik/mock',
      { section: 'reading' },
      undefined,
    );
    expect(res.sourceTest).toBe(7);
    expect(res.section).toBe('reading');
    // The returned items carry NO `correct` flag and NO `explanation`.
    const opt = res.items[0]?.options[0];
    expect(opt).not.toHaveProperty('correct');
    expect(res.items[0]).not.toHaveProperty('explanation');
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_TEST);
    const ctrl = new AbortController();

    await fetchMockTest('listening', ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/topik/mock',
      { section: 'listening' },
      { signal: ctrl.signal },
    );
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchMockTest('reading')).rejects.toMatchObject({
      status: 500,
    });
  });
});

const SUBMIT_BODY: MockSubmitBody = {
  sourceTest: 7,
  section: 'reading',
  answers: [
    { itemId: 1001, picked: 'b', timeMs: 4200 },
    { itemId: 1002, picked: 'a' },
  ],
  durationMs: 90000,
};

const MOCK_RESULT: MockResult = {
  sourceTest: 7,
  section: 'reading',
  totalItems: 2,
  answered: 2,
  correct: 1,
  percentage: 50,
  band: 'L3 range',
  items: [
    {
      itemId: 1001,
      picked: 'b',
      correctChoiceId: 'b',
      isCorrect: true,
      explanation: 'B is the only consistent summary.',
    },
    {
      itemId: 1002,
      picked: 'a',
      correctChoiceId: 'c',
      isCorrect: false,
      explanation: 'C restates the underlined phrase.',
    },
  ],
};

describe('submitMockTest', () => {
  it('POSTs /topik/mock/submit with the body and returns the graded result', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_RESULT);

    const res = await submitMockTest(SUBMIT_BODY);

    expect(spy).toHaveBeenCalledWith(
      '/topik/mock/submit',
      SUBMIT_BODY,
      undefined,
    );
    expect(res.percentage).toBe(50);
    expect(res.band).toBe('L3 range');
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.isCorrect).toBe(true);
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_RESULT);
    const ctrl = new AbortController();

    await submitMockTest(SUBMIT_BODY, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/topik/mock/submit', SUBMIT_BODY, {
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('bad request', { status: 400, code: 'bad_request' }),
    );

    await expect(submitMockTest(SUBMIT_BODY)).rejects.toMatchObject({
      status: 400,
    });
  });
});
