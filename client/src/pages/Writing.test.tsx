/**
 * Writing page (3C-2) — random-draw prompts → compose → grade → reveal, the
 * on-page topic generator (F-073), the Today deep-link seam (F-101), and the
 * Responses stub (F-074), over a mocked `services/writing`.
 *
 * The service module is mocked so every leg resolves/rejects on command:
 * `fetchRandomWritingPrompt` (B-027 — the screen draws ONE random prompt per
 * visit/redraw, never `/prompts`[0]), `gradeWriting`, and
 * `generateWritingPrompt` (consumed by the embedded WritingTopicGenerator).
 * Assertions cover REAL behavior: the random endpoint being called, headers
 * derived from the served prompt's ACTUAL rubric (not the selected radio),
 * the outgoing grade body per task source (bank carries promptId, generated
 * omits it — the route's schema is .strict(), so this IS the wire contract),
 * draft preservation across redraws/tab round-trips, and the failure-safe
 * paths (429 retryAfter, generic failure, empty-pool 404).
 *
 * Rendered inside a MemoryRouter — the page consumes useLocation (F-101
 * deep-link state) and BackButton/useNavigate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../services/api';
import type { GradeWritingResponse } from '../types/domain';
import type {
  GeneratedWritingPrompt,
  WritingPromptDTO,
} from '../services/writing';

vi.mock('../services/writing', () => ({
  fetchRandomWritingPrompt: vi.fn(),
  gradeWriting: vi.fn(),
  generateWritingPrompt: vi.fn(),
}));

// Import after the mock so the page wires to it.
import Writing from './Writing';
import {
  fetchRandomWritingPrompt,
  gradeWriting,
  generateWritingPrompt,
} from '../services/writing';

const fetchRandomMock = vi.mocked(fetchRandomWritingPrompt);
const gradeWritingMock = vi.mocked(gradeWriting);
const generateMock = vi.mocked(generateWritingPrompt);

/** Q53 bank prompts the random endpoint serves in these tests. */
const Q53_PROMPT: WritingPromptDTO = {
  id: 101,
  promptKr:
    '여러분은 스트레스를 받을 때 어떻게 해소합니까? 자신의 스트레스 해소 방법과 그 방법의 좋은 점을 200~300자로 쓰십시오.',
  promptEn: 'How do you relieve stress? Describe your method and its benefits.',
  level: 'L4',
  rubric: 'topik_ii_53',
  estMinutes: 15,
};

const Q53_PROMPT_B: WritingPromptDTO = {
  id: 102,
  promptKr: '인터넷 쇼핑이 우리 생활에 주는 장점과 단점에 대해 200~300자로 쓰십시오.',
  promptEn: null,
  level: 'L4',
  rubric: 'topik_ii_53',
  estMinutes: 15,
};

/** Q54 bank prompt. */
const Q54_PROMPT: WritingPromptDTO = {
  id: 201,
  promptKr:
    '현대 사회에서 인공지능의 발달이 우리 생활에 미치는 영향에 대해 자신의 생각을 600~700자로 논술하십시오.',
  promptEn: null,
  level: 'L5',
  rubric: 'topik_ii_54',
  estMinutes: 40,
};

/** A Claude-generated TOPIK-style topic (generator / deep-link payloads). */
const GENERATED_TOPIK: GeneratedWritingPrompt = {
  promptKr: '환경 보호를 위해 개인이 할 수 있는 일에 대해 자신의 의견을 쓰십시오.',
  promptEn: 'Write your opinion on what individuals can do to protect the environment.',
  lengthHint: '600-700자',
  mode: 'topik',
  rubric: 'topik_ii_54',
};

/** A Claude-generated free-write topic. */
const GENERATED_GENERAL: GeneratedWritingPrompt = {
  promptKr: '가장 기억에 남는 여행에 대해 자유롭게 써 보세요.',
  promptEn: 'Write freely about your most memorable trip.',
  lengthHint: null,
  mode: 'general',
  rubric: null,
};

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

const SAMPLE =
  '저는 스트레스를 받을 때 산책을 합니다. 산책을 하면 기분이 좋아지기 때문에 자주 걷습니다.';

/** Render inside a MemoryRouter, optionally with F-101 deep-link state. */
function renderWriting(state?: unknown): void {
  render(
    <MemoryRouter
      initialEntries={[{ pathname: '/learn/writing', ...(state !== undefined ? { state } : {}) }]}
    >
      <Writing />
    </MemoryRouter>,
  );
}

/** Render and wait until the default (Q53) random draw has landed. */
async function renderLoaded(): Promise<void> {
  renderWriting();
  await screen.findByText(/스트레스 해소 방법/);
}

beforeEach(() => {
  gradeWritingMock.mockReset();
  fetchRandomMock.mockReset();
  generateMock.mockReset();
  generateMock.mockRejectedValue(new Error('not wired in this test'));
  // Default happy path: each rubric serves its own random draw.
  fetchRandomMock.mockImplementation((rubric) =>
    Promise.resolve(rubric === 'topik_ii_53' ? Q53_PROMPT : Q54_PROMPT),
  );
});

describe('Writing', () => {
  it('draws ONE random prompt for the default rubric (B-027) and renders it', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('heading', { level: 1, name: '쓰기 · Writing' }),
    ).toBeInTheDocument();
    // The genuinely-random endpoint is the selection path — never /prompts[0].
    expect(fetchRandomMock).toHaveBeenCalledWith(
      'topik_ii_53',
      expect.any(AbortSignal),
    );
    expect(screen.getByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(screen.getByText(/How do you relieve stress/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toBeInTheDocument();
  });

  it('derives the header from the SERVED prompt’s rubric, not the selected radio (B-027)', async () => {
    // A Q54-rubric prompt arrives while the Q53 radio is selected (server
    // truth wins): the eyebrow and target band must follow the payload.
    fetchRandomMock.mockResolvedValueOnce(Q54_PROMPT);
    renderWriting();
    await screen.findByText(/인공지능의 발달/);

    expect(screen.getByText('주장하는 글')).toBeInTheDocument();
    expect(screen.getByText('Argue a position')).toBeInTheDocument();
    expect(screen.queryByText('설명하는 글')).not.toBeInTheDocument();
    // The textarea label carries the Q54 target band.
    expect(
      screen.getByRole('textbox', { name: /600–700자/ }),
    ).toBeInTheDocument();
  });

  it('shows a loading status while the draw is in flight', () => {
    fetchRandomMock.mockImplementation(
      () => new Promise<WritingPromptDTO>(() => undefined),
    );
    renderWriting();

    expect(screen.getByRole('status')).toHaveTextContent(
      /Loading a writing task/,
    );
    expect(
      screen.queryByRole('textbox', { name: /Your writing in Korean/ }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a draw failure with a Retry that redraws', async () => {
    fetchRandomMock.mockRejectedValueOnce(
      new ApiError('server error', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderWriting();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/writing task couldn't be loaded/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledTimes(2);
  });

  it('renders an honest empty state on the empty-pool 404', async () => {
    fetchRandomMock.mockRejectedValueOnce(
      new ApiError('not found', { status: 404, code: 'not_found' }),
    );
    renderWriting();

    expect(
      await screen.findByText(/No writing tasks are available/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /Your writing in Korean/ }),
    ).not.toBeInTheDocument();
    // 404 is the empty state, not a retryable error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('P3b: title + eyebrows render Korean in both-mode', async () => {
    await renderLoaded();
    expect(
      screen.getByRole('heading', { level: 1, name: '쓰기 · Writing' }),
    ).toBeInTheDocument();
    // Topbar eyebrow — the nav manifest pair.
    expect(screen.getByText('TOPIK 쓰기 채점')).toBeInTheDocument();
    expect(screen.getByText('TOPIK writing grader')).toBeInTheDocument();
    // Task eyebrow (served Q53 prompt) carries its Korean half.
    expect(screen.getByText('설명하는 글')).toBeInTheDocument();
    expect(screen.getByText('Describe and explain')).toBeInTheDocument();
  });

  it('disables Grade until the learner has written something', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const submit = screen.getByRole('button', {
      name: '채점하기 · Grade my writing',
    });
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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    // Outgoing body — the .strict() wire contract: exactly these four fields,
    // with the served task's text as `prompt` and its id as `promptId` so the
    // persisted attempt links back to its writing_prompts row (F-014).
    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body, signal] = gradeWritingMock.mock.calls[0]!;
    expect(body).toEqual({
      prompt: Q53_PROMPT.promptKr,
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

  it('shows the busy status while grading and keeps the Grade button focusable', async () => {
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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    expect(screen.getByRole('status')).toHaveTextContent(/Grading your writing/);
    // aria-disabled (focus survives), NOT the hard disabled attribute; the
    // click guard blocks re-entry instead.
    const busyBtn = screen.getByRole('button', { name: '채점 중… · Grading…' });
    expect(busyBtn).not.toBeDisabled();
    expect(busyBtn).toHaveAttribute('aria-disabled', 'true');
    await user.click(busyBtn);
    expect(gradeWritingMock).toHaveBeenCalledTimes(1);

    resolveGrade(RESPONSE);
    expect(await screen.findByText('63')).toBeInTheDocument();
  });

  it('surfaces a 429 with the structured retryAfter and preserves the text', async () => {
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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rate-limited/);
    expect(alert).toHaveTextContent(/42 seconds/);
    // The learner's text survives the failure and Grade is the retry.
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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't score this sample/);
    expect(textarea).toHaveValue('안녕하세요');
  });

  it('switches rubric via the radiogroup, draws that rubric randomly, and preserves the draft', async () => {
    gradeWritingMock.mockResolvedValueOnce({
      ...RESPONSE,
      result: { ...RESPONSE.result, rubric: 'topik_ii_54' },
    });
    const user = userEvent.setup();
    await renderLoaded();

    // Rubric choice is a WAI-ARIA radiogroup, drafted text survives the switch.
    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '초안',
    );
    const q54 = screen.getByRole('radio', { name: 'Q54 · 600–700자' });
    await user.click(q54);
    expect(await screen.findByText(/인공지능의 발달/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledWith(
      'topik_ii_54',
      expect.any(AbortSignal),
    );
    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    expect(textarea).toHaveValue('초안');

    await user.type(textarea, ' 인공지능은 편리합니다.');
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

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
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );
    await screen.findByText('63');

    await user.click(
      screen.getByRole('button', { name: '고쳐서 다시 채점 · Revise & regrade' }),
    );

    expect(screen.queryByText('63')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('안녕하세요');
    expect(textarea).not.toHaveAttribute('readonly');
  });

  it('"New prompt" redraws randomly and clears the sheet when a DIFFERENT task lands', async () => {
    fetchRandomMock
      .mockResolvedValueOnce(Q53_PROMPT)
      .mockResolvedValueOnce(Q53_PROMPT_B);
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '새 과제 · New prompt' }));

    // A second RANDOM draw — not a client-side rotation over a cached list.
    expect(await screen.findByText(/인터넷 쇼핑/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toHaveValue('');
  });

  it('keeps the draft when the redraw returns the SAME prompt (F-UP-017)', async () => {
    // Uniform random over a small pool can repeat — repeating must never
    // silently destroy the learner's draft for an unchanged task.
    fetchRandomMock
      .mockResolvedValueOnce(Q53_PROMPT)
      .mockResolvedValueOnce(Q53_PROMPT);
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: '새 과제 · New prompt' }));

    expect(await screen.findByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toHaveValue('안녕하세요');
  });

  it('F-073: generates a topic on-page, adopts it via "Write this topic", and grades WITHOUT a promptId', async () => {
    generateMock.mockResolvedValue(GENERATED_TOPIK);
    gradeWritingMock.mockResolvedValueOnce({
      ...RESPONSE,
      result: { ...RESPONSE.result, rubric: 'topik_ii_54' },
    });
    const user = userEvent.setup();
    await renderLoaded();

    // The shared generator is on the page with its TOPIK/general radiogroup.
    expect(screen.getByRole('radio', { name: /TOPIK-style/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Free write/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Generate topic/ }));
    await user.click(
      await screen.findByRole('button', { name: /Write this topic/ }),
    );

    // The topic is now the ACTIVE task: prompt text on the compose sheet
    // (plus the generator's own result copy), generated marker, honest
    // Q54 header (the topic's echoed rubric), and focus in the sheet.
    expect(screen.getAllByText(/환경 보호/).length).toBeGreaterThanOrEqual(2);
    // Bilingual renders each half twice (visible + sr-only) — AllBy queries.
    expect(screen.getAllByText(/만든 주제/).length).toBeGreaterThan(0);
    expect(screen.getByText('주장하는 글')).toBeInTheDocument();
    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    expect(textarea).toHaveFocus();

    await user.type(textarea, '환경을 지켜야 합니다.');
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body] = gradeWritingMock.mock.calls[0]!;
    // Generated topics have no writing_prompts row — promptId must be ABSENT
    // (the grade route's schema is .strict(); a null/undefined key is a 400).
    expect(body).toEqual({
      prompt: GENERATED_TOPIK.promptKr,
      sample: '환경을 지켜야 합니다.',
      rubric: 'topik_ii_54',
    });
    expect(body).not.toHaveProperty('promptId');
    expect(await screen.findByText('63')).toBeInTheDocument();
  });

  it('F-101: adopts a Today-carried generated topic from location.state without a bank draw', async () => {
    gradeWritingMock.mockResolvedValueOnce({
      ...RESPONSE,
      result: { ...RESPONSE.result, rubric: 'topik_ii_54' },
    });
    const user = userEvent.setup();
    renderWriting({ generatedTopic: GENERATED_GENERAL });

    // The carried topic IS the task — no random bank draw happened.
    expect(await screen.findByText(/기억에 남는 여행/)).toBeInTheDocument();
    expect(fetchRandomMock).not.toHaveBeenCalled();
    // Honest free-write header + the Q54-rubric grading note (the rubric
    // taxonomy widen is deferred — F-107). '자유 주제' also appears on the
    // generator's mode radio and in Bilingual's sr-only halves — AllBy.
    expect(screen.getAllByText('자유 주제').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Free write').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/graded with the TOPIK Q54 essay rubric/),
    ).toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '작년 여행이 기억에 남습니다.',
    );
    await user.click(
      screen.getByRole('button', { name: '채점하기 · Grade my writing' }),
    );

    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body] = gradeWritingMock.mock.calls[0]!;
    expect(body).toEqual({
      prompt: GENERATED_GENERAL.promptKr,
      sample: '작년 여행이 기억에 남습니다.',
      rubric: 'topik_ii_54',
    });
  });

  it('F-101: a malformed location.state payload falls back to the bank draw', async () => {
    renderWriting({ generatedTopic: { promptKr: 123, mode: 'nonsense' } });

    // The runtime narrowing rejected the payload — normal bank flow.
    expect(await screen.findByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledWith(
      'topik_ii_53',
      expect.any(AbortSignal),
    );
  });

  it('returning to bank tasks from a generated topic via the rubric radios redraws', async () => {
    const user = userEvent.setup();
    renderWriting({ generatedTopic: GENERATED_TOPIK });
    await screen.findByText(/환경 보호/);
    expect(fetchRandomMock).not.toHaveBeenCalled();
    // Generated tasks draw fresh topics from the generator — no bank redraw
    // button on the footer.
    expect(
      screen.queryByRole('button', { name: '새 과제 · New prompt' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Q53 · 200–300자' }));
    expect(await screen.findByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledWith(
      'topik_ii_53',
      expect.any(AbortSignal),
    );
  });

  it('F-074: the Responses tab is an honest stub with no fabricated attempts', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: '내 답안 · My responses' }));

    // Honest pending copy (browsing needs GET /writing/attempts — F-106).
    expect(screen.getByText(/coming soon/)).toBeInTheDocument();
    // The write surface is swapped out; nothing pretends to be a past attempt.
    expect(
      screen.queryByRole('textbox', { name: /Your writing in Korean/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/63/)).not.toBeInTheDocument();
  });

  it('preserves the draft across a Responses tab round-trip without refetching', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('tab', { name: '내 답안 · My responses' }));
    await user.click(screen.getByRole('tab', { name: '쓰기 · Write' }));

    // Compose state lives above the re-keyed tab panels — text and task both
    // survive, and no extra random draw was spent.
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toHaveValue('안녕하세요');
    expect(screen.getByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(fetchRandomMock).toHaveBeenCalledTimes(1);
  });

  it('renders the F-024 back control', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });
});
