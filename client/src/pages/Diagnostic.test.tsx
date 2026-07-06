/**
 * Diagnostic (Pass 5 — server-graded) — covers:
 *   - loading → mode resolution (intro vs results from the latest snapshot)
 *   - intro → taking start (startDiagnostic)
 *   - server-graded answer reveal (no client-held answer; reveal comes from
 *     the /answer response's `correctAnswer`)
 *   - B-006 decoupling: the reveal renders as soon as `/answer` resolves,
 *     even while the `/next` prefetch is still in flight — grading is never
 *     blocked on item generation
 *   - advance to the prefetched next item, then finish → done → results with
 *     the server-returned snapshot
 *   - a11y: progressbar ARIA, reveal block ids
 *   - error path: a failed start surfaces an ErrorCard
 *
 * `useEndpointOrMock` is module-mocked so the snapshot fetch is deterministic.
 * The diagnostic service is module-mocked so the Taking flow's network calls
 * are controlled — this is where we assert the screen never self-grades.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type {
  DiagnosticAnswerResponse,
  DiagnosticLiveItem,
  DiagnosticNextResponse,
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

const refetchSpy = vi.fn();

const hookState: { snapshot: HookResult<DiagnosticSnapshot> } = {
  snapshot: {
    data: null,
    loading: true,
    error: null,
    isMock: false,
    refetch: refetchSpy,
  },
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
  nextDiagnostic: vi.fn<(runId: number) => Promise<DiagnosticNextResponse>>(),
  finishDiagnostic: vi.fn<() => Promise<{ snapshot: DiagnosticSnapshot }>>(),
}));

vi.mock('../services/diagnostic', () => ({
  startDiagnostic: () => svc.startDiagnostic(),
  answerDiagnostic: (runId: number, body: unknown) =>
    svc.answerDiagnostic(runId, body),
  nextDiagnostic: (runId: number) => svc.nextDiagnostic(runId),
  finishDiagnostic: () => svc.finishDiagnostic(),
  // Never actually invoked — useEndpointOrMock is mocked and ignores realFn —
  // but stubbed so the module's named export exists for the screen's import.
  fetchLatestSnapshot: () => Promise.reject(new Error('not used in tests')),
}));

const { startDiagnostic, answerDiagnostic, nextDiagnostic, finishDiagnostic } = svc;

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
      <ToastProvider>
        <Diagnostic />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Lands at `/chat` after an "Ask about this" click (F-020) and prints the
 * router state the navigation carried, so a test can assert the actual seed
 * payload (the Mistakes.test.tsx probe pattern).
 */
function ChatSeedProbe(): JSX.Element {
  const location = useLocation();
  const state = location.state as { seedText?: string; mode?: string } | null;
  return (
    <div data-testid="chat-seed">
      {state?.seedText ?? 'no-seed'}
      {state?.mode !== undefined ? ` mode=${state.mode}` : ''}
    </div>
  );
}

/** Render Diagnostic with a `/chat` probe route so seed navigations land. */
function renderWithChatProbe(): void {
  render(
    <MemoryRouter initialEntries={['/diagnostic']}>
      <ToastProvider>
        <Routes>
          <Route path="/diagnostic" element={<Diagnostic />} />
          <Route path="/chat" element={<ChatSeedProbe />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Boot a fresh single-item run for the F-020 seed tests: intro → item, then
 * grade with `result` (done:true, so no /next prefetch to satisfy). Pass the
 * choice index to pick, or null to Skip.
 */
async function driveToReveal(
  user: ReturnType<typeof userEvent.setup>,
  item: DiagnosticLiveItem,
  result: { correct: boolean; correctAnswer: string; explain: string },
  pickIndex: number | null,
): Promise<void> {
  hookState.snapshot = {
    data: EMPTY_SNAPSHOT,
    loading: false,
    error: null,
    isMock: true,
  };
  startDiagnostic.mockResolvedValue({
    runId: 31,
    item,
    progress: { ordinal: 1, total: 1 },
  });
  answerDiagnostic.mockResolvedValueOnce({
    result,
    done: true,
    progress: { ordinal: 1, total: 1 },
  });

  renderWithChatProbe();
  await user.click(screen.getByRole('button', { name: /begin test/i }));
  await screen.findByText(item.prompt);
  if (pickIndex !== null) {
    await user.click(screen.getAllByRole('radio')[pickIndex]!);
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
  } else {
    await user.click(screen.getByRole('button', { name: /^skip$/i }));
  }
  await screen.findByRole('button', { name: 'Ask about this' });
}

describe('Diagnostic', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    refetchSpy.mockReset();
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    nextDiagnostic.mockReset();
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
    // Item 1 graded correct; the run continues, so the screen prefetches
    // item 2 via /next during the reveal dwell.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    nextDiagnostic.mockResolvedValueOnce({
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });
    // Item 2 graded wrong; done → finish (no /next call).
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: false, correctAnswer: 'b', explain: '-(으)ㄹ 텐데 = conjecture.' },
      done: true,
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
    // The next item was prefetched during the reveal dwell (B-006).
    expect(nextDiagnostic).toHaveBeenCalledWith(7);

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

    // F-020: the reveal carries the "Ask about this" Chat handoff.
    expect(
      screen.getByRole('button', { name: 'Ask about this' }),
    ).toBeInTheDocument();

    // done:true → no second /next prefetch was issued.
    expect(nextDiagnostic).toHaveBeenCalledTimes(1);

    // ── finish (run done) → done ──
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
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    // The reveal triggers a background /next prefetch — give it a resolution.
    nextDiagnostic.mockResolvedValueOnce({
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

  it('F-020: a wrong pick seeds Chat with the resolved correct/pick texts and the explanation', async () => {
    // The server keys the reveal by choice ID ('a') — the seed must resolve
    // both ids to their display text on the RIGHT labels: 'a' (발표) is
    // correct, 'b' (발견) the wrong pick, so a swap or a raw id fails here.
    const user = userEvent.setup();
    await driveToReveal(
      user,
      ITEM_1,
      { correct: false, correctAnswer: 'a', explain: '발표하다 = announce.' },
      1, // pick 'b' — wrong
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('회사에서 새로운 정책을 ( ) 했다.');
    expect(probe.textContent).toContain('Correct answer: 발표');
    expect(probe.textContent).toContain('My answer: 발견 (incorrect)');
    expect(probe.textContent).toContain('Why: 발표하다 = announce.');
    expect(probe.textContent).toContain('mode=topik_prep');
  });

  it('F-020: an unresolvable correct-choice id OMITS the "Correct answer" line (no bare id)', async () => {
    // Corrupt data: the reveal names an id absent from the served choices.
    // Seeding "Correct answer: z" would be meaningless to the learner (the UI
    // labels choices ①②③④) and to the AI — the line must drop instead.
    const user = userEvent.setup();
    await driveToReveal(
      user,
      ITEM_1,
      { correct: false, correctAnswer: 'z', explain: '해설입니다.' },
      0,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).not.toContain('Correct answer');
    expect(probe.textContent).not.toContain(': z');
    // The rest of the seed is still worth asking about.
    expect(probe.textContent).toContain('회사에서 새로운 정책을 ( ) 했다.');
    expect(probe.textContent).toContain('Why: 해설입니다.');
  });

  it('F-020: a listening item seeds its audio transcript as the passage context', async () => {
    // Without the transcript the AI receives a stem like "무엇에 대한
    // 이야기입니까?" with no idea what was said.
    const listening: DiagnosticLiveItem = {
      ...ITEM_1,
      section: 'listening',
      prompt: '무엇에 대한 이야기입니까?',
      audio: { duration: 12, transcript: '내일은 전국에 비가 오겠습니다.' },
    };
    const user = userEvent.setup();
    await driveToReveal(
      user,
      listening,
      { correct: false, correctAnswer: 'a', explain: '날씨 예보입니다.' },
      1,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain(
      '지문: 내일은 전국에 비가 오겠습니다.',
    );
  });

  it('F-020: an underline item seeds the passage with the underlined span marked', async () => {
    // A "밑줄 친 부분…" question is unanswerable without knowing WHICH span
    // was underlined — the seed marks it with ⟨ ⟩.
    const underlined: DiagnosticLiveItem = {
      ...ITEM_1,
      prompt: '밑줄 친 부분과 의미가 비슷한 것을 고르십시오.',
      passage: '그는 하루가 멀다 하고 도서관에 갔다.',
      underline: '하루가 멀다 하고',
    };
    const user = userEvent.setup();
    await driveToReveal(
      user,
      underlined,
      { correct: false, correctAnswer: 'a', explain: '거의 매일이라는 뜻입니다.' },
      1,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain(
      '지문: 그는 ⟨하루가 멀다 하고⟩ 도서관에 갔다.',
    );
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
        done: false,
        progress: { ordinal: 1, total: 2 },
      });
    // The successful retry starts the /next prefetch — give it a resolution.
    nextDiagnostic.mockResolvedValueOnce({
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

  it('renders the reveal immediately while the /next prefetch is still in flight (B-006)', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 13,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    // A /next that NEVER resolves until we say so — stands in for the
    // multi-second Claude generation. Pre-fix, this latency sat inside the
    // /answer request and withheld the reveal; now the reveal must render
    // while this promise is still pending.
    let resolveNext!: (value: DiagnosticNextResponse) => void;
    nextDiagnostic.mockImplementationOnce(
      () =>
        new Promise<DiagnosticNextResponse>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // The reveal is on screen although the next item hasn't been generated.
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('발표하다 = announce.')).toBeInTheDocument();
    expect(nextDiagnostic).toHaveBeenCalledTimes(1);

    // Advancing before the prefetch lands shows a busy Next button, not a
    // freeze of the reveal.
    await user.click(screen.getByRole('button', { name: /loading|next/i }));
    expect(
      screen.getByRole('button', { name: /loading/i }),
    ).toHaveAttribute('aria-busy', 'true');

    // The generation completes → the awaited advance renders item 2.
    await act(async () => {
      resolveNext({ next: ITEM_2, progress: { ordinal: 2, total: 2 } });
    });
    expect(
      await screen.findByText('비가 ( ) 우산을 가지고 가세요.'),
    ).toBeInTheDocument();
  });

  it('finishes the run when the /next prefetch reports it over early (next:null)', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 15,
      item: ITEM_1,
      progress: { ordinal: 1, total: 8 },
    });
    // Not the last scheduled slot (done:false), but every remaining pool is
    // empty server-side — the prefetch answers `next: null`.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: 'x' },
      done: false,
      progress: { ordinal: 1, total: 8 },
    });
    nextDiagnostic.mockResolvedValueOnce({
      next: null,
      progress: { ordinal: 1, total: 8 },
    });
    finishDiagnostic.mockResolvedValue({ snapshot: POPULATED_SNAPSHOT });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(await screen.findByText('Correct')).toBeInTheDocument();

    // The resolved null prefetch flips the footer to the last-item state.
    expect(await screen.findByText('Last item')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see results/i }));
    expect(finishDiagnostic).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Diagnostic complete')).toBeInTheDocument();
  });

  it('auto-resyncs on a 409 answer conflict instead of dead-ending on Try again (E-DG-409)', async () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    startDiagnostic.mockResolvedValue({
      runId: 21,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // The server reports the answer was already recorded (double-submit / lost
    // success). The client must NOT surface a re-gradeable "Try again".
    answerDiagnostic.mockRejectedValue(
      new ApiError('responseId does not match the current item', {
        status: 409,
        code: 'conflict',
      }),
    );

    const user = userEvent.setup();
    renderWithRouter();
    // A prior snapshot exists, so the retake CTA on results enters the run.
    await user.click(screen.getByRole('button', { name: /re-test diagnostic/i }));
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // Resync: the latest-snapshot refetch fires, the Taking flow leaves for the
    // results view (a prior snapshot existed), and the toast announces it. There
    // is NO "Try again" dead-end and NO lingering submit error.
    await waitFor(() => {
      expect(refetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/answer already recorded — continuing/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/could not submit your answer/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
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
