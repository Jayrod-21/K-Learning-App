/**
 * Topik screen (Study mode) — covers loading → draw, stepping through the draw,
 * submit→reveal→next (correct answer + explanation on BOTH verdicts in the
 * live per-item reveal — unchanged), the non-blocking `recordTopikAnswer` call
 * whose response backfills a missing inline explanation, image-item
 * description rendering, and the results/grade summary the draw lands on
 * (F-008: shares `TopikResults` with Mock mode; F-009: the SUMMARY's
 * per-item explanation is gated to misses only, unlike the live reveal above).
 *
 * `useEndpointOrMock` is module-mocked so the test owns the resolved draw and
 * `refetch` directly; `services/topik` is mocked so the answer write is
 * observable and its failure mode is exercised without a server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type { TopikAnswerResult, TopikItem } from '../types/domain';
import type { AttemptHistoryResult } from '../services/topik';

/** Shape of `useEndpointOrMock`'s return value, for the per-key mock states below. */
interface HookResult<T> {
  data: T | null;
  loading: boolean;
  error: { message: string } | null;
  isMock: boolean;
  refetch: () => void;
}

// Hoisted state the mocked hook reads from — the Study draw's call site.
const hookState: { current: HookResult<TopikItem[]> } = {
  current: {
    data: null,
    loading: true,
    error: null,
    isMock: false,
    refetch: vi.fn(),
  },
};

// F-078/F-104: the daily-total call site (StudyMode) — defaults to a ready,
// empty page so existing Study-mode tests (which don't care about the daily
// total) render it as an honest "no mock exams today" line without needing
// a per-test override.
const dailyHookState: { current: HookResult<AttemptHistoryResult> } = {
  current: {
    data: { attempts: [], total: 0 },
    loading: false,
    error: null,
    isMock: false,
    refetch: vi.fn(),
  },
};

// F-082: the "Previous attempts" review call site (AttemptsReview) — same
// default-empty shape; only exercised by tests that navigate to
// `?view=attempts`.
const attemptsReviewHookState: { current: HookResult<AttemptHistoryResult> } = {
  current: {
    data: { attempts: [], total: 0 },
    loading: false,
    error: null,
    isMock: false,
    refetch: vi.fn(),
  },
};

// `Topik.tsx` now makes THREE distinct `useEndpointOrMock` calls (study draw,
// daily total, attempts review) — the mock routes by `key` so each call site
// gets its own state instead of every call sharing one global object.
vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    if (key === 'topik-daily-total') return dailyHookState.current;
    if (key === 'topik-attempts-review') return attemptsReviewHookState.current;
    return hookState.current;
  },
}));

// Service mock — `vi.hoisted` is required because `vi.mock` is hoisted above
// imports; the shared mock fns must be hoisted too or the factory hits TDZ
// (the Diagnostic.test.tsx pattern).
const svc = vi.hoisted(() => ({
  recordTopikAnswer:
    vi.fn<
      (
        itemId: string,
        body: { picked: string; timeMs?: number; mode?: string },
      ) => Promise<TopikAnswerResult>
    >(),
}));

vi.mock('../services/topik', () => ({
  recordTopikAnswer: (
    itemId: string,
    body: { picked: string; timeMs?: number; mode?: string },
  ) => svc.recordTopikAnswer(itemId, body),
  // Never actually invoked — useEndpointOrMock is mocked and ignores realFn —
  // but stubbed so the module's named export exists for the screen's import.
  fetchStudyDraw: () => Promise.reject(new Error('not used in tests')),
  fetchAttemptHistory: () => Promise.reject(new Error('not used in tests')),
  // Mock-mode services exist for MockMode's import; never called in these
  // Study-mode tests (no section is started).
  fetchMockTest: () => Promise.reject(new Error('not used in tests')),
  submitMockTest: () => Promise.reject(new Error('not used in tests')),
  fetchAvailableTests: () => Promise.reject(new Error('not used in tests')),
  // MockMode fetches any resumable attempt on mount (F-007) — no attempt here,
  // so no resume banner; saves/clears are best-effort no-ops.
  fetchAttempt: () => Promise.resolve(null),
  saveAttempt: () => Promise.resolve(),
  clearAttempt: () => Promise.resolve(),
}));

const { recordTopikAnswer } = svc;

import Topik from './Topik';

const ITEM_A: TopikItem = {
  id: '201',
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
  explanation: 'Choice B summarises the passage faithfully.',
};

// Second item ships an empty explanation — the reveal must fall back to the
// answer response's explanation (the live pool has no inline explanations).
const ITEM_B: TopikItem = {
  id: '202',
  section: '듣기',
  number: 44,
  level: 3,
  prompt: '여자가 다음에 할 행동으로 알맞은 것은?',
  options: [
    { id: 'a', kr: '하나', en: 'One', correct: true },
    { id: 'b', kr: '둘', en: 'Two', correct: false },
  ],
  explanation: '',
};

// Image-dependent item (has_image, no asset): the bracketed description in the
// prompt must surface in the TopikImageNote block, out of the prompt body.
const ITEM_IMG: TopikItem = {
  id: '203',
  section: '듣기',
  number: 1,
  level: 3,
  prompt:
    '여자: 어디가 아파서 오셨어요?\n[알맞은 그림 고르기: ①진료실 ②접수처 ③병실 ④대기실]',
  options: [
    { id: 'a', kr: '①', en: '', correct: false },
    { id: 'b', kr: '②', en: '', correct: true },
  ],
  explanation: '',
  hasImage: true,
};

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

/** Render Topik with a `/chat` probe route so seed navigations land. */
function renderWithChatProbe(): void {
  render(
    <MemoryRouter initialEntries={['/learn/topik']}>
      <Routes>
        <Route path="/learn/topik" element={<Topik />} />
        <Route path="/chat" element={<ChatSeedProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setDraw(draw: TopikItem[], isMock = true): void {
  hookState.current = {
    data: draw,
    loading: false,
    error: null,
    isMock,
    refetch: hookState.current.refetch,
  };
}

describe('Topik (Study mode)', () => {
  beforeEach(() => {
    recordTopikAnswer.mockReset();
    recordTopikAnswer.mockResolvedValue({
      correct: false,
      correctChoiceId: 'b',
      explanation: 'Choice B summarises the passage faithfully.',
    });
    hookState.current = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    // Reset the two F-104 call sites to their default (ready, empty) state
    // between tests — a test that overrides one (e.g. to assert a populated
    // "Completed exams" list) must not leak into the next.
    dailyHookState.current = {
      data: { attempts: [], total: 0 },
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    attemptsReviewHookState.current = {
      data: { attempts: [], total: 0 },
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
  });

  it('shows the loading state until the draw resolves', () => {
    render(<Topik />, { wrapper: MemoryRouter });
    expect(screen.getByRole('status')).toHaveTextContent('Loading items');
  });

  it('renders the first item, the draw position, and the MockBadge in dev', () => {
    setDraw([ITEM_A, ITEM_B]);
    render(<Topik />, { wrapper: MemoryRouter });
    expect(screen.getByText('이 글의 내용과 같은 것은?')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    // Eyebrow reflects 1-based position within the draw length.
    expect(screen.getByText(/Item 1 \/ 2/)).toBeInTheDocument();
    // MockBadge mounts in dev (import.meta.env.PROD === false in tests).
    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();
  });

  it('does NOT render the MockBadge when the draw is from the real endpoint', () => {
    setDraw([ITEM_A, ITEM_B], false);
    render(<Topik />, { wrapper: MemoryRouter });
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });

  it('P3b: title + mode eyebrow render Korean in both-mode', () => {
    setDraw([ITEM_A, ITEM_B]);
    render(<Topik />, { wrapper: MemoryRouter });
    // Title aligned with nav.ts's headerTitle (모의 · TOPIK).
    expect(
      screen.getByRole('heading', { level: 1, name: '모의 · TOPIK' }),
    ).toBeInTheDocument();
    // Default Study-mode eyebrow renders its Korean half.
    expect(screen.getByText('학습 모드')).toBeInTheDocument();
    expect(screen.getByText('Study mode')).toBeInTheDocument();
    // The draw-position eyebrow is bilingual too.
    expect(screen.getByText(/문제 1 \/ 2/)).toBeInTheDocument();
  });

  it('a WRONG submit reveals the verdict, the correct answer, and the explanation', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    // Pick wrong choice (A) to confirm the "Not quite" branch.
    const choices = screen.getAllByRole('radio');
    await user.click(choices[0]);
    expect(choices[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(screen.getByText('Not quite')).toBeInTheDocument();
    // The reveal names the correct answer in text — a wrong answer is never a
    // bare "Not quite" (the FU where wrong answers gave no information).
    expect(screen.getByText('Correct answer')).toBeInTheDocument();
    expect(screen.getByText(/② 나/)).toBeInTheDocument();
    expect(
      screen.getByText(/Choice B summarises the passage faithfully/),
    ).toBeInTheDocument();
    // Footer flips: Next appears, Submit gone.
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^submit$/i }),
    ).not.toBeInTheDocument();

    // The answer write fired with the item id + picked + mode.
    expect(recordTopikAnswer).toHaveBeenCalledWith('201', {
      picked: 'a',
      mode: 'study',
    });
  });

  it('a CORRECT submit also reveals the correct answer + explanation', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]); // 'b' — the correct pick
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Correct answer')).toBeInTheDocument();
    expect(
      screen.getByText(/Choice B summarises the passage faithfully/),
    ).toBeInTheDocument();
  });

  it('F-020: the reveal offers an "Ask about this" handoff (absent pre-reveal) seeded with the item', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    renderWithChatProbe();

    // No handoff before the reveal — there is nothing to ask about yet.
    expect(
      screen.queryByRole('button', { name: 'Ask about this' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('radio')[0]); // 'a' — a wrong pick
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The revealed card carries the Chat handoff; clicking it hands the
    // item's fields to Chat on the RIGHT labels — 'b' (나) is the correct
    // choice, 'a' (가) the wrong pick, so a swap fails these assertions.
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));
    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('이 글의 내용과 같은 것은?');
    expect(probe.textContent).toContain('Correct answer: 나');
    expect(probe.textContent).toContain('My answer: 가 (incorrect)');
    expect(probe.textContent).toContain(
      'Why: Choice B summarises the passage faithfully.',
    );
    expect(probe.textContent).toContain('mode=topik_prep');
  });

  it('F-020: a CORRECT pick seeds no "My answer" but keeps the explanation the reveal shows', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    renderWithChatProbe();

    await user.click(screen.getAllByRole('radio')[1]); // 'b' — the correct pick
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('Correct answer: 나');
    // No wrong pick to report on a correct answer.
    expect(probe.textContent).not.toContain('My answer');
    // The study reveal shows the explanation on BOTH verdicts (F-009 gates
    // the results list, not the in-flow reveal) — the seed matches the UI.
    expect(probe.textContent).toContain(
      'Why: Choice B summarises the passage faithfully.',
    );
  });

  it('keeps the reveal even when recordTopikAnswer rejects (fire-and-forget)', async () => {
    recordTopikAnswer.mockRejectedValueOnce(new Error('network down'));
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The reveal renders regardless of the analytics failure.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('steps to the next item on Next and clears the prior pick', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Second item now showing; fresh radios, no selection carried over.
    expect(
      screen.getByText('여자가 다음에 할 행동으로 알맞은 것은?'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Item 2 \/ 2/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('backfills the explanation from the answer response when the item has none inline', async () => {
    // The live pool serves items with an empty inline `explanation`; the
    // reveal must instead render the one `POST /topik/:itemId/answer` returns
    // (resolved async — the reveal itself never waits on it).
    recordTopikAnswer.mockResolvedValueOnce({
      correct: true,
      correctChoiceId: 'a',
      explanation: '서버가 채점 응답에 담아 준 해설입니다.',
    });
    setDraw([ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The reveal is instant (verdict + correct answer)…
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText(/① 하나/)).toBeInTheDocument();
    // …and the server explanation fills in once the answer call resolves.
    expect(
      await screen.findByText('서버가 채점 응답에 담아 준 해설입니다.'),
    ).toBeInTheDocument();
    // The reveal block now always has content, so choices point at it.
    expect(
      screen.getByRole('radio', { name: /하나/ }),
    ).toHaveAttribute('aria-describedby');
  });

  it('omits the explanation paragraph when BOTH inline and server explanations are empty', async () => {
    recordTopikAnswer.mockResolvedValueOnce({
      correct: true,
      correctChoiceId: 'a',
      explanation: '',
    });
    setDraw([ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Let the answer response land before asserting on the final reveal.
    await waitFor(() => {
      expect(recordTopikAnswer).toHaveBeenCalledTimes(1);
    });
    // Verdict + correct answer still render; no explanation paragraph.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText(/① 하나/)).toBeInTheDocument();
    expect(document.querySelector('.km-topik__explain')).toBeNull();
  });

  it('never leaks a late answer response onto the NEXT item (stale guard)', async () => {
    // Two empty-inline items so a leaked explanation would be visible. The
    // first item's answer response is withheld until after stepping to the
    // second item, then resolved — its explanation must NOT render there.
    let resolveFirst: (r: TopikAnswerResult) => void = () => {};
    recordTopikAnswer.mockImplementationOnce(
      () =>
        new Promise<TopikAnswerResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const itemB2: TopikItem = { ...ITEM_B, id: '204', number: 45 };
    setDraw([ITEM_B, itemB2]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Second item showing; submit it too (default mock resolves immediately),
    // then let the FIRST item's stale response land.
    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    resolveFirst({
      correct: true,
      correctChoiceId: 'a',
      explanation: 'STALE — belongs to the previous item.',
    });
    await waitFor(() => {
      expect(recordTopikAnswer).toHaveBeenCalledTimes(2);
    });

    expect(
      screen.queryByText(/STALE — belongs to the previous item/),
    ).not.toBeInTheDocument();
  });

  it('features the bracketed image description for a hasImage item', async () => {
    setDraw([ITEM_IMG]);
    render(<Topik />, { wrapper: MemoryRouter });

    // The affordance block renders, carrying the description pulled from the
    // prompt's bracketed segment…
    const note = await screen.findByRole('complementary', {
      name: /image described in text/i,
    });
    expect(note).toHaveTextContent(
      '알맞은 그림 고르기: ①진료실 ②접수처 ③병실 ④대기실',
    );
    // …while the prompt body keeps the transcript, without the brackets.
    expect(screen.getByText('여자: 어디가 아파서 오셨어요?')).toBeInTheDocument();
    expect(
      screen.queryByText(/\[알맞은 그림 고르기/),
    ).not.toBeInTheDocument();
  });

  it('renders the shared reading passage between the prompt and the choices (B-008)', () => {
    // A shared-passage item (fill-blank ㉠ etc.) carries the reading text in
    // `passage` — the screen must render it or the item is unanswerable.
    const passageText =
      '최근 재택근무를 도입하는 회사가 늘고 있다. 재택근무는 출퇴근 시간을 줄여 주지만 동료와의 소통이 어려워질 수 있다.';
    setDraw([{ ...ITEM_A, passage: passageText }]);
    render(<Topik />, { wrapper: MemoryRouter });

    const passage = screen.getByText(passageText);
    expect(passage).toHaveClass('km-topik__passage');
    // The passage sits BEFORE the answer choices in document order — the
    // learner reads the text the question is about, then picks.
    const choices = screen.getByRole('radiogroup', { name: 'Answer choices' });
    expect(
      passage.compareDocumentPosition(choices) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('omits the passage block for a self-contained item', () => {
    setDraw([ITEM_A]); // no `passage` on the item
    const { container } = render(<Topik />, { wrapper: MemoryRouter });
    expect(container.querySelector('.km-topik__passage')).toBeNull();
  });

  it('F-008: lands on the shared results/grade summary after the last item and refetches on New set', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    // ITEM_A's correct choice is 'b' (index 1) — answer it correctly.
    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Past the last item → the SHARED results/grade screen (F-008) — score,
    // band, and correct/total, not the old bare "Set complete" count.
    await waitFor(() => {
      expect(screen.getByText('On track for L5+')).toBeInTheDocument();
    });
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 1 correct/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /new set/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /new set/i }));
    expect(hookState.current.refetch).toHaveBeenCalledTimes(1);
  });

  it('F-008: tallies a skipped Study item as a miss in the results summary', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => {
      expect(screen.getByText(/0 \/ 1 correct/)).toBeInTheDocument();
    });
    expect(screen.getByText(/skipped/i)).toBeInTheDocument();
  });

  it('F-009: shows the review explanation for a Study item the learner missed', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    // Pick the WRONG choice (a) — ITEM_A's correct choice is 'b'.
    await user.click(screen.getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText(/0 \/ 1 correct/)).toBeInTheDocument();
    });
    expect(
      screen.getByText('Choice B summarises the passage faithfully.'),
    ).toBeInTheDocument();
  });

  it('F-009: withholds the review explanation for a Study item answered correctly (fails on pre-fix behavior)', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]); // correct pick 'b'
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 \/ 1 correct/)).toBeInTheDocument();
    });
    // Pre-fix, the review always rendered the explanation regardless of
    // correctness — this must now be absent for a correct pick.
    expect(
      screen.queryByText('Choice B summarises the passage faithfully.'),
    ).not.toBeInTheDocument();
  });

  it('renders an empty-draw state with a New set button on a successful empty draw', async () => {
    // A successful but empty draw (data === [], no error, not loading) must not
    // dead-end on a blank screen — it offers a fresh pull.
    hookState.current = {
      data: [],
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    expect(screen.getByRole('status')).toHaveTextContent(/No items match/);
    const newSet = screen.getByRole('button', { name: /new set/i });
    expect(newSet).toBeInTheDocument();

    // The button refetches via startNewSet's drawKey bump + refetch.
    await user.click(newSet);
    expect(hookState.current.refetch).toHaveBeenCalledTimes(1);
  });

  it('defaults to Study mode and exposes a Study/Mock tablist', () => {
    setDraw([ITEM_A, ITEM_B]);
    render(<Topik />, { wrapper: MemoryRouter });
    // Study tab is selected by default; the study item renders.
    const studyTab = screen.getByRole('tab', { name: /study/i });
    expect(studyTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /mock/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByText('이 글의 내용과 같은 것은?')).toBeInTheDocument();
    // Exactly the four answer choices are radios — the mode switch is a
    // tablist, so it doesn't add stray radios.
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('switches to Mock mode and renders the section select', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('tab', { name: /mock/i }));

    expect(screen.getByRole('tab', { name: /mock/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The Mock section select shows the section cards (Reading enabled).
    // F-079: cards open the exam CHOOSER — the name is "… mock exams".
    expect(
      screen.getByRole('button', { name: /Reading mock exams/i }),
    ).toBeInTheDocument();
    // Study item is gone.
    expect(
      screen.queryByText('이 글의 내용과 같은 것은?'),
    ).not.toBeInTheDocument();
  });

  it('renders an error state with a retry when the draw fails and is empty', () => {
    hookState.current = {
      data: [],
      loading: false,
      error: { message: 'network unreachable' },
      isMock: false,
      refetch: vi.fn(),
    };
    render(<Topik />, { wrapper: MemoryRouter });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn’t load study items/,
    );
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });

  // ── Phase 3C-2 ─────────────────────────────────────────────────────────

  it('B-029: the draw size is selectable beyond 10, with 10 kept as the labelled recommended default', async () => {
    setDraw([ITEM_A, ITEM_B]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    const select = screen.getByRole('combobox', { name: /set size/i });
    // 10 (the server default) is the placeholder = the recommended default…
    expect(select).toHaveValue('');
    expect(
      screen.getByRole('option', { name: /10 · recommended/i }),
    ).toBeInTheDocument();
    // …and larger draws are offered up to the server's max of 50.
    expect(
      screen.getByRole('option', { name: /50 items/ }),
    ).toBeInTheDocument();

    // Step onto item 2, then change the size: a size change is a NEW draw,
    // so the stepping state resets to the first item.
    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText(/Item 2 \/ 2/)).toBeInTheDocument();

    await user.selectOptions(select, '30');
    expect(select).toHaveValue('30');
    expect(screen.getByText(/Item 1 \/ 2/)).toBeInTheDocument();
  });

  it('F-078: tallies session right/wrong from real reveals, survives New set, and renders the real (empty) daily mock total', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    const tally = screen.getByRole('group', { name: 'Session tally' });
    expect(within(tally).getAllByText('맞음 0').length).toBeGreaterThan(0);
    expect(within(tally).getAllByText('틀림 0').length).toBeGreaterThan(0);
    // The daily total is now wired to GET /topik/attempts (F-104) — the
    // mocked hook state defaults to an empty completed-attempt page, so the
    // tile renders the honest empty state, never a fabricated number.
    expect(
      within(tally).getByText(/No mock exams completed today yet/),
    ).toBeInTheDocument();

    // A correct reveal increments the right count.
    await user.click(screen.getAllByRole('radio')[1]); // 'b' — correct
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(within(tally).getAllByText('맞음 1').length).toBeGreaterThan(0);
    expect(within(tally).getAllByText('틀림 0').length).toBeGreaterThan(0);

    // New set keeps the SESSION tally — it counts the session, not the set.
    await user.click(screen.getByRole('button', { name: /new set/i }));
    expect(within(tally).getAllByText('맞음 1').length).toBeGreaterThan(0);
  });

  it("F-078/F-104: renders a real, nonzero daily mock total — summed from TODAY's completed attempts, excluding older ones", () => {
    dailyHookState.current = {
      data: {
        attempts: [
          {
            attemptId: '1',
            section: '읽기',
            sourceTest: 90,
            topikLevel: 'TOPIK II',
            correct: 42,
            totalItems: 50,
            completedAt: new Date().toISOString(), // today
          },
          {
            attemptId: '2',
            section: '듣기',
            sourceTest: 12,
            topikLevel: 'TOPIK I',
            correct: 10,
            totalItems: 30,
            completedAt: '2020-01-01T00:00:00.000Z', // NOT today — excluded
          },
        ],
        total: 2,
      },
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    setDraw([ITEM_A]);
    render(<Topik />, { wrapper: MemoryRouter });

    const tally = screen.getByRole('group', { name: 'Session tally' });
    // 42 right + (50-42)=8 wrong from TODAY's attempt only; yesterday's
    // 10/30 attempt must not bleed into the total.
    expect(within(tally).getByText(/42 right/)).toBeInTheDocument();
    expect(within(tally).getByText(/8 wrong/)).toBeInTheDocument();
    expect(within(tally).queryByText(/10 right/)).not.toBeInTheDocument();
  });

  it('F-078/F-104: daily total shows a loading state, then a retryable error wired to refetch()', async () => {
    const onRetry = vi.fn();
    dailyHookState.current = {
      data: null,
      loading: false,
      error: { message: 'network down' },
      isMock: false,
      refetch: onRetry,
    };
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    const tally = screen.getByRole('group', { name: 'Session tally' });
    expect(
      within(tally).getByText(/Couldn't load today's mock total/),
    ).toBeInTheDocument();
    await user.click(within(tally).getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('F-078: a skipped item tallies as wrong (matches the results grading)', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /skip/i }));

    const tally = screen.getByRole('group', { name: 'Session tally' });
    expect(within(tally).getAllByText('틀림 1').length).toBeGreaterThan(0);
    expect(within(tally).getAllByText('맞음 0').length).toBeGreaterThan(0);
  });

  it('SF-2: the session tally survives a Study→Mock→Study round trip', async () => {
    // `Tabs` re-keys its panel per mode (render-one design), so switching to
    // Mock and back unmounts + remounts StudyMode outright. Before the SF-2
    // fix the tally lived in StudyMode's own state and was zeroed by this.
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]); // 'b' — correct
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(
      within(screen.getByRole('group', { name: 'Session tally' })).getAllByText(
        '맞음 1',
      ).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: /mock/i }));
    await user.click(screen.getByRole('tab', { name: /study/i }));

    expect(
      within(screen.getByRole('group', { name: 'Session tally' })).getAllByText(
        '맞음 1',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('SF-2: the session tally survives a trip to Previous attempts and back', async () => {
    // The `view === 'attempts'` early return in `Topik` replaces the ENTIRE
    // tabbed area — another unmount path StudyMode's own state couldn't
    // survive before the fix.
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getAllByRole('radio')[1]);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(
      within(screen.getByRole('group', { name: 'Session tally' })).getAllByText(
        '맞음 1',
      ).length,
    ).toBeGreaterThan(0);

    await user.click(
      screen.getByRole('link', { name: /Previous attempts/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Back to TOPIK' }));

    expect(
      within(screen.getByRole('group', { name: 'Session tally' })).getAllByText(
        '맞음 1',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('F-082: the landing links to Previous attempts — wired from F-104, honest empty state, jump to Mistakes', async () => {
    setDraw([ITEM_A]);
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('link', { name: /Previous attempts/i }));

    // The nested view replaces the tabbed landing.
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: '지난 시험 · Previous attempts',
      }),
    ).toBeInTheDocument();
    // Wired to GET /topik/attempts (F-104) — the mocked hook state defaults
    // to an empty completed-attempt page, so this renders the honest empty
    // state; nothing is fabricated (no scores/percentages anywhere).
    expect(
      screen.getByText(/You haven't completed a mock exam yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    // The wired part that exists today: the jump into Review → Mistakes.
    expect(
      screen.getByRole('link', { name: /Review your mistakes/i }),
    ).toHaveAttribute('href', '/review/mistakes');

    // F-024: the BackButton returns to the TOPIK landing.
    await user.click(screen.getByRole('button', { name: 'Back to TOPIK' }));
    expect(
      screen.getByRole('heading', { level: 1, name: '모의 · TOPIK' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /study/i })).toBeInTheDocument();
  });

  it('F-082: populates the Completed exams list from real attempt history (grade, correct/total)', async () => {
    setDraw([ITEM_A]);
    attemptsReviewHookState.current = {
      data: {
        attempts: [
          {
            attemptId: '501',
            section: '읽기',
            sourceTest: 91,
            topikLevel: 'TOPIK II',
            correct: 40,
            totalItems: 50,
            completedAt: '2026-06-01T12:00:00.000Z',
          },
        ],
        total: 1,
      },
      loading: false,
      error: null,
      isMock: false,
      refetch: vi.fn(),
    };
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('link', { name: /Previous attempts/i }));

    // The grade renders as a compact Bilingual (shared numerals in both
    // languages), so these numbers legitimately appear more than once in the
    // DOM (visible + sr-only reading) — matches this file's established
    // getAllByText convention for compact bilingual content.
    expect(screen.getAllByText(/40\/50/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/80%/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/haven't completed a mock exam/i)).not.toBeInTheDocument();
  });

  it('F-082: shows a loading state, then a retryable error, for the Completed exams list', async () => {
    setDraw([ITEM_A]);
    const onRetry = vi.fn();
    attemptsReviewHookState.current = {
      data: null,
      loading: false,
      error: { message: 'network down' },
      isMock: false,
      refetch: onRetry,
    };
    const user = userEvent.setup();
    render(<Topik />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('link', { name: /Previous attempts/i }));

    expect(
      screen.getByText(/Couldn't load your completed exams/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('F-082: deep-links straight to the attempts view via ?view=attempts', () => {
    setDraw([ITEM_A]);
    render(
      <MemoryRouter initialEntries={['/learn/topik?view=attempts']}>
        <Topik />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: '지난 시험 · Previous attempts',
      }),
    ).toBeInTheDocument();
    // The study draw is not mounted behind the nested view.
    expect(
      screen.queryByText('이 글의 내용과 같은 것은?'),
    ).not.toBeInTheDocument();
  });
});
