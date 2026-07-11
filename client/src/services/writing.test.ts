/**
 * writing service — URL/body wiring, timeout override, and error surface for
 * `POST /grade-writing`; envelope unwrap + params wiring for
 * `GET /writing/prompts` (F-014).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWritingAttempts,
  fetchWritingPrompts,
  gradeWriting,
  type GradeWritingResponse,
  type WritingAttemptDTO,
  type WritingPromptDTO,
} from './writing';
import { api, ApiError } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const RESPONSE: GradeWritingResponse = {
  result: {
    rubric: 'topik_ii_54',
    content: {
      score: 20,
      maxScore: 30,
      evidence: ['주제를 잘 다루었다'],
      improvements: ['예시를 더 구체적으로 쓰세요.'],
    },
    organization: {
      score: 18,
      maxScore: 30,
      evidence: [],
      improvements: ['단락 구분을 명확히 하세요.'],
    },
    languageUse: {
      score: 25,
      maxScore: 40,
      evidence: ['-ㄹ 뿐만 아니라'],
      improvements: ['조사 사용에 주의하세요.'],
    },
    totalScore: 63,
    maxTotal: 100,
    estimatedLevel: 'L4',
    overallComment: 'A solid intermediate essay with clear structure.',
  },
  metadata: {
    requestId: 'req-1',
    model: 'claude-sonnet-4-6',
    cacheHit: false,
    latencyMs: 4200,
    inputTokens: 900,
    outputTokens: 450,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costEstimateUsd: 0.01,
  },
};

describe('gradeWriting', () => {
  it('POSTs /grade-writing with the body and returns the envelope intact', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESPONSE);
    const body = {
      prompt: '환경 보호에 대해 쓰십시오.',
      sample: '환경 보호는 중요합니다.',
      rubric: 'topik_ii_54' as const,
    };

    const out = await gradeWriting(body);

    // The grade leg wraps Claude, so it MUST override the 10s axios default
    // (api.ts). 65s brackets the server's own 60s upstream ceiling so a slow
    // grade surfaces as the server's upstream_error, not a client ECONNABORTED.
    expect(spy).toHaveBeenCalledWith('/grade-writing', body, {
      timeout: 65_000,
    });
    // The envelope maps through untouched — rubric scores, level, comment.
    expect(out.result.totalScore).toBe(63);
    expect(out.result.maxTotal).toBe(100);
    expect(out.result.estimatedLevel).toBe('L4');
    expect(out.result.content.maxScore).toBe(30);
    expect(out.result.languageUse.improvements).toHaveLength(1);
    expect(out.result.overallComment).toContain('intermediate');
    expect(out.metadata.requestId).toBe('req-1');
  });

  it('omits rubric when the caller does (server defaults to topik_ii_54)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESPONSE);
    const body = { prompt: 'p', sample: 's' };

    await gradeWriting(body);

    // The route's schema is .strict() — the body must carry EXACTLY what the
    // caller passed, no injected fields.
    expect(spy).toHaveBeenCalledWith('/grade-writing', body, {
      timeout: 65_000,
    });
  });

  it('forwards the abort signal alongside the Claude timeout override', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESPONSE);
    const ctrl = new AbortController();

    await gradeWriting({ prompt: 'p', sample: 's' }, ctrl.signal);

    expect(spy).toHaveBeenCalledWith(
      '/grade-writing',
      { prompt: 'p', sample: 's' },
      { timeout: 65_000, signal: ctrl.signal },
    );
  });

  it('surfaces a 429 rate limit as ApiError with retryAfter intact', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('rate limited', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 30,
      }),
    );

    await expect(
      gradeWriting({ prompt: 'p', sample: 's' }),
    ).rejects.toMatchObject({ status: 429, retryAfter: 30 });
  });

  it('surfaces a 502 Claude failure as ApiError', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError('upstream', { status: 502, code: 'upstream_error' }),
    );

    await expect(
      gradeWriting({ prompt: 'p', sample: 's' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('forwards promptId when the caller grades a served prompt (F-014)', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce(RESPONSE);
    const body = {
      prompt: '환경 보호에 대해 쓰십시오.',
      sample: '환경 보호는 중요합니다.',
      rubric: 'topik_ii_54' as const,
      promptId: 7,
    };

    await gradeWriting(body);

    // Still the exact caller body — .strict() server schema, no reshaping.
    expect(spy).toHaveBeenCalledWith('/grade-writing', body, {
      timeout: 65_000,
    });
  });
});

describe('fetchWritingPrompts', () => {
  const PROMPTS: WritingPromptDTO[] = [
    {
      id: 1,
      promptKr: '스트레스 해소 방법에 대해 쓰십시오.',
      promptEn: 'Write about how you relieve stress.',
      level: 'L4',
      rubric: 'topik_ii_53',
      estMinutes: 15,
    },
    {
      id: 2,
      promptKr: '인터넷 쇼핑의 장단점에 대해 쓰십시오.',
      promptEn: null,
      level: 'L4',
      rubric: 'topik_ii_53',
      estMinutes: null,
    },
  ];

  it('GETs /writing/prompts with the rubric param and unwraps { prompts }', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ prompts: PROMPTS });

    const out = await fetchWritingPrompts('topik_ii_53');

    expect(spy).toHaveBeenCalledWith('/writing/prompts', {
      params: { rubric: 'topik_ii_53' },
    });
    expect(out).toEqual(PROMPTS);
  });

  it('forwards the abort signal alongside the rubric param', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ prompts: [] });
    const ctrl = new AbortController();

    const out = await fetchWritingPrompts('topik_ii_54', ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/writing/prompts', {
      params: { rubric: 'topik_ii_54' },
      signal: ctrl.signal,
    });
    // Empty pool resolves as [], not an error — the screen owns that state.
    expect(out).toEqual([]);
  });

  it('surfaces a failed load as ApiError (no swallow, no fallback)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );

    await expect(fetchWritingPrompts('topik_ii_53')).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('fetchWritingAttempts (F-106)', () => {
  const ATTEMPTS: WritingAttemptDTO[] = [
    {
      id: 501,
      promptId: 101,
      rubric: 'topik_ii_53',
      promptKr: '스트레스 해소 방법에 대해 쓰십시오.',
      sample: '지난 답안입니다.',
      totalScore: 21,
      maxTotal: 30,
      estimatedLevel: 'L3',
      gradedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 502,
      promptId: null,
      rubric: 'free_write',
      promptKr: '가장 기억에 남는 여행에 대해 자유롭게 써 보세요.',
      sample: '작년 여행이 기억에 남습니다.',
      totalScore: 24,
      maxTotal: 30,
      estimatedLevel: 'L4',
      gradedAt: '2026-07-05T00:00:00.000Z',
    },
  ];

  it('GETs /writing/attempts and unwraps { attempts, limit, offset }', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ attempts: ATTEMPTS, limit: 20, offset: 0 });

    const out = await fetchWritingAttempts();

    // No params supplied → both keys forwarded as undefined (axios drops
    // undefined-valued params from the query string; the server defaults).
    expect(spy).toHaveBeenCalledWith('/writing/attempts', {
      params: { limit: undefined, offset: undefined },
    });
    expect(out.attempts).toEqual(ATTEMPTS);
    expect(out.limit).toBe(20);
    expect(out.offset).toBe(0);
  });

  it('forwards limit/offset and the abort signal', async () => {
    const spy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ attempts: [], limit: 5, offset: 10 });
    const ctrl = new AbortController();

    const out = await fetchWritingAttempts({ limit: 5, offset: 10 }, ctrl.signal);

    expect(spy).toHaveBeenCalledWith('/writing/attempts', {
      params: { limit: 5, offset: 10 },
      signal: ctrl.signal,
    });
    // An empty history resolves as [] — never an error (a learner who has
    // never graded a sample is not a failure state).
    expect(out.attempts).toEqual([]);
  });

  it('surfaces a failed load as ApiError (no swallow, no fallback)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );

    await expect(fetchWritingAttempts()).rejects.toMatchObject({ status: 500 });
  });
});
