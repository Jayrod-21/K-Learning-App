/**
 * writing service — URL/body wiring, timeout override, and error surface for
 * `POST /grade-writing`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradeWriting, type GradeWritingResponse } from './writing';
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
});
