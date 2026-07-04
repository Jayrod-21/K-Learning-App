/**
 * Writing page — compose → grade → reveal over a mocked `services/writing`.
 *
 * The service module is mocked so the grade leg resolves/rejects on command;
 * assertions cover the outgoing body (prompt + sample + rubric — the route's
 * schema is .strict(), so this IS the wire contract), the reveal render, and
 * the failure-safe paths (429 with retryAfter, generic failure preserving the
 * learner's text).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { GradeWritingResponse } from '../types/domain';

vi.mock('../services/writing', () => ({
  gradeWriting: vi.fn(),
}));

// Import after the mock so the page wires to it.
import Writing from './Writing';
import { gradeWriting } from '../services/writing';

const gradeWritingMock = vi.mocked(gradeWriting);

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

beforeEach(() => {
  gradeWritingMock.mockReset();
});

describe('Writing', () => {
  it('renders the title, a task prompt, and the compose surface', () => {
    render(<Writing />);

    expect(screen.getByText('쓰기 · Writing')).toBeInTheDocument();
    // Default rubric is Q53 — its first curated prompt shows.
    expect(screen.getByText(/스트레스 해소 방법/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toBeInTheDocument();
  });

  it('disables Grade until the learner has written something', async () => {
    const user = userEvent.setup();
    render(<Writing />);

    const submit = screen.getByRole('button', { name: 'Grade my writing' });
    expect(submit).toBeDisabled();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    expect(submit).toBeEnabled();
  });

  it('submits the current prompt + trimmed sample + rubric and renders the grade', async () => {
    gradeWritingMock.mockResolvedValueOnce(RESPONSE);
    const user = userEvent.setup();
    render(<Writing />);

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      SAMPLE,
    );
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));

    // Outgoing body — the .strict() wire contract: exactly these three fields,
    // with the on-screen task prompt and the tab's rubric.
    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body, signal] = gradeWritingMock.mock.calls[0]!;
    expect(body).toEqual({
      prompt:
        '여러분은 스트레스를 받을 때 어떻게 해소합니까? 자신의 스트레스 해소 방법과 그 방법의 좋은 점을 200~300자로 쓰십시오.',
      sample: SAMPLE,
      rubric: 'topik_ii_53',
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
    render(<Writing />);

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));

    expect(screen.getByRole('status')).toHaveTextContent(/Grading your writing/);

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
    render(<Writing />);

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rate-limited/);
    expect(alert).toHaveTextContent(/42 seconds/);
    // The learner's text survives the failure and Submit is the retry.
    expect(textarea).toHaveValue('안녕하세요');
    expect(
      screen.getByRole('button', { name: 'Grade my writing' }),
    ).toBeEnabled();
  });

  it('surfaces a generic upstream failure without blanking the compose sheet', async () => {
    gradeWritingMock.mockRejectedValueOnce(
      new ApiError('upstream', { status: 502, code: 'upstream_error' }),
    );
    const user = userEvent.setup();
    render(<Writing />);

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't score this sample/);
    expect(textarea).toHaveValue('안녕하세요');
  });

  it('switches rubric tabs and submits with the other rubric + its prompt', async () => {
    gradeWritingMock.mockResolvedValueOnce({
      ...RESPONSE,
      result: { ...RESPONSE.result, rubric: 'topik_ii_54' },
    });
    const user = userEvent.setup();
    render(<Writing />);

    await user.click(screen.getByRole('button', { name: 'Q54 · 600–700자' }));
    expect(screen.getByText(/인공지능의 발달/)).toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '인공지능은 편리합니다.',
    );
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));

    await waitFor(() => {
      expect(gradeWritingMock).toHaveBeenCalledTimes(1);
    });
    const [body] = gradeWritingMock.mock.calls[0]!;
    expect(body.rubric).toBe('topik_ii_54');
    expect(body.prompt).toContain('인공지능');
  });

  it('"Revise & regrade" returns to composing with the text intact', async () => {
    gradeWritingMock.mockResolvedValueOnce(RESPONSE);
    const user = userEvent.setup();
    render(<Writing />);

    const textarea = screen.getByRole('textbox', {
      name: /Your writing in Korean/,
    });
    await user.type(textarea, '안녕하세요');
    await user.click(screen.getByRole('button', { name: 'Grade my writing' }));
    await screen.findByText('63');

    await user.click(screen.getByRole('button', { name: 'Revise & regrade' }));

    expect(screen.queryByText('63')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('안녕하세요');
    expect(textarea).toBeEnabled();
  });

  it('"New prompt" rotates the task and clears the sheet', async () => {
    const user = userEvent.setup();
    render(<Writing />);

    await user.type(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
      '안녕하세요',
    );
    await user.click(screen.getByRole('button', { name: 'New prompt' }));

    // Second curated Q53 prompt is now on screen; the draft is cleared.
    expect(screen.getByText(/인터넷 쇼핑/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /Your writing in Korean/ }),
    ).toHaveValue('');
  });
});
