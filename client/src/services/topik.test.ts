/**
 * topik service — URL construction, body/signal threading, envelope unwrap,
 * and error re-throw. Mirrors the diagnostic/reading service test style.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAttemptHistory,
  fetchAvailableTests,
  fetchMockTest,
  fetchStudyDraw,
  recordTopikAnswer,
  submitMockTest,
  type AttemptHistoryResult,
  type AvailableTestsResult,
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
  topikLevel: 'TOPIK II',
  section: 'reading',
  audioUrl: null,
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

  // Fix-pass S-1 (REVIEW_topik.md / D-1): a specific past paper picked from
  // the F-118 exam list carries BOTH `sourceTest` and `topikLevel` — a
  // `test_number` alone names TWO exams (TOPIK I and TOPIK II share every
  // test_number), so this call must thread the level through, never drop it.
  it('sends BOTH sourceTest and topikLevel when a specific paper is picked', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_TEST);

    await fetchMockTest('reading', undefined, 91, 'TOPIK I');

    expect(spy).toHaveBeenCalledWith(
      '/topik/mock',
      { section: 'reading', sourceTest: 91, topikLevel: 'TOPIK I' },
      undefined,
    );
  });

  it('sends sourceTest without topikLevel when only the test number is known (e.g. F-007 resume)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(MOCK_TEST);

    await fetchMockTest('reading', undefined, 91);

    expect(spy).toHaveBeenCalledWith(
      '/topik/mock',
      { section: 'reading', sourceTest: 91 },
      undefined,
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

  // ── F-119 audio-field normalization ─────────────────────────────────────
  // The audio fields steer a real <audio> element (seek + pause clamp), so
  // fetchMockTest must degrade any malformed value to "no audio" instead of
  // passing it through to the player.

  it('carries a well-formed audioUrl + per-item span through verbatim', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      section: 'listening',
      audioUrl: '/topik/audio/60/2',
      items: [
        { ...MOCK_TEST.items[0]!, audioStartMs: 12000, audioEndMs: 45000 },
      ],
    });

    const res = await fetchMockTest('listening');

    expect(res.audioUrl).toBe('/topik/audio/60/2');
    expect(res.items[0]?.audioStartMs).toBe(12000);
    expect(res.items[0]?.audioEndMs).toBe(45000);
  });

  it('normalizes a non-string audioUrl (tampered/malformed envelope) to null', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      audioUrl: 12345 as unknown as string,
    });

    const res = await fetchMockTest('reading');

    expect(res.audioUrl).toBeNull();
  });

  it('drops a HALF span (only one bound present) entirely — both-or-neither', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      audioUrl: '/topik/audio/60/2',
      items: [{ ...MOCK_TEST.items[0]!, audioStartMs: 12000 }],
    });

    const res = await fetchMockTest('listening');

    // The lone bound is stripped, not carried as a dangling half window.
    expect(res.items[0]?.audioStartMs).toBeUndefined();
    expect(res.items[0]?.audioEndMs).toBeUndefined();
  });

  it.each([
    ['negative start', { audioStartMs: -1, audioEndMs: 5000 }],
    ['inverted range (end <= start)', { audioStartMs: 5000, audioEndMs: 5000 }],
    ['fractional bounds', { audioStartMs: 1.5, audioEndMs: 5000.75 }],
    ['non-finite bounds', { audioStartMs: 0, audioEndMs: Infinity }],
    [
      'non-numeric bounds',
      { audioStartMs: '12000' as unknown as number, audioEndMs: 45000 },
    ],
  ])('drops an invalid span (%s) — the item plays nothing', async (_label, span) => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      audioUrl: '/topik/audio/60/2',
      items: [{ ...MOCK_TEST.items[0]!, ...span }],
    });

    const res = await fetchMockTest('listening');

    expect(res.items[0]?.audioStartMs).toBeUndefined();
    expect(res.items[0]?.audioEndMs).toBeUndefined();
  });

  // ── decision-#2 `promptIsTranscript` normalization (fix-pass S-1) ───────
  // The flag drives transcript HIDING in the timed runner — the dangerous
  // direction — so only a real boolean may pass; junk is stripped to
  // `undefined`, which the runner treats as "keep the prompt visible".

  it('passes a boolean promptIsTranscript through verbatim (both values)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      section: 'listening',
      items: [
        { ...MOCK_TEST.items[0]!, promptIsTranscript: true },
        { ...MOCK_TEST.items[0]!, id: '1002', promptIsTranscript: false },
      ],
    });

    const res = await fetchMockTest('listening');

    expect(res.items[0]?.promptIsTranscript).toBe(true);
    expect(res.items[1]?.promptIsTranscript).toBe(false);
  });

  it.each([
    ['a truthy string', 'true'],
    ['a number', 1],
    ['null', null],
    ['an object', {}],
  ])(
    'strips a non-boolean promptIsTranscript (%s) — junk must never hide a prompt',
    async (_label, junk) => {
      vi.spyOn(api, 'post').mockResolvedValueOnce({
        ...MOCK_TEST,
        section: 'listening',
        items: [
          {
            ...MOCK_TEST.items[0]!,
            promptIsTranscript: junk as unknown as boolean,
          },
        ],
      });

      const res = await fetchMockTest('listening');

      expect(res.items[0]?.promptIsTranscript).toBeUndefined();
      expect(res.items[0]).not.toHaveProperty('promptIsTranscript');
    },
  );

  it('leaves an absent promptIsTranscript absent (older server envelope)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({ ...MOCK_TEST });

    const res = await fetchMockTest('reading');

    expect(res.items[0]).not.toHaveProperty('promptIsTranscript');
  });

  it('normalization never weakens the answer strip (no correct/explanation reintroduced)', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ...MOCK_TEST,
      audioUrl: '/topik/audio/60/2',
      items: [
        { ...MOCK_TEST.items[0]!, audioStartMs: 12000, audioEndMs: 45000 },
      ],
    });

    const res = await fetchMockTest('listening');

    expect(res.items[0]?.options[0]).not.toHaveProperty('correct');
    expect(res.items[0]).not.toHaveProperty('explanation');
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

// WIRE FIDELITY: the reveal's `itemId` is a STRING (`i.id::text` server-side)
// even though the submit BODY's `itemId` is a number (zod z.number()). The
// asymmetry is real — fixtures must mirror it or they mask lookup bugs.
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
      itemId: '1001',
      picked: 'b',
      correctChoiceId: 'b',
      isCorrect: true,
      explanation: 'B is the only consistent summary.',
    },
    {
      itemId: '1002',
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

// ── Fix-pass S-3 (REVIEW_topik.md) ────────────────────────────────────────
// `fetchAttemptHistory` (F-104) and `fetchAvailableTests` (F-118) were the
// only two functions in this file with no dedicated unit tests of their
// own — every OTHER function above (fetchStudyDraw, recordTopikAnswer,
// fetchMockTest, submitMockTest) gets a `describe` block asserting the exact
// URL, query-param construction, envelope unwrap, and AbortSignal threading;
// these two were exercised only indirectly through component tests mocking
// the whole service module. Mirrors the `searchKrdict` params-object test
// shape (services/krdict.test.ts).

const ATTEMPT_HISTORY_RESULT: AttemptHistoryResult = {
  attempts: [
    {
      attemptId: '1',
      section: '읽기',
      sourceTest: 91,
      topikLevel: 'TOPIK II',
      correct: 40,
      totalItems: 50,
      completedAt: '2026-06-01T00:00:00.000Z',
    },
  ],
  total: 1,
};

describe('fetchAttemptHistory', () => {
  it('GETs /topik/attempts with limit/offset params and returns the envelope', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(ATTEMPT_HISTORY_RESULT);

    const res = await fetchAttemptHistory({ limit: 20, offset: 0 });

    expect(spy).toHaveBeenCalledWith('/topik/attempts', {
      params: { limit: 20, offset: 0 },
    });
    expect(res).toBe(ATTEMPT_HISTORY_RESULT);
  });

  it('omits limit/offset entirely when not provided (server applies its own defaults)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ attempts: [], total: 0 });

    await fetchAttemptHistory();

    expect(spy).toHaveBeenCalledWith('/topik/attempts', { params: {} });
  });

  it('forwards only the opts that were provided (limit without offset)', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ attempts: [], total: 0 });

    await fetchAttemptHistory({ limit: 100 });

    expect(spy).toHaveBeenCalledWith('/topik/attempts', {
      params: { limit: 100 },
    });
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ attempts: [], total: 0 });
    const ctrl = new AbortController();

    await fetchAttemptHistory({}, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/topik/attempts', {
      params: {},
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchAttemptHistory()).rejects.toMatchObject({ status: 500 });
  });
});

const AVAILABLE_TESTS_RESULT: AvailableTestsResult = {
  tests: [{ testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 }],
  total: 1,
};

describe('fetchAvailableTests', () => {
  it('GETs /topik/tests with section/limit/offset params and returns the envelope', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(AVAILABLE_TESTS_RESULT);

    const res = await fetchAvailableTests({
      section: 'reading',
      limit: 50,
      offset: 0,
    });

    expect(spy).toHaveBeenCalledWith('/topik/tests', {
      params: { section: 'reading', limit: 50, offset: 0 },
    });
    expect(res).toBe(AVAILABLE_TESTS_RESULT);
  });

  it('omits section/limit/offset entirely when not provided', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ tests: [], total: 0 });

    await fetchAvailableTests();

    expect(spy).toHaveBeenCalledWith('/topik/tests', { params: {} });
  });

  it('forwards only the opts that were provided (section without limit/offset)', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ tests: [], total: 0 });

    await fetchAvailableTests({ section: 'listening' });

    expect(spy).toHaveBeenCalledWith('/topik/tests', {
      params: { section: 'listening' },
    });
  });

  it('threads an AbortSignal into the request config', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ tests: [], total: 0 });
    const ctrl = new AbortController();

    await fetchAvailableTests({}, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/topik/tests', {
      params: {},
      signal: ctrl.signal,
    });
  });

  it('rethrows ApiError on failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );

    await expect(fetchAvailableTests()).rejects.toMatchObject({ status: 500 });
  });
});
