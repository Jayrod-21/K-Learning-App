/**
 * Writing page — fetch prompts → compose → grade → reveal over a mocked
 * `services/writing`.
 *
 * The service module is mocked so both legs resolve/reject on command:
 * `fetchWritingPrompts` (F-014 — the screen's task list is served per rubric,
 * no hardcoded prompts) and `gradeWriting`. Assertions cover the prompts
 * loading/error/empty states, the outgoing grade body (prompt + sample +
 * rubric + promptId — the route's schema is .strict(), so this IS the wire
 * contract), the reveal render, and the failure-safe paths (429 with
 * retryAfter — live now that B-016 populates it — and generic failure
 * preserving the learner's text).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { GradeWritingResponse } from '../types/domain';
import type { WritingPromptDTO } from '../services/writing';

vi.mock('../services/writing', () => ({
  fetchWritingPrompts: vi.fn(),
  gradeWriting: vi.fn(),
}));

// Import after the mock so the page wires to it.
import Writing from './Writing';
import { fetchWritingPrompts, gradeWriting } from '../services/writing';

const fetchPromptsMock = vi.mocked(fetchWritingPrompts);
const gradeWritingMock = vi.mocked(gradeWriting);

/** Served Q53 prompts — what `GET /writing/prompts?rubric=topik_ii_53` returns. */
const Q53_PROMPTS: WritingPromptDTO[] = [
  {
    id: 101,
    promptKr:
      '여러분은 스트레스를 받을 때 어떻게 해소합니까? 자신의 스트레스 해소 방법과 그 방법의 좋은 점을 200~300자로 쓰십시오.',
    promptEn: 'How do you relieve stress? Describe your method and its benefits.',
    level: 'L4',
    rubric: 'topik_ii_53',
    estMinutes: 15,
  },
  {
    id: 102,
    promptKr: '인터넷 쇼핑이 우리 생활에 주는 장점과 단점에 대해 200~300자로 쓰십시오.',
    promptEn: null,
    level: 'L4',
    rubric: 'topik_ii_53',
    estMinutes: 15,
  },
];

/** Served Q54 prompts. */
const Q54_PROMPTS: WritingPromptDTO[] = [
  {
    id: 201,
    promptKr:
      '현대 사회에서 인공지능의 발달이 우리 생활에 미치는 영향에 대해 자신의 생각을 600~700자로 논술하십시오.',
    promptEn: null,
    level: 'L5',
    rubric: 'topik_ii_54',
    estMinutes: 40,
  },
];

const RESPONSE: GradeWritingResponse = {
  result: {
    rubric: 'topik_ii_53',
    content: {
      score: 20,
      maxScore: 30,
      evidence: ['스트레스 해소 방법을 구체적으로 설명함'],
      improvements: ['이유를 한 가지 더 제시하세요.'],
    },
    organization: {
      score: 18,
      maxScore: 30,
      evidence: [],
      improvements: ['연결 표현을 다양하게 사용하세요.'],
    },
    languageUse: {
      score: 25,
      maxScore: 40,
      evidence: ['-기 때문에'],
      improvements: [],
    },
    totalScore: 63,
    maxTotal: 100,
    estimatedLevel: 'L4',
    overallComment: 'Clear structure with room to grow in variety.',
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

const SAMPLE = '저는 스트레스를 받을 때 산책을 합니다. 산책을 하면 기분이 좋아지기 때문에 자주 걷습니다.';

/** Render and wait until the default (Q53) prompts have landed on screen. */
async function renderLoaded(): Promise<void> {
  render(<Writing />);
  await screen.findByText(/스트레스 해소 방법/);
}

beforeEach(() => {
  gradeWritingMock.mockReset();
  fetchPromptsMock.mockReset();
  // Default happy path: each rubric tab serves its own fetched pool.
  fetchPromptsMock.mockImplementation((rubric) =>
    Promise.resolve(rubric === 'topik_ii_53' ? Q53_PROMPTS : Q54_PROMPTS),
  );
});

describe('Writing', () => {
  it('fetches the rubric prompts and renders the first task + compose surface', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('heading', { level: 1, name: '쓰기 · Writing' }),
    ).toBeInTheDocument();
    // Default rubric is Q53 — the tab's prompts were fetched, not hardcoded.
    expect(fetchPromptsMock).toHaveBeenCalledWith(
      'topik_ii_53',
      expect.any(AbortSignal),
    );
    // First served prompt shows, with its optional English gloss.
    expect(screen.getByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(screen.getByText(/How do you relieve stress/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toBeInTheDocument();
  });

  it('shows a loading status while the prompts are in flight', () => {
    fetchPromptsMock.mockImplementation(
      () => new Promise<WritingPromptDTO[]>(() => undefined),
    );
    render(<Writing />);

    expect(screen.getByRole('status')).toHaveTextContent(
      /Loading writing tasks/,
    );
    // No compose surface until a task exists to answer.
    expect(
      screen.queryByRole('textbox', { name: /Your writing in Korean/ }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a prompts-fetch failure with a Retry that refetches', async () => {
    fetchPromptsMock.mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    render(<Writing />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/writing tasks couldn't be loaded/);

    // Retry re-runs the fetch (default impl resolves) — the task appears.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchPromptsMock).toHaveBeenCalledTimes(2);
  });

  it('renders an honest empty state when the rubric pool is empty', async () => {
    fetchPromptsMock.mockResolvedValueOnce([]);
    render(<Writing />);

    expect(
      await screen.findByText(/No writing tasks are available/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /Your writing in Korean/ }),
    ).not.toBeInTheDocument();
  });

  it('P3b: title + eyebrows render Korean in both-mode', async () => {
    await renderLoaded();
    expect(
      screen.getByRole('heading', { level: 1, name: '쓰기 · Writing' }),
    ).toBeInTheDocument();
    // Topbar eyebrow — the nav manifest pair.
    expect(screen.getByText('TOPIK 쓰기 채점')).toBeInTheDocument();
    expect(screen.getByText('TOPIK writing grader')).toBeInTheDocument();
    // Rubric eyebrow (Q53 default) carries its Korean half.
    expect(screen.getByText('설명하는 글')).toBeInTheDocument();
    expect(screen.getByText('Describe and explain')).toBeInTheDocument();
  });

  it('disables Grade until the learner has written something', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const submit = screen.getByRole('button', { name: '채점하기 · Grade my writing' });
    expect(submit).toBeDisabled();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    expect(submit).toBeEnabled();
  });

  it('submits the served prompt + promptId + trimmed sample + rubric and renders the grade', async () => {
    gradeWritingMock.mockResolvedValueOnce(RESPONSE);
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      SAMPLE,
    );
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    // Outgoing body — the .strict() wire contract: exactly these four fields,
    // with the served task's text as `prompt` and its id as `promptId` so the
    // persisted attempt links back to its writing_prompts row (F-014).
    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body, signal] = gradeWritingMock.mock.calls[0]!;
    expect(body).toEqual({
      prompt: Q53_PROMPTS[0]!.promptKr,
      sample: SAMPLE,
      rubric: 'topik_ii_53',
      promptId: 101,
    });
    expect(signal).toBeInstanceOf(AbortSignal);

    // Reveal: total, level pill, all three dimension fractions, evidence,
    // improvements, and the overall comment.
    expect(await screen.findByText('63')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getByText('TOPIK 4')).toBeInTheDocument();
    expect(screen.getByText('내용 및 과제수행')).toBeInTheDocument();
    expect(screen.getByText('전개구조')).toBeInTheDocument();
    expect(screen.getByText('언어사용')).toBeInTheDocument();
    expect(screen.getByText('20 / 30')).toBeInTheDocument();
    expect(screen.getByText('18 / 30')).toBeInTheDocument();
    expect(screen.getByText('25 / 40')).toBeInTheDocument();
    expect(
      screen.getByText('스트레스 해소 방법을 구체적으로 설명함'),
    ).toBeInTheDocument();
    expect(screen.getByText(/이유를 한 가지 더 제시하세요/)).toBeInTheDocument();
    expect(
      screen.getByText('Clear structure with room to grow in variety.'),
    ).toBeInTheDocument();
  });

  it('shows the busy status while the grade is in flight', async () => {
    let resolveGrade: (v: GradeWritingResponse) => void = () => undefined;
    gradeWritingMock.mockImplementationOnce(
      () =>
        new Promise<GradeWritingResponse>((resolve) => {
          resolveGrade = resolve;
        }),
    );
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    expect(screen.getByRole('status')).toHaveTextContent(/Grading your writing/);

    resolveGrade(RESPONSE);
    expect(await screen.findByText('63')).toBeInTheDocument();
  });

  it('surfaces a 429 with the structured retryAfter and preserves the text', async () => {
    // B-016 made the expensive-bucket 429 carry retry_after, so this branch
    // is the LIVE rate-limit surface — the countdown copy must render it.
    gradeWritingMock.mockRejectedValueOnce(
      new ApiError('slow down', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 42,
      }),
    );
    const user = userEvent.setup();
    await renderLoaded();

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rate-limited/);
    expect(alert).toHaveTextContent(/42 seconds/);
    // The learner's text survives the failure and Submit is the retry.
    expect(textarea).toHaveValue('안녕하세요');
    expect(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    ).toBeEnabled();
  });

  it('falls back to the fixed wait copy on a 429 without retryAfter', async () => {
    gradeWritingMock.mockRejectedValueOnce(
      new ApiError('slow down', { status: 429, code: 'rate_limited' }),
    );
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rate-limited right now/);
    expect(alert).not.toHaveTextContent(/seconds/);
  });

  it('surfaces a generic upstream failure without blanking the compose sheet', async () => {
    gradeWritingMock.mockRejectedValueOnce(
      new ApiError('upstream', { status: 502, code: 'upstream_error' }),
    );
    const user = userEvent.setup();
    await renderLoaded();

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't score this sample/);
    expect(textarea).toHaveValue('안녕하세요');
  });

  it('switches rubric tabs, fetches that rubric, and submits with its prompt', async () => {
    gradeWritingMock.mockResolvedValueOnce({
      ...RESPONSE,
      result: { ...RESPONSE.result, rubric: 'topik_ii_54' },
    });
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Q54 · 600–700자' }));
    // The other rubric's pool is fetched fresh for its tab.
    expect(await screen.findByText(/인공지능의 발달/)).toBeInTheDocument();
    expect(fetchPromptsMock).toHaveBeenCalledWith(
      'topik_ii_54',
      expect.any(AbortSignal),
    );

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '인공지능은 편리합니다.',
    );
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));

    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body] = gradeWritingMock.mock.calls[0]!;
    expect(body.rubric).toBe('topik_ii_54');
    expect(body.prompt).toContain('인공지능');
    expect(body.promptId).toBe(201);
  });

  it('"Revise & regrade" returns to composing with the text intact', async () => {
    gradeWritingMock.mockResolvedValueOnce(RESPONSE);
    const user = userEvent.setup();
    await renderLoaded();

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));
    await screen.findByText('63');

    await user.click(screen.getByRole('button', { name: '고쳐서 다시 채점 · Revise & regrade' }));

    expect(screen.queryByText('63')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('안녕하세요');
    expect(textarea).toBeEnabled();
  });

  it('"New prompt" rotates within the fetched pool and clears the sheet', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '새 과제 · New prompt' }));

    // Second served Q53 prompt is now on screen; the draft is cleared. No
    // refetch — rotation walks the already-fetched pool.
    expect(screen.getByText(/인터넷 쇼핑/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toHaveValue('');
    expect(fetchPromptsMock).toHaveBeenCalledTimes(1);
  });

  it('disables "New prompt" when the rubric pool has exactly one prompt (F-UP-017)', async () => {
    // With a single-prompt pool the rotate cursor wraps to the SAME prompt —
    // pre-fix the button was a destructive no-op that only wiped the draft.
    fetchPromptsMock.mockImplementation(() =>
      Promise.resolve([Q53_PROMPTS[0]!]),
    );
    const user = userEvent.setup();
    await renderLoaded();

    const newPrompt = screen.getByRole('button', { name: '새 과제 · New prompt' });
    expect(newPrompt).toBeDisabled();

    // The draft survives — clicking a disabled button must not clear it.
    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(newPrompt);
    expect(textarea).toHaveValue('안녕하세요');
    // Still the same (only) prompt on screen.
    expect(screen.getByText(/스트레스 해소 방법/)).toBeInTheDocument();
  });

  it('keeps "New prompt" disabled on the graded footer at pool size one', async () => {
    fetchPromptsMock.mockImplementation(() =>
      Promise.resolve([Q53_PROMPTS[0]!]),
    );
    gradeWritingMock.mockResolvedValueOnce(RESPONSE);
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '채점하기 · Grade my writing' }));
    await screen.findByText('63');

    // Same contract post-grade: "New prompt" cannot deliver a new prompt, so
    // it stays disabled; "Revise & regrade" remains the way back to editing.
    expect(screen.getByRole('button', { name: '새 과제 · New prompt' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '고쳐서 다시 채점 · Revise & regrade' }),
    ).toBeEnabled();
  });
});
