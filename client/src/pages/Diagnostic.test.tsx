/**
 * Diagnostic (Pass 5 — server-graded) — covers:
 *   - loading → mode resolution (intro vs results from the latest snapshot)
 *   - intro → taking start (startDiagnostic)
 *   - server-graded answer reveal (no client-held answer; reveal comes from
 *     the /answer response's `correctAnswer`)
 *   - advance to the next item, then finish → done → results with the
 *     server-returned snapshot
 *   - a11y: progressbar ARIA, reveal block ids
 *   - error path: a failed start surfaces an ErrorCard
 *
 * `useEndpointOrMock` is module-mocked so the snapshot fetch is deterministic.
 * The diagnostic service is module-mocked so the Taking flow's network calls
 * are controlled — this is where we assert the screen never self-grades.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type {
  DiagnosticAnswerResponse,
  DiagnosticLiveItem,
  DiagnosticSnapshot,
  DiagnosticStartResponse,
} from '../types/domain';

interface HookResult<T> {
  data: T | null;
  loading: boolean;
  error: null;
  isMock: boolean;
  refetch?: () => void;
}

const hookState: { snapshot: HookResult<DiagnosticSnapshot> } = {
  snapshot: { data: null, loading: true, error: null, isMock: false },
};

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    if (key === 'diagnostic.latest') return hookState.snapshot;
    throw new Error(`unexpected key: ${key}`);
  },
}));

// Service mock — every Taking-flow call routes through here. `vi.hoisted` is
// required because `vi.mock` is hoisted above imports; the shared mock fns must
// be hoisted too, otherwise the factory hits TDZ (the Today.test.tsx pattern).
const svc = vi.hoisted(() => ({
  startDiagnostic: vi.fn<() => Promise<DiagnosticStartResponse>>(),
  answerDiagnostic:
    vi.fn<(runId: number, body: unknown) => Promise<DiagnosticAnswerResponse>>(),
  finishDiagnostic: vi.fn<() => Promise<{ snapshot: DiagnosticSnapshot }>>(),
}));

vi.mock('../services/diagnostic', () => ({
  startDiagnostic: () => svc.startDiagnostic(),
  answerDiagnostic: (runId: number, body: unknown) =>
    svc.answerDiagnostic(runId, body),
  finishDiagnostic: () => svc.finishDiagnostic(),
  // Never actually invoked — useEndpointOrMock is mocked and ignores realFn —
  // but stubbed so the module's named export exists for the screen's import.
  fetchLatestSnapshot: () => Promise.reject(new Error('not used in tests')),
}));

const { startDiagnostic, answerDiagnostic, finishDiagnostic } = svc;

import Diagnostic from './Diagnostic';

const EMPTY_SNAPSHOT: DiagnosticSnapshot = {
  dimensions: [],
  references: [{ id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 }],
  defaultRef: 'L4',
  goals: [],
};

const POPULATED_SNAPSHOT: DiagnosticSnapshot = {
  dimensions: [
    { key: 'reading', label: 'Reading', kr: '읽기', score: 62, note: 'OK' },
    { key: 'grammar', label: 'Grammar', kr: '문법', score: 44, note: 'Gap' },
  ],
  references: [
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
    { id: 'native', label: 'Native', kr: '원어민', value: 100 },
  ],
  defaultRef: 'L4',
  goals: ['Drill -더라도 daily.'],
};

const ITEM_1: DiagnosticLiveItem = {
  responseId: 101,
  ordinal: 1,
  section: 'vocab',
  level: 'L3',
  kind: 'cloze',
  prompt: '회사에서 새로운 정책을 ( ) 했다.',
  choices: [
    { id: 'a', kr: '발표', en: 'announce' },
    { id: 'b', kr: '발견', en: 'discover' },
  ],
};

const ITEM_2: DiagnosticLiveItem = {
  responseId: 102,
  ordinal: 2,
  section: 'grammar',
  level: 'L4',
  kind: 'pattern',
  prompt: '비가 ( ) 우산을 가지고 가세요.',
  choices: [
    { id: 'a', kr: '오니까', en: 'because it rains' },
    { id: 'b', kr: '올 텐데', en: 'will likely rain' },
  ],
};

function renderWithRouter(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Diagnostic />
    </MemoryRouter>,
  );
}

describe('Diagnostic', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
    };
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    finishDiagnostic.mockReset();
  });

  it('shows the loading state until the snapshot fetch resolves', () => {
    renderWithRouter();
    expect(screen.getByRole('status')).toHaveTextContent(/loading diagnostic/i);
  });

  it('lands on Intro on a fresh boot (empty snapshot dimensions)', () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    renderWithRouter();
    const headings = screen.getAllByText('진단평가');
    expect(headings.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /begin test/i }),
    ).toBeInTheDocument();
    // Results-only chrome is NOT in the DOM yet.
    expect(screen.queryByText('Skills snapshot')).not.toBeInTheDocument();
  });

  it('lands on Results when the snapshot has prior dimensions', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    renderWithRouter();
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /begin today/i }),
    ).toBeInTheDocument();
  });

  it('walks intro → taking → reveal → advance → finish → done → results, server-graded', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 7,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // Item 1 graded correct, next is item 2.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });
    // Item 2 graded wrong, no next → finish.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: false, correctAnswer: 'b', explain: '-(으)ㄹ 텐데 = conjecture.' },
      next: null,
      progress: { ordinal: 2, total: 2 },
    });
    finishDiagnostic.mockResolvedValue({ snapshot: POPULATED_SNAPSHOT });

    const user = userEvent.setup();
    renderWithRouter();

    // ── intro ──
    await user.click(screen.getByRole('button', { name: /begin test/i }));

    // ── taking · item 1 (after startDiagnostic resolves) ──
    expect(
      await screen.findByText('회사에서 새로운 정책을 ( ) 했다.'),
    ).toBeInTheDocument();
    expect(startDiagnostic).toHaveBeenCalledTimes(1);

    // Progressbar ARIA contract is intact.
    const bar = screen.getByRole('progressbar', { name: /diagnostic progress/i });
    expect(bar).toHaveAttribute('aria-valuemax', '2');

    // Before the reveal lands, NO choice is marked correct — the client holds
    // no answer key. Pick choice a and submit.
    const item1Choices = screen.getAllByRole('radio');
    await user.click(item1Choices[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // ── reveal · item 1 (from the server's `result`, not client grading) ──
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('발표하다 = announce.')).toBeInTheDocument();
    expect(answerDiagnostic).toHaveBeenCalledWith(7, {
      responseId: 101,
      picked: 'a',
      timeMs: expect.any(Number),
    });

    // ── advance → item 2 ──
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(
      await screen.findByText('비가 ( ) 우산을 가지고 가세요.'),
    ).toBeInTheDocument();

    // Pick the wrong choice; the reveal still comes from the server.
    const item2Choices = screen.getAllByRole('radio');
    await user.click(item2Choices[0]); // 'a' — server says correct is 'b'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(await screen.findByText('Not quite')).toBeInTheDocument();

    // ── finish (next was null) → done ──
    await user.click(screen.getByRole('button', { name: /see results/i }));
    expect(finishDiagnostic).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Diagnostic complete')).toBeInTheDocument();

    // ── done → results (renders the server-returned snapshot) ──
    await user.click(screen.getByRole('button', { name: /see gap map/i }));
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
    // The fresh snapshot carries a grammar dimension.
    expect(screen.getByText('문법')).toBeInTheDocument();
  });

  it('skips an item by submitting picked: null', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 9,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: false, correctAnswer: 'a', explain: 'x' },
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    await waitFor(() => {
      expect(answerDiagnostic).toHaveBeenCalledWith(9, {
        responseId: 101,
        picked: null,
        timeMs: expect.any(Number),
      });
    });
  });

  it('recovers from a mid-run answer failure via the inline Retry control', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 11,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // First answer attempt fails (network), second (the retry) succeeds. This
    // exercises `retry`'s mid-run re-grade branch — dead before the inline
    // Retry button was wired in.
    answerDiagnostic
      .mockRejectedValueOnce(new Error('answer network down'))
      .mockResolvedValueOnce({
        result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
        next: ITEM_2,
        progress: { ordinal: 2, total: 2 },
      });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    // Pick + submit → the first answer call rejects → inline error + Retry.
    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not submit your answer/i);

    // Retry replays the grade with the same picked choice; the reveal now lands.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(answerDiagnostic).toHaveBeenCalledTimes(2);
    expect(answerDiagnostic).toHaveBeenLastCalledWith(11, {
      responseId: 101,
      picked: 'a',
      timeMs: expect.any(Number),
    });
  });

  it('surfaces an ErrorCard when starting the run fails', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));

    expect(
      await screen.findByText(/could not start the diagnostic/i),
    ).toBeInTheDocument();
  });
});
