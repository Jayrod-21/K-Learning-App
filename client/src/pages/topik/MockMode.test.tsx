/**
 * MockMode (FU-NF-39) — the answer-stripped, server-graded Mock-Test flow.
 *
 * Covers the phase machine (select → exam → results), that the exam renders
 * answer-stripped items (no `correct` flag present), answering + submit +
 * results render with score + reveals, the countdown timer auto-submitting at
 * 0 (fake timers), that the countdown tracks the wall-clock deadline rather
 * than interval ticks (throttled-tab regression) — including a resumed exam
 * budgeting only its saved remaining (F-007) — the timer's aria-live="off" +
 * coarse sr-only announcements, palette jump, and the disabled Writing card.
 *
 * `services/topik` is mocked so `fetchMockTest` / `submitMockTest` are
 * controllable without a server. `data/mocks/topik` is mocked so the offline
 * fallback loaders never fire a real `mockDelay` timer that would interfere
 * with the fake-timer auto-submit test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ApiError } from '../../services/api';
import type { MockResult, MockTest } from '../../types/domain';

const svc = vi.hoisted(() => ({
  fetchMockTest: vi.fn(),
  submitMockTest: vi.fn(),
  fetchAttempt: vi.fn(),
  saveAttempt: vi.fn(),
  clearAttempt: vi.fn(),
  fetchAvailableTests: vi.fn(),
  fetchAttemptHistory: vi.fn(),
  fetchGeneratedMock: vi.fn(),
  saveGeneratedMockProgress: vi.fn(),
  submitGeneratedMock: vi.fn(),
}));

vi.mock('../../services/topik', () => ({
  fetchMockTest: svc.fetchMockTest,
  submitMockTest: svc.submitMockTest,
  fetchAttempt: svc.fetchAttempt,
  saveAttempt: svc.saveAttempt,
  clearAttempt: svc.clearAttempt,
  fetchAvailableTests: svc.fetchAvailableTests,
  fetchAttemptHistory: svc.fetchAttemptHistory,
  fetchGeneratedMock: svc.fetchGeneratedMock,
  saveGeneratedMockProgress: svc.saveGeneratedMockProgress,
  submitGeneratedMock: svc.submitGeneratedMock,
}));

// Keep the offline fallbacks out of the way — they must never be reached when
// the real service resolves, and a stray fixture timer would fight the fake
// clock in the auto-submit test.
vi.mock('../../data/mocks/topik', () => ({
  loadTopikMockTest: vi.fn(() => Promise.reject(new Error('fixture off'))),
  submitTopikMockTestMock: vi.fn(() => Promise.reject(new Error('fixture off'))),
}));

import { MockMode } from './MockMode';
import { ExamActiveProvider } from '../../hooks/ExamActiveProvider';
import { useExamActive } from '../../hooks/useExamActive';

const TEST: MockTest = {
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
      prompt: '첫 번째 문제입니다.',
      options: [
        { id: 'a', kr: '가', en: 'A' },
        { id: 'b', kr: '나', en: 'B' },
        { id: 'c', kr: '다', en: 'C' },
        { id: 'd', kr: '라', en: 'D' },
      ],
    },
    {
      id: '1002',
      section: '읽기',
      number: 2,
      level: 3,
      prompt: '두 번째 문제입니다.',
      options: [
        { id: 'a', kr: '하나', en: 'One' },
        { id: 'b', kr: '둘', en: 'Two' },
        { id: 'c', kr: '셋', en: 'Three' },
        { id: 'd', kr: '넷', en: 'Four' },
      ],
    },
  ],
};

// WIRE FIDELITY: `MockReveal.itemId` is a STRING on the real wire (the server
// projects `i.id::text`). An earlier numeric fixture here masked a bug where
// the results screen indexed a Map<number> with the string wire id — every
// lookup missed and real reviews rendered blank.
const RESULT: MockResult = {
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
      explanation: 'B is the consistent summary.',
    },
    {
      itemId: '1002',
      picked: 'a',
      correctChoiceId: 'c',
      isCorrect: false,
      explanation: 'C restates the phrase.',
    },
  ],
};

/**
 * Lands at `/chat` after an "Ask about this" click (F-020) and prints the
 * router state the navigation carried, so a test can assert the seed payload
 * itself — the real handoff contract, not just that a button rendered
 * (mirrors the Mistakes.test.tsx probe).
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

/** Render MockMode with a `/chat` probe route so seed navigations land. */
function renderWithChatProbe(): void {
  render(
    <MemoryRouter initialEntries={['/learn/topik']}>
      <Routes>
        <Route path="/learn/topik" element={<MockMode />} />
        <Route path="/chat" element={<ChatSeedProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Walk the F-079 pre-exam navigation and START a section's exam: section card
 * → exam chooser (server-picked entry) → start page → Start. The fetch fires
 * only on the final Start click — asserted explicitly in the F-079 tests.
 */
async function startExam(
  user: ReturnType<typeof userEvent.setup>,
  section: 'Reading' | 'Listening',
): Promise<void> {
  await user.click(
    screen.getByRole('button', {
      name: new RegExp(`${section} mock exams`, 'i'),
    }),
  );
  await user.click(
    screen.getByRole('button', {
      name: new RegExp(`Recommended ${section} exam`, 'i'),
    }),
  );
  await user.click(
    screen.getByRole('button', { name: '시험 시작 · Start test' }),
  );
}

/**
 * `fireEvent` twin of `startExam` for the fake-timer tests (userEvent
 * deadlocks against fake timers in happy-dom). The chooser/start navigation
 * is synchronous URL state, so no flushes are needed between the clicks —
 * only after the final Start (the exam fetch) — the callers already flush.
 */
function fireStartExam(section: 'Reading' | 'Listening'): void {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`${section} mock exams`, 'i'),
    }),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`Recommended ${section} exam`, 'i'),
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: '시험 시작 · Start test' }),
  );
}

/**
 * Drive the mock flow start → submit → confirm → results (no answers needed
 * — `submitMockTest` is mocked, so the graded rows come from the fixture).
 */
async function driveToResults(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await startExam(user, 'Reading');
  await waitFor(() => {
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });
  await user.click(screen.getByRole('button', { name: /Submit test/i }));
  await user.click(screen.getByRole('button', { name: '제출 · Submit' }));
  await waitFor(() => {
    expect(
      screen.getAllByRole('button', { name: 'Ask about this' }).length,
    ).toBeGreaterThan(0);
  });
}

describe('MockMode (Mock test)', () => {
  beforeEach(() => {
    svc.fetchMockTest.mockReset();
    svc.submitMockTest.mockReset();
    svc.fetchAttempt.mockReset();
    svc.saveAttempt.mockReset();
    svc.clearAttempt.mockReset();
    svc.fetchAvailableTests.mockReset();
    svc.fetchAttemptHistory.mockReset();
    svc.fetchMockTest.mockResolvedValue(TEST);
    svc.submitMockTest.mockResolvedValue(RESULT);
    // No saved attempt by default (no resume banner); saves/clears are no-ops.
    svc.fetchAttempt.mockResolvedValue(null);
    svc.saveAttempt.mockResolvedValue(undefined);
    svc.clearAttempt.mockResolvedValue(undefined);
    // F-118/F-104: the exam chooser's past-paper list + completion
    // checkmarks, and the start page's previous-attempts block. Default to
    // empty pages so the many existing tests that merely WALK the chooser/
    // start page (without asserting on this data) see the honest empty
    // state rather than a crash from an unmocked call.
    svc.fetchAvailableTests.mockResolvedValue({ tests: [], total: 0 });
    svc.fetchAttemptHistory.mockResolvedValue({ attempts: [], total: 0 });
  });

  it('renders the section select with a disabled Writing card', () => {
    render(<MockMode />, { wrapper: MemoryRouter });
    // F-079: section cards OPEN the exam chooser (the name says "exams",
    // not "Start … test" — tapping one must never arm a timer directly).
    expect(
      screen.getByRole('button', { name: /Reading mock exams/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Listening mock exams/i }),
    ).toBeEnabled();
    const writing = screen.getByRole('button', {
      name: /Writing mock test, coming soon/i,
    });
    expect(writing).toBeDisabled();
  });

  it('starts a section → enters the exam with answer-stripped items', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');

    // Exam renders: timer, progress, first item, choices.
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    expect(svc.fetchMockTest).toHaveBeenCalledWith(
      'reading',
      expect.any(AbortSignal),
    );
    expect(screen.getByText('첫 번째 문제입니다.')).toBeInTheDocument();
    expect(screen.getByText(/Reading · 1 \/ 2/)).toBeInTheDocument();
    // The choice radiogroup carries exactly the 4 stripped options — and the
    // item the screen received never had a `correct` flag (type-stripped).
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    const received = svc.fetchMockTest.mock.results[0]?.value as Promise<
      MockTest
    >;
    const test = await received;
    expect(test.items[0]?.options[0]).not.toHaveProperty('correct');
  });

  it('countdown timer starts at the section budget in h:mm:ss', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });
    await startExam(user, 'Reading');
    await waitFor(() => {
      // Reading = 70 minutes → 1:10:00 (NOT the old HH:MM "01:10", which read
      // as 1 min 10 s and only changed once a minute — the "frozen timer" FU).
      expect(screen.getByRole('timer')).toHaveTextContent('1:10:00');
    });
  });

  it('countdown timer starts at 1:00:00 for the Listening section', async () => {
    svc.fetchMockTest.mockResolvedValueOnce({ ...TEST, section: 'listening' });
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });
    await startExam(user, 'Listening');
    await waitFor(() => {
      // Listening = 60 minutes.
      expect(screen.getByRole('timer')).toHaveTextContent('1:00:00');
    });
  });

  it('countdown decrements every second and drops to mm:ss below the hour', async () => {
    // Fake timers BEFORE mount so the exam interval is on the fake clock (see
    // the auto-submit test below for the fireEvent/act pattern rationale).
    vi.useFakeTimers();
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const timer = screen.getByRole('timer');
      expect(timer).toHaveTextContent('1:10:00');

      // Every tick is visible — 1 s later the clock reads 1:09:59 (the old
      // HH:MM format froze at "01:09" for a full minute here).
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(timer).toHaveTextContent('1:09:59');

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(timer).toHaveTextContent('1:09:57');

      // Cross below the hour (total elapsed 10:01) → mm:ss with no hour part.
      await act(async () => {
        vi.advanceTimersByTime((10 * 60 - 2) * 1000);
      });
      expect(timer).toHaveTextContent('59:59');
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives remaining from the wall-clock deadline, not a tick count (throttled tab)', async () => {
    // The countdown must track a fixed deadline: a backgrounded/throttled tab
    // whose interval fired far FEWER times than seconds actually elapsed must
    // still show the true remaining, never bank the skipped seconds as extra
    // exam time. Fake ONLY the interval and stub `Date.now`, so we can advance
    // the wall clock 10 minutes while the interval fires exactly ONCE — the one
    // case a tick counter gets wrong.
    const T0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const timer = screen.getByRole('timer');
      expect(timer).toHaveTextContent('1:10:00');

      // 10 real minutes elapse, but the throttled interval fires only once.
      nowSpy.mockReturnValue(T0 + 10 * 60 * 1000);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      // Deadline-based → 70 − 10 = 1:00:00. A tick counter would read 1:09:59
      // (a single decrement), silently granting ~10 extra minutes.
      expect(timer).toHaveTextContent('1:00:00');
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  it('F-007: a RESUMED exam budgets only the saved remaining on the wall-clock deadline', async () => {
    // Resuming with 10 minutes saved must set a deadline ~600s out — NOT the
    // full 70-minute section budget. As above, only the interval is faked and
    // `Date.now` is stubbed, so the assertion is on the wall-clock deadline
    // itself (a tick counter — or a full-budget deadline — both fail it).
    const T0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    svc.fetchAttempt.mockResolvedValue({
      section: 'reading',
      sourceTest: 7,
      currentIdx: 0,
      picks: {},
      remainingMs: 600_000,
      answered: 0,
      updatedAt: '2026-07-06T10:00:00.000Z',
    });
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      // Flush the mount-time fetchAttempt so the resume banner appears.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole('button', { name: '이어서 하기 · Resume' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const timer = screen.getByRole('timer');
      // Seeded from the saved remaining: 600 s → 10:00 (mm:ss, not 1:10:00).
      expect(timer).toHaveTextContent(/^10:00$/);

      // 5 wall-clock minutes pass; the (throttled) interval fires once. A
      // correct resumed deadline (T0 + 600s) shows 05:00 — a full-budget
      // deadline would show 1:05:00, a tick counter 09:59.
      nowSpy.mockReturnValue(T0 + 5 * 60 * 1000);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(timer).toHaveTextContent(/^05:00$/);
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  it('persists the FRESH deadline-derived remaining on save, not the stale interval state (throttled tab)', async () => {
    // The countdown interval only re-derives the `remaining` STATE when it
    // fires; under intensive background-tab throttling it can go ~a minute
    // between fires, so at the moment a save runs the state can be up to that
    // much more generous than the wall clock. `saveProgress` must therefore
    // re-sample the deadline itself. Here the throttling is taken to its
    // limit: the faked interval NEVER fires while the wall clock advances 20
    // minutes, then a save is triggered via a pick — the exact `saveProgress`
    // callback the 15s persistence loop and the unmount flush also call.
    // Code that persists the stale state saves the seeded 1:10:00
    // (4_200_000 ms); the deadline-sampled save writes the true 50:00.
    const T0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Sanity: exam mounted at the full budget; the interval has not fired.
      expect(screen.getByRole('timer')).toHaveTextContent('1:10:00');

      // 20 wall-clock minutes elapse with zero interval fires — the
      // `remaining` state is still the stale 4200 s seed.
      nowSpy.mockReturnValue(T0 + 20 * 60 * 1000);
      // Fire a save WITHOUT advancing the interval: a pick runs the same
      // saveProgress as the 15 s loop.
      fireEvent.click(screen.getByRole('radio', { name: /나/ }));
      await act(async () => {
        await Promise.resolve();
      });

      const lastSave = svc.saveAttempt.mock.calls.at(-1)?.[0] as {
        picks: Record<string, string>;
        remainingMs: number;
      };
      // The pick is in the body — this IS the post-advance save, not the
      // mount-time one.
      expect(lastSave.picks).toMatchObject({ '1001': 'b' });
      // Fresh deadline sample: 70 min − 20 min = 50:00. A stale-state save
      // would persist 4_200_000 (1:10:00), and a resume would inherit the
      // whole throttle gap as extra exam time.
      expect(lastSave.remainingMs).toBe(50 * 60 * 1000);
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  it('does not announce the countdown on every tick (timer aria-live is off)', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });
    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    // The visible per-second clock must not flood assistive tech: aria-live off.
    expect(screen.getByRole('timer')).toHaveAttribute('aria-live', 'off');
  });

  it('announces only coarse time marks (a one-minute boundary), not every second', async () => {
    const T0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Move the wall clock to exactly the 60-seconds-remaining mark; fire once.
      nowSpy.mockReturnValue(T0 + (4200 - 60) * 1000);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      // The polite sr-only region carries the coarse minute cue — a per-second
      // announcer would instead read "59", "58", … one number every second.
      expect(screen.getByText('1 minute remaining.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  it('answers items, submits with confirm, and shows results with reveals', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    // Answer item 1 (choice b).
    await user.click(screen.getByRole('radio', { name: /나/ }));
    expect(screen.getByText(/1 \/ 2 answered/)).toBeInTheDocument();

    // Jump to item 2 via the palette, answer it.
    await user.click(screen.getByRole('button', { name: /Question 2/i }));
    expect(screen.getByText('두 번째 문제입니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /하나/ }));

    // The save side (F-007): each pick fires a fire-and-forget saveAttempt, and
    // the latest one carries the full picks map keyed by item id.
    await waitFor(() => {
      expect(svc.saveAttempt).toHaveBeenCalled();
    });
    const lastSave = svc.saveAttempt.mock.calls.at(-1)?.[0] as {
      sourceTest: number;
      topikLevel?: string;
      picks: Record<string, string>;
    };
    expect(lastSave.sourceTest).toBe(7);
    expect(lastSave.picks).toMatchObject({ '1001': 'b', '1002': 'a' });
    // F-122: the resolved level (from POST /topik/mock's own response, TEST
    // fixture above) rides along on every progress save so the server can
    // persist the EXACT paper this attempt belongs to.
    expect(lastSave.topikLevel).toBe('TOPIK II');

    // Submit → confirm.
    await user.click(screen.getByRole('button', { name: /Submit test/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '제출 · Submit' }));

    // Results render: score, band, per-item reveal with the now-shown
    // correct answer for the missed item.
    await waitFor(() => {
      expect(screen.getByText('L3 range')).toBeInTheDocument();
    });
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 correct/)).toBeInTheDocument();

    // Submit mops up the attempt client-side too (F-007), so a save that raced
    // the server-side clear can't leave a stale resume banner.
    await waitFor(() => {
      expect(svc.clearAttempt).toHaveBeenCalled();
    });
    // F-009: explanation is gated on !isCorrect — item 1001 was answered
    // correctly, so its explanation is withheld; item 1002 was missed, so
    // its explanation shows.
    expect(
      screen.queryByText('B is the consistent summary.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('C restates the phrase.')).toBeInTheDocument();

    // WIRE-CONTRACT REGRESSION: the reveal's `itemId` is a STRING (the wire
    // sends `i.id::text`); each row must still resolve its item's prompt and
    // choice text. The pre-fix Map<number> lookup missed on every string id,
    // rendering "No. 0", empty prompts, and '—' for both picks.
    expect(screen.getByText('첫 번째 문제입니다.')).toBeInTheDocument();
    expect(screen.getByText('두 번째 문제입니다.')).toBeInTheDocument();
    expect(screen.getByText('No. 1')).toBeInTheDocument();
    expect(screen.getByText('No. 2')).toBeInTheDocument();
    // The miss row shows the resolved picked + correct choice text, not '—'.
    expect(screen.getByText('하나')).toBeInTheDocument();
    expect(screen.getByText('셋')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();

    // F-020: every review row offers the "Ask about this" Chat handoff.
    expect(
      screen.getAllByRole('button', { name: 'Ask about this' }),
    ).toHaveLength(2);

    // The submit body carried the user's picks for both items.
    const body = svc.submitMockTest.mock.calls[0]?.[0] as {
      sourceTest: number;
      section: string;
      answers: { itemId: number; picked: string }[];
    };
    expect(body.sourceTest).toBe(7);
    expect(body.section).toBe('reading');
    expect(body.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 1001, picked: 'b' }),
        expect.objectContaining({ itemId: 1002, picked: 'a' }),
      ]),
    );

    // New mock returns to the section select (URL params dropped too).
    await user.click(screen.getByRole('button', { name: /New mock/i }));
    expect(
      screen.getByRole('button', { name: /Reading mock exams/i }),
    ).toBeInTheDocument();
  });

  // SHOULD-FIX (`REVIEW_mobile-touch.md`) — the submit-confirm alertdialog
  // passed useModalA11y an unmemoized inline `onClose`, and the 1s countdown
  // re-render (`setRemaining`, `MockMode.tsx`) retriggered the hook's
  // open/close effect every tick while the dialog was open — each retrigger
  // queues a `previouslyActive.focus()` microtask (`useModalA11y.ts`'s
  // cleanup), thrashing focus in/out of the open dialog once a second. With
  // a stable `onClose` (`useCallback`), the effect's deps (`[open, onClose]`)
  // never change while the dialog stays open, so it never re-runs from
  // ticking alone — no extra `.focus()` calls. This spies on
  // `HTMLElement.prototype.focus` to prove exactly that: zero additional
  // focus calls across several countdown ticks with the confirm dialog open.
  it('does not thrash focus while the countdown ticks with the submit-confirm dialog open (SHOULD-FIX regression)', async () => {
    const T0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByRole('button', { name: /Submit test/i }));
      const dialog = screen.getByRole('alertdialog', { name: 'Confirm submit' });
      expect(dialog).toBeInTheDocument();

      // Focus lands inside the dialog on open (useModalA11y's initial-focus
      // effect) — capture it, then reset the spy so only POST-open calls
      // (the thing under test) count.
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
      focusSpy.mockClear();

      // Advance the wall clock + the faked 1s interval several times while
      // the dialog stays open — the exact precondition the bug needed.
      for (let i = 0; i < 4; i += 1) {
        nowSpy.mockReturnValue(T0 + (i + 1) * 1000);
        await act(async () => {
          vi.advanceTimersByTime(1000);
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      // The dialog is still open and untouched — no spurious close, and no
      // element (inside or outside the dialog) was refocused by the ticking.
      expect(screen.getByRole('alertdialog', { name: 'Confirm submit' })).toBe(dialog);
      expect(focusSpy).not.toHaveBeenCalled();

      focusSpy.mockRestore();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  it('F-009: gates the review explanation on !isCorrect (hidden on a correct pick, shown on a miss)', async () => {
    // A single-item mock so the row-level gating is unambiguous: the ONE
    // reveal is correct, so its explanation must be entirely absent from the
    // results screen — this fails on the pre-fix behavior, which rendered
    // every item's explanation regardless of correctness.
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [TEST.items[0]!],
    });
    svc.submitMockTest.mockResolvedValueOnce({
      sourceTest: 7,
      section: 'reading',
      totalItems: 1,
      answered: 1,
      correct: 1,
      percentage: 100,
      band: 'On track for L5+',
      items: [
        {
          itemId: '1001',
          picked: 'b',
          correctChoiceId: 'b',
          isCorrect: true,
          explanation: 'This explanation must stay hidden — the pick was correct.',
        },
      ],
    });

    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });
    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('radio', { name: /나/ }));
    await user.click(screen.getByRole('button', { name: /Submit test/i }));
    await user.click(screen.getByRole('button', { name: '제출 · Submit' }));

    await waitFor(() => {
      expect(screen.getByText('On track for L5+')).toBeInTheDocument();
    });
    expect(screen.getByText(/1 \/ 1 correct/)).toBeInTheDocument();
    expect(
      screen.queryByText(
        'This explanation must stay hidden — the pick was correct.',
      ),
    ).not.toBeInTheDocument();
  });

  it('F-020: a MISS row seeds Chat with the correct answer, the wrong pick, and the explanation', async () => {
    // RESULT: item 1002 was missed (picked 'a' = 하나, correct 'c' = 셋). The
    // seed must carry the resolved display texts on the RIGHT labels — this
    // fails if correct/pick are ever swapped or left as raw choice ids.
    const user = userEvent.setup();
    renderWithChatProbe();
    await driveToResults(user);

    const buttons = screen.getAllByRole('button', { name: 'Ask about this' });
    await user.click(buttons[1]!); // row 2 = item 1002, the miss

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('두 번째 문제입니다.');
    expect(probe.textContent).toContain('Correct answer: 셋');
    expect(probe.textContent).toContain('My answer: 하나 (incorrect)');
    expect(probe.textContent).toContain('Why: C restates the phrase.');
    expect(probe.textContent).toContain('mode=topik_prep');
  });

  it('F-020: a CORRECT row seeds no "My answer" and no explanation (F-009 gate)', async () => {
    // RESULT: item 1001 was answered correctly — its seed carries only the
    // prompt + correct answer the results screen already showed. Leaking a
    // "My answer: … (incorrect)" line or the withheld explanation here would
    // contradict the on-screen review.
    const user = userEvent.setup();
    renderWithChatProbe();
    await driveToResults(user);

    const buttons = screen.getAllByRole('button', { name: 'Ask about this' });
    await user.click(buttons[0]!); // row 1 = item 1001, answered correctly

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('첫 번째 문제입니다.');
    expect(probe.textContent).toContain('Correct answer: 나');
    expect(probe.textContent).not.toContain('My answer');
    expect(probe.textContent).not.toContain('Why:');
  });

  it('F-020: a SKIPPED row never seeds the sentinel as a wrong "My answer"', async () => {
    // A skip is graded as a miss (picked: null) — the seed keeps the
    // explanation but must NOT fabricate `My answer: skipped (incorrect)`.
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [TEST.items[0]!],
    });
    svc.submitMockTest.mockResolvedValueOnce({
      sourceTest: 7,
      section: 'reading',
      totalItems: 1,
      answered: 0,
      correct: 0,
      percentage: 0,
      band: 'L3 range',
      items: [
        {
          itemId: '1001',
          picked: null,
          correctChoiceId: 'b',
          isCorrect: false,
          explanation: 'B is the consistent summary.',
        },
      ],
    });

    const user = userEvent.setup();
    renderWithChatProbe();
    await driveToResults(user);

    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('Correct answer: 나');
    expect(probe.textContent).toContain('Why: B is the consistent summary.');
    expect(probe.textContent).not.toContain('My answer');
    expect(probe.textContent).not.toContain('skipped');
  });

  it('auto-submits when the countdown reaches 0', async () => {
    // Fake timers from the start so the exam's `setInterval` is faked (a timer
    // created BEFORE useFakeTimers stays on the real clock and would ignore
    // advanceTimersByTime). userEvent deadlocks against fake timers in
    // happy-dom, so the section start is driven with `fireEvent` + manual
    // promise flushes inside `act`.
    vi.useFakeTimers();
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      // Start the Reading section.
      fireStartExam('Reading');
      // Flush the resolved fetch promise so the exam mounts (and starts its
      // faked interval).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('timer')).toBeInTheDocument();

      // Reading budget = 70 min = 4200 s. Advance past expiry (fake timers move
      // Date.now in lockstep, so the wall-clock deadline is reached); the
      // auto-submit effect fires when the derived remaining hits 0.
      await act(async () => {
        vi.advanceTimersByTime(4200 * 1000 + 1000);
      });
      // Flush the auto-submit's resolved submit promise so the phase flips.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    // The timer-expiry auto-submit called the server with whatever was answered
    // (nothing here) — exactly once.
    expect(svc.submitMockTest).toHaveBeenCalledTimes(1);
    const body = svc.submitMockTest.mock.calls[0]?.[0] as {
      answers: unknown[];
    };
    expect(body.answers).toEqual([]);
  });

  it('features the image description for a hasImage exam item', async () => {
    // An image-dependent item (has_image, no stored asset): the exam must
    // surface the bracketed description in the labelled TopikImageNote block.
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [
        {
          id: '1001',
          section: '듣기',
          number: 1,
          level: 3,
          prompt:
            '남자: 이 책을 소포로 보내고 싶은데요.\n[알맞은 그림 고르기: ①우체국 ②서점 ③도서관 ④문구점]',
          hasImage: true,
          options: [
            { id: 'a', kr: '①', en: '' },
            { id: 'b', kr: '②', en: '' },
            { id: 'c', kr: '③', en: '' },
            { id: 'd', kr: '④', en: '' },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');

    const note = await screen.findByRole('complementary', {
      name: /image described in text/i,
    });
    expect(note).toHaveTextContent(
      '알맞은 그림 고르기: ①우체국 ②서점 ③도서관 ④문구점',
    );
    // The prompt body keeps the transcript, without the bracketed segment.
    expect(
      screen.getByText('남자: 이 책을 소포로 보내고 싶은데요.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/\[알맞은 그림 고르기/),
    ).not.toBeInTheDocument();
  });

  it('renders the shared reading passage before the choices in the exam (B-008)', async () => {
    // A shared-passage item: the answer-stripped wire carries the reading text
    // in `passage` (question content, never answer data) and the exam renders
    // it before the choices — without it the item is unanswerable.
    const passageText =
      '도시의 도로는 대부분 아스팔트로 뒤덮여 있다. 그래서 비가 오면 빗물이 지하로 잘 흘러 들어가지 ( ㉠ ) 도로가 물에 잠기는 일도 자주 발생한다.';
    svc.fetchMockTest.mockResolvedValueOnce({
      ...TEST,
      items: [{ ...TEST.items[0]!, passage: passageText }, TEST.items[1]!],
    });
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });

    const passage = screen.getByText(passageText);
    expect(passage).toHaveClass('km-topik__passage');
    const choices = screen.getByRole('radiogroup', { name: 'Answer choices' });
    expect(
      passage.compareDocumentPosition(choices) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The second item is self-contained — stepping to it drops the block.
    await user.click(screen.getByRole('button', { name: '다음 · Next' }));
    expect(screen.queryByText(passageText)).not.toBeInTheDocument();
  });

  it('falls back to an error card (not a blank screen) when fetch + fixture both fail', async () => {
    svc.fetchMockTest.mockRejectedValueOnce(new Error('down'));
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');
    // loadTopikMockTest is mocked to reject too → the error card surfaces.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('F-UP-018: a failed exam fetch renders fixed copy, never the raw ApiError prose', async () => {
    // The server rejection carries prose (constraint/relation detail) on
    // ApiError.message. The ErrorCard must show the call site's fixed
    // fallback — the pre-fix `err instanceof ApiError ? err.message : …`
    // echoed the prose verbatim into the DOM.
    svc.fetchMockTest.mockRejectedValueOnce(
      new ApiError('relation "topik_mock_items" does not exist', {
        status: 500,
        code: 'server_error',
      }),
    );
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');

    // Fixed copy, not the server prose.
    expect(
      await screen.findByText(/could not load the mock test/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/topik_mock_items/),
    ).not.toBeInTheDocument();
  });

  it('F-UP-018: a failed submit renders fixed copy, never the raw ApiError prose', async () => {
    // Same contract on the grading path: the submit ErrorCard shows the
    // fixed "Could not submit the test." fallback, never the server's
    // ApiError.message prose — and the retry stays wired.
    svc.submitMockTest.mockRejectedValueOnce(
      new ApiError(
        'insert or update on table "mock_results" violates foreign key constraint',
        { status: 500, code: 'server_error' },
      ),
    );
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('radio', { name: /나/ }));
    await user.click(screen.getByRole('button', { name: /Submit test/i }));
    await user.click(screen.getByRole('button', { name: '제출 · Submit' }));

    // Fixed copy, not the server prose.
    expect(
      await screen.findByText(/could not submit the test/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/mock_results/)).not.toBeInTheDocument();
    expect(screen.queryByText(/foreign key/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Retry submit/i }),
    ).toBeInTheDocument();
  });
  it('shows a resume banner for a saved attempt, and Resume re-fetches the same exam by source_test (F-007)', async () => {
    const user = userEvent.setup();
    svc.fetchAttempt.mockResolvedValue({
      section: 'reading',
      sourceTest: 777,
      currentIdx: 2,
      picks: { '1001': 'b' },
      remainingMs: 1_800_000,
      answered: 1,
      updatedAt: '2026-07-06T10:00:00.000Z',
    });
    render(<MockMode />, { wrapper: MemoryRouter });

    // The banner appears once the mount-time fetchAttempt resolves.
    const resumeBtn = await screen.findByRole('button', { name: '이어서 하기 · Resume' });
    expect(screen.getByText(/Resume your/i)).toBeInTheDocument();

    await user.click(resumeBtn);
    // Resume re-fetches the SAME exam via its stored source_test (3rd arg), so
    // the saved picks / index / timer line up with the identical item set.
    await waitFor(() => {
      expect(svc.fetchMockTest).toHaveBeenCalledWith(
        'reading',
        expect.anything(),
        777,
      );
    });
  });

  it('F-UP-015: a failed resume re-fetch shows a "couldn\'t resume" notice instead of silently dropping the banner', async () => {
    const user = userEvent.setup();
    svc.fetchAttempt.mockResolvedValue({
      section: 'reading',
      sourceTest: 777,
      currentIdx: 2,
      picks: { '1001': 'b' },
      remainingMs: 1_800_000,
      answered: 1,
      updatedAt: '2026-07-06T10:00:00.000Z',
    });
    // The exact exam can no longer be served (e.g. the source test was
    // re-ingested) — the resume fetch rejects.
    svc.fetchMockTest.mockRejectedValueOnce(new Error('gone'));
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(await screen.findByRole('button', { name: '이어서 하기 · Resume' }));

    // The banner is gone AND the user is told why (pre-fix: silent vanish).
    const notice = await screen.findByText(/Couldn't resume your saved test/i);
    expect(notice).toBeInTheDocument();
    // The banner (with its Resume button) is gone.
    expect(
      screen.queryByRole('button', { name: '이어서 하기 · Resume' }),
    ).not.toBeInTheDocument();
    // Still on the select screen, sections choosable.
    const reading = screen.getByRole('button', {
      name: /Reading mock exams/i,
    });
    expect(reading).toBeEnabled();

    // Starting a fresh exam (chooser → start page → Start) clears the notice.
    await startExam(user, 'Reading');
    await waitFor(() => {
      expect(screen.getByRole('timer')).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Couldn't resume your saved test/i),
    ).not.toBeInTheDocument();
  });

  it('clamps a per-item timeMs above the server cap (1h) so the submit body stays valid', async () => {
    // A laptop sleep / suspended tab freezes the countdown's setInterval but
    // not the wall clock. Pre-fix, one raw >1h delta 400'd the WHOLE submit
    // (server zod `timeMs.max(3600000)`), and the latched submittedRef made
    // the exam ungradeable. Fake timers drive both the interval and
    // Date.now(), so expiring the 70-min budget yields a >1h on-item delta.
    vi.useFakeTimers();
    try {
      render(<MockMode />, { wrapper: MemoryRouter });
      fireStartExam('Reading');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Answer item 1, then let the full 4200s budget elapse → auto-submit.
      fireEvent.click(screen.getByRole('radio', { name: /나/ }));
      await act(async () => {
        vi.advanceTimersByTime(4200 * 1000 + 1000);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    expect(svc.submitMockTest).toHaveBeenCalledTimes(1);
    const body = svc.submitMockTest.mock.calls[0]?.[0] as {
      answers: { itemId: number; timeMs?: number }[];
    };
    const answer = body.answers.find((a) => a.itemId === 1001);
    expect(answer).toBeDefined();
    // ~70 min elapsed on the item, clamped to the server's 1h cap exactly.
    expect(answer?.timeMs).toBe(3_600_000);
  });

  describe('F-079 exam chooser + start page (Phase 3C-2)', () => {
    it('a section card opens the chooser — wired server-picked entry + F-118 past-paper list (honest empty), no exam fetch yet', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });

      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      // F-024: back to the section select.
      expect(
        screen.getByRole('button', { name: 'Back to Sections' }),
      ).toBeInTheDocument();
      // The server-picked entry.
      expect(
        screen.getByRole('button', {
          name: /Recommended Reading exam, server-picked/i,
        }),
      ).toBeInTheDocument();
      // F-118/F-104: the past-paper list is now WIRED — the default mock
      // resolves an empty page, so this renders the honest empty state
      // (never "coming soon", never a fabricated exam).
      await waitFor(() => {
        expect(
          screen.getByText(/No past papers are available for this section yet/i),
        ).toBeInTheDocument();
      });
      expect(svc.fetchAvailableTests).toHaveBeenCalledWith(
        { section: 'reading' },
        expect.any(AbortSignal),
      );
      expect(svc.fetchMockTest).not.toHaveBeenCalled();
      expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    });

    it('the exam chooser lists F-118 past papers with a checkmark on ones F-104 reports completed', async () => {
      svc.fetchAvailableTests.mockResolvedValue({
        tests: [
          { testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 },
          { testNumber: 83, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 },
        ],
        total: 2,
      });
      svc.fetchAttemptHistory.mockResolvedValue({
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
      });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      const done = await screen.findByRole('button', {
        name: /TOPIK II test 91, 50 items, completed/i,
      });
      expect(done).toBeInTheDocument();
      // Test 83 has no matching attempt — no ", completed" in its name.
      expect(
        screen.getByRole('button', { name: /TOPIK II test 83, 50 items/i }),
      ).not.toHaveAccessibleName(/completed/i);

      // Picking a SPECIFIC past paper carries its test_number to the start
      // page, then to the exam fetch (not the server-picked "recommended" path).
      await user.click(done);
      expect(screen.getByText('읽기 · 91회')).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: '시험 시작 · Start test' }),
      );
      await waitFor(() => {
        // Fix-pass S-1 (REVIEW_topik.md / D-1): the level rides along with
        // the test_number, not just the number alone.
        expect(svc.fetchMockTest).toHaveBeenCalledWith(
          'reading',
          expect.any(AbortSignal),
          91,
          'TOPIK II',
        );
      });
    });

    // Fix-pass S-1 (REVIEW_topik.md): the D-1 scenario the review's own
    // fixtures never exercised — the SAME test_number appears TWICE in the
    // chooser, once per level. Before the fix, `onPickExam` discarded
    // `test.topikLevel` and `fetchMockTest` was only ever called with
    // `sourceTest`, so the server's `resolveMockTest` tie-break
    // (`ORDER BY topik_level DESC`) always resolved TOPIK II regardless of
    // which row was clicked — clicking the TOPIK I row silently served
    // TOPIK II. This test fails on that un-fixed code (asserting `'TOPIK I'`
    // where the old call site never passed a 4th arg at all).
    it('clicking the TOPIK I row serves TOPIK I, not the shared test_number\'s TOPIK II tie-break default', async () => {
      svc.fetchAvailableTests.mockResolvedValue({
        tests: [
          { testNumber: 91, topikLevel: 'TOPIK I', section: '읽기', itemCount: 50 },
          { testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 },
        ],
        total: 2,
      });
      svc.fetchAttemptHistory.mockResolvedValue({ attempts: [], total: 0 });
      svc.fetchMockTest.mockResolvedValueOnce({ ...TEST, topikLevel: 'TOPIK I' });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      const topikI = await screen.findByRole('button', {
        name: 'TOPIK I test 91, 50 items',
      });
      // Sanity: the OTHER row for the same test_number is TOPIK II — this is
      // the exact D-1 "one test_number, two papers" scenario. Exact-string
      // names (not regex substrings) so "TOPIK I" can't accidentally match
      // inside "TOPIK II"'s accessible name.
      expect(
        screen.getByRole('button', { name: 'TOPIK II test 91, 50 items' }),
      ).toBeInTheDocument();

      await user.click(topikI);
      // The start page discloses the level it will fetch (fix-pass S-1) —
      // checked via the note's text content (not a language-mode-specific
      // string) since "TOPIK I" renders identically in both the en/kr copy.
      expect(screen.getByRole('note')).toHaveTextContent(/TOPIK I/);
      await user.click(
        screen.getByRole('button', { name: '시험 시작 · Start test' }),
      );

      await waitFor(() => {
        expect(svc.fetchMockTest).toHaveBeenCalledWith(
          'reading',
          expect.any(AbortSignal),
          91,
          'TOPIK I',
        );
      });
      // Never resolved/served as TOPIK II — the D-1 tie-break must not win
      // over the level the user actually clicked.
      expect(svc.fetchMockTest).not.toHaveBeenCalledWith(
        'reading',
        expect.any(AbortSignal),
        91,
        'TOPIK II',
      );
    });

    // F-123: before the fix, the done-set was keyed on sourceTest ALONE, so
    // a completed TOPIK II paper's checkmark bled onto the same-numbered
    // TOPIK I row (and vice-versa) — the exact D-1 "one test_number, two
    // papers" collision the level-threading tests above exist for, but for
    // the CHECKMARK annotation rather than which paper gets served.
    it('F-123: a completed TOPIK II attempt checkmarks ONLY the TOPIK II row, never the same-numbered TOPIK I row', async () => {
      svc.fetchAvailableTests.mockResolvedValue({
        tests: [
          { testNumber: 91, topikLevel: 'TOPIK I', section: '읽기', itemCount: 50 },
          { testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 },
        ],
        total: 2,
      });
      svc.fetchAttemptHistory.mockResolvedValue({
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
      });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      const topikII = await screen.findByRole('button', {
        name: /TOPIK II test 91, 50 items, completed/i,
      });
      expect(topikII).toBeInTheDocument();
      // The TOPIK I row shares the SAME test_number but must NOT inherit the
      // checkmark — exact-string name so "TOPIK I" can't substring-match
      // inside "TOPIK II"'s accessible name.
      expect(
        screen.getByRole('button', { name: 'TOPIK I test 91, 50 items' }),
      ).not.toHaveAccessibleName(/completed/i);
    });

    // F-122: a completed attempt with NO persisted topikLevel (a pre-066
    // legacy row) must never checkmark EITHER same-numbered row by guessing
    // — a false checkmark is worse than a missing one.
    it('F-123: a legacy attempt with topikLevel null checkmarks neither same-numbered row', async () => {
      svc.fetchAvailableTests.mockResolvedValue({
        tests: [
          { testNumber: 91, topikLevel: 'TOPIK I', section: '읽기', itemCount: 50 },
          { testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 },
        ],
        total: 2,
      });
      svc.fetchAttemptHistory.mockResolvedValue({
        attempts: [
          {
            attemptId: '1',
            section: '읽기',
            sourceTest: 91,
            topikLevel: null,
            correct: 40,
            totalItems: 50,
            completedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        total: 1,
      });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      expect(
        await screen.findByRole('button', { name: 'TOPIK I test 91, 50 items' }),
      ).not.toHaveAccessibleName(/completed/i);
      expect(
        screen.getByRole('button', { name: 'TOPIK II test 91, 50 items' }),
      ).not.toHaveAccessibleName(/completed/i);
    });

    it("the exam chooser's checkmarks degrade silently when attempt history fails (the list itself still renders)", async () => {
      svc.fetchAvailableTests.mockResolvedValue({
        tests: [{ testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 }],
        total: 1,
      });
      svc.fetchAttemptHistory.mockRejectedValue(new Error('offline'));
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      const row = await screen.findByRole('button', {
        name: /TOPIK II test 91, 50 items/i,
      });
      expect(row).not.toHaveAccessibleName(/completed/i);
      // No error surfaced for a checkmark-only fetch failure — it is a
      // best-effort annotation, not the primary surface.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('the exam chooser surfaces a retryable error when the F-118 list itself fails to load', async () => {
      svc.fetchAvailableTests.mockRejectedValueOnce(new Error('offline'));
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );

      await screen.findByRole('alert');
      svc.fetchAvailableTests.mockResolvedValueOnce({
        tests: [{ testNumber: 91, topikLevel: 'TOPIK II', section: '읽기', itemCount: 50 }],
        total: 1,
      });
      await user.click(screen.getByRole('button', { name: /try again/i }));
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /TOPIK II test 91/i }),
        ).toBeInTheDocument();
      });
    });

    it('the start page requires an explicit Start — the exam fetches ONLY on the Start click', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });

      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );
      // The chooser itself calls fetchAttemptHistory (F-104 checkmarks) —
      // capture that count so the assertion below is specifically about the
      // START PAGE (recommended path), not the chooser's own annotation fetch.
      const attemptHistoryCallsFromChooser = svc.fetchAttemptHistory.mock.calls.length;
      await user.click(
        screen.getByRole('button', { name: /Recommended Reading exam/i }),
      );

      // Start page: exam meta + rules…
      expect(screen.getAllByText(/50문항 · 70분/).length).toBeGreaterThan(0);
      // …and the previous-attempts block is an honest note: the recommended
      // path doesn't know WHICH test_number the server will pick until Start
      // resolves it, so there is genuinely nothing to look up yet (F-104).
      expect(
        screen.getByText(
          /Pick a specific past paper from the exam list to see your previous attempts on it/i,
        ),
      ).toBeInTheDocument();
      expect(svc.fetchAttemptHistory.mock.calls.length).toBe(
        attemptHistoryCallsFromChooser,
      );
      expect(svc.fetchMockTest).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole('button', { name: '시험 시작 · Start test' }),
      );
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      // Server-picked: exactly one fetch, no sourceTest third argument.
      expect(svc.fetchMockTest).toHaveBeenCalledTimes(1);
      expect(svc.fetchMockTest).toHaveBeenCalledWith(
        'reading',
        expect.any(AbortSignal),
      );
    });

    it('F-024: BackButtons walk start page → chooser → section select', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );
      await user.click(
        screen.getByRole('button', { name: /Recommended Reading exam/i }),
      );

      await user.click(
        screen.getByRole('button', { name: 'Back to Reading exams' }),
      );
      // Chooser again — the Start button is gone, the wired entry is back.
      expect(
        screen.queryByRole('button', { name: '시험 시작 · Start test' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Recommended Reading exam/i }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back to Sections' }));
      expect(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      ).toBeInTheDocument();
    });

    it('F-024: the exam BackButton exits a running exam to the chooser and flushes a resumable save', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      // Answer one item so the flushed save carries real progress.
      await user.click(screen.getByRole('radio', { name: /나/ }));
      const savesBefore = svc.saveAttempt.mock.calls.length;

      await user.click(
        screen.getByRole('button', { name: 'Back to Reading exams' }),
      );

      await waitFor(() => {
        expect(screen.queryByRole('timer')).not.toBeInTheDocument();
      });
      // Back on the chooser…
      expect(
        screen.getByRole('button', { name: /Recommended Reading exam/i }),
      ).toBeInTheDocument();
      // …and the runner's unmount cleanup flushed a final save (F-007), so
      // the attempt is resumable — leaving mid-exam loses nothing.
      expect(svc.saveAttempt.mock.calls.length).toBeGreaterThan(savesBefore);
      const lastSave = svc.saveAttempt.mock.calls.at(-1)?.[0] as {
        picks: Record<string, string>;
      };
      expect(lastSave.picks).toMatchObject({ '1001': 'b' });
      // Leaving is NOT a submit.
      expect(svc.submitMockTest).not.toHaveBeenCalled();
    });
  });

  describe('F-080 listening audio (honest fallback for an unmapped paper)', () => {
    it('a Listening exam with NO mapped audio keeps the honest note — transcripts, no fake play control', async () => {
      // F-119 serves per-question audio for MAPPED papers; a paper with
      // `audioUrl: null` (nothing mapped) must still disclose the gap rather
      // than render a dead player.
      svc.fetchMockTest.mockResolvedValue({ ...TEST, section: 'listening' });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });

      await user.click(
        screen.getByRole('button', { name: /Listening mock exams/i }),
      );
      await user.click(
        screen.getByRole('button', { name: /Recommended Listening exam/i }),
      );
      // The start page can't know the paper's mapping before the fetch, so
      // its note describes both outcomes honestly (F-119 — the old blanket
      // "Audio isn't available yet" would be false for mapped papers).
      expect(
        screen.getByText(/Questions with mapped audio play the real recording/),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole('button', { name: '시험 시작 · Start test' }),
      );
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      // The exam head keeps the whole-exam honest note for this unmapped
      // paper. No fabricated player anywhere.
      expect(
        screen.getByText(/Audio isn't available yet/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /play/i }),
      ).not.toBeInTheDocument();
      expect(document.querySelector('audio')).toBeNull();
    });

    it('a Reading exam carries no audio note', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      expect(
        screen.queryByText(/Audio isn't available yet/),
      ).not.toBeInTheDocument();
      expect(document.querySelector('audio')).toBeNull();
    });
  });

  describe('F-119 per-question listening audio (mapped paper)', () => {
    // NOTE on the media element in tests: unlike jsdom, happy-dom implements
    // HTMLMediaElement.play()/pause()/currentTime/paused natively (play()
    // returns a promise and fires the play/pause events synchronously), so
    // no prototype stubs are needed — playback state is asserted straight
    // off the element, and the ~4Hz `timeupdate` the browser would emit is
    // driven manually via fireEvent.timeUpdate after seeking.

    /**
     * A mapped listening paper exercising all three real corpus shapes
     * (traced against the live DB — every listening row is stem-only, so
     * the DTO prompt carries the stem):
     *   - 2001: single question — the prompt IS the dialogue (span mapped,
     *     `promptIsTranscript: true` — the server's mapRowToDTO verdict for
     *     a stem-only row with no shared passage);
     *   - 2002: still-unmapped item (no span) — per-item fallback (the flag
     *     is true, but with no playable audio nothing hides);
     *   - 2003: paired question — printed question in `prompt`, dialogue in
     *     the shared `passage` (span mapped, `promptIsTranscript: false` —
     *     the server knows the stem here is question chrome).
     * The flag values mirror what routes/topik.ts `mapRowToDTO` emits for
     * exactly these row shapes (pinned by the server-side S-1 test) — keep
     * them in sync or the fixture stops representing the real wire.
     */
    const LISTEN_AUDIO_TEST: MockTest = {
      sourceTest: 60,
      topikLevel: 'TOPIK II',
      section: 'listening',
      audioUrl: '/topik/audio/60/2',
      items: [
        {
          id: '2001',
          section: '듣기',
          number: 1,
          level: 3,
          prompt: '남자: 학생이에요?\n여자: 네, 학생이에요.',
          options: [
            { id: 'a', kr: '가', en: 'A' },
            { id: 'b', kr: '나', en: 'B' },
            { id: 'c', kr: '다', en: 'C' },
            { id: 'd', kr: '라', en: 'D' },
          ],
          audioStartMs: 12_000,
          audioEndMs: 45_000,
          promptIsTranscript: true,
        },
        {
          id: '2002',
          section: '듣기',
          number: 2,
          level: 3,
          prompt: '여자: 오늘 날씨가 참 좋네요.',
          options: [
            { id: 'a', kr: '하나', en: 'One' },
            { id: 'b', kr: '둘', en: 'Two' },
            { id: 'c', kr: '셋', en: 'Three' },
            { id: 'd', kr: '넷', en: 'Four' },
          ],
          promptIsTranscript: true,
        },
        {
          id: '2003',
          section: '듣기',
          number: 3,
          level: 4,
          prompt: '남자는 누구인지 고르십시오.',
          passage:
            '여자: 한지 공예를 시작하신 지 얼마나 되셨어요?\n남자: 삼십 년쯤 됐습니다.',
          options: [
            { id: 'a', kr: '공예가', en: 'Artisan' },
            { id: 'b', kr: '기자', en: 'Reporter' },
            { id: 'c', kr: '교사', en: 'Teacher' },
            { id: 'd', kr: '의사', en: 'Doctor' },
          ],
          audioStartMs: 100_000,
          audioEndMs: 160_000,
          promptIsTranscript: false,
        },
      ],
    };

    /** Start the mapped listening exam and return its persistent element. */
    async function startListeningAudioExam(
      user: ReturnType<typeof userEvent.setup>,
    ): Promise<HTMLAudioElement> {
      svc.fetchMockTest.mockResolvedValue(LISTEN_AUDIO_TEST);
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Listening');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      const audio = document.querySelector('audio');
      expect(audio).not.toBeNull();
      return audio as HTMLAudioElement;
    }

    it('renders ONE persistent element (allow-listed src, metadata preload, no native controls, no autoplay)', async () => {
      const user = userEvent.setup();
      const audio = await startListeningAudioExam(user);

      expect(document.querySelectorAll('audio')).toHaveLength(1);
      // The allow-listed app-relative src (API base '' in tests).
      expect(audio).toHaveAttribute('src', '/topik/audio/60/2');
      expect(audio).toHaveAttribute('preload', 'metadata');
      // Playback is button-driven only: a native scrubber could play the
      // whole section tape outside the question's window.
      expect(audio).not.toHaveAttribute('controls');
      // No autoplay — mounting the exam starts nothing.
      expect(audio.paused).toBe(true);
      expect(
        screen.getByRole('button', { name: /Play question audio/i }),
      ).toBeInTheDocument();
    });

    it('keeps the SAME element across item navigation — a palette jump re-seeks, never remounts', async () => {
      const user = userEvent.setup();
      const audio = await startListeningAudioExam(user);

      // → item 2 (unmapped): the per-item note swaps in, the ELEMENT stays.
      await user.click(screen.getByRole('button', { name: /Question 2/i }));
      // Identity assertion — the exact same DOM node (reference equality), a
      // remount would produce a new element and dump the buffered file.
      expect(document.querySelector('audio')).toBe(audio);
      expect(
        screen.queryByRole('button', { name: /Play question audio/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/No audio for this question yet/),
      ).toBeInTheDocument();

      // → item 3 (mapped): the play control returns; still the same node.
      await user.click(screen.getByRole('button', { name: /Question 3/i }));
      expect(document.querySelector('audio')).toBe(audio);
      expect(
        screen.getByRole('button', { name: /Play question audio/i }),
      ).toBeInTheDocument();
      expect(audio).toHaveAttribute('src', '/topik/audio/60/2');
    });

    it('"Play question audio" seeks to audioStartMs/1000 and plays; the control flips to Pause', async () => {
      const user = userEvent.setup();
      const audio = await startListeningAudioExam(user);

      await user.click(
        screen.getByRole('button', { name: /Play question audio/i }),
      );

      // Seeked to item 2001's window start: 12000ms → 12s.
      expect(audio.currentTime).toBe(12);
      expect(audio.paused).toBe(false);
      const pauseBtn = screen.getByRole('button', { name: /일시 정지 · Pause/ });
      // …and the Pause control actually pauses.
      await user.click(pauseBtn);
      expect(audio.paused).toBe(true);
    });

    it('pauses at audioEndMs/1000 via the timeupdate clamp, and replays without limit (decision #3)', async () => {
      const user = userEvent.setup();
      const audio = await startListeningAudioExam(user);

      await user.click(
        screen.getByRole('button', { name: /Play question audio/i }),
      );
      expect(audio.paused).toBe(false);

      // Mid-window timeupdate: still inside [12s, 45s) — keeps playing.
      audio.currentTime = 30;
      fireEvent.timeUpdate(audio);
      expect(audio.paused).toBe(false);

      // Crossing the end bound (45s, +~250ms overshoot tolerance) pauses.
      audio.currentTime = 45.2;
      fireEvent.timeUpdate(audio);
      expect(audio.paused).toBe(true);

      // Unlimited replay: pressing Play again restarts from the window start.
      await user.click(
        screen.getByRole('button', { name: /Play question audio/i }),
      );
      expect(audio.currentTime).toBe(12);
      expect(audio.paused).toBe(false);
    });

    it('navigating to another item pauses playback (no ghost audio under the next question)', async () => {
      const user = userEvent.setup();
      const audio = await startListeningAudioExam(user);

      await user.click(
        screen.getByRole('button', { name: /Play question audio/i }),
      );
      expect(audio.paused).toBe(false);

      await user.click(screen.getByRole('button', { name: /Question 2/i }));
      expect(audio.paused).toBe(true);
      // The element survives the navigation (identity contract, above).
      expect(document.querySelector('audio')).toBe(audio);
    });

    it('a tampered/off-origin envelope audioUrl is rejected — no element, honest whole-exam note', async () => {
      // fetchMockTest is mocked here, so the SERVICE normalization never ran
      // — this proves the component's own buildAudioSrc gate fails closed.
      svc.fetchMockTest.mockResolvedValue({
        ...LISTEN_AUDIO_TEST,
        audioUrl: 'https://evil.example/a.mp3',
      });
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Listening');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });

      expect(document.querySelector('audio')).toBeNull();
      expect(
        screen.queryByRole('button', { name: /Play question audio/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/Audio isn't available yet/),
      ).toBeInTheDocument();
      // Fail-closed on the transcript too: with no playable audio the item
      // keeps its transcript (otherwise it would be unanswerable).
      expect(screen.getByText(/남자: 학생이에요\?/)).toBeInTheDocument();
    });

    describe('decision #2 — transcript hidden in the timed runner, visible in review', () => {
      it('hides a dialogue PROMPT while its audio is playable; the options and meta stay', async () => {
        const user = userEvent.setup();
        await startListeningAudioExam(user);

        // Item 2001: stem-only single question — the prompt IS the spoken
        // dialogue, so the timed runner must not print it.
        expect(
          screen.queryByText(/남자: 학생이에요\?/),
        ).not.toBeInTheDocument();
        // The question is still fully takeable: number, choices, player.
        expect(screen.getByText('No. 1')).toBeInTheDocument();
        expect(screen.getAllByRole('radio')).toHaveLength(4);
        expect(
          screen.getByRole('button', { name: /Play question audio/i }),
        ).toBeInTheDocument();
      });

      it('keeps a PRINTED question prompt visible and hides only the dialogue passage', async () => {
        const user = userEvent.setup();
        await startListeningAudioExam(user);

        await user.click(screen.getByRole('button', { name: /Question 3/i }));

        // The printed question ("…고르십시오.") is question chrome — shown.
        expect(
          screen.getByText('남자는 누구인지 고르십시오.'),
        ).toBeInTheDocument();
        // The shared passage IS the dialogue — hidden while audio plays.
        expect(
          screen.queryByText(/한지 공예를 시작하신 지/),
        ).not.toBeInTheDocument();
        expect(screen.getAllByRole('radio')).toHaveLength(4);
      });

      it('keeps the transcript for a STILL-UNMAPPED item (no span) alongside the honest note', async () => {
        const user = userEvent.setup();
        await startListeningAudioExam(user);

        await user.click(screen.getByRole('button', { name: /Question 2/i }));

        // No audio to play → hiding the transcript would make the item
        // unanswerable. It stays, with the per-item note.
        expect(
          screen.getByText(/여자: 오늘 날씨가 참 좋네요\./),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/No audio for this question yet/),
        ).toBeInTheDocument();
      });

      it('shows the transcript in the RESULTS review surface (studying what was misheard)', async () => {
        svc.fetchMockTest.mockResolvedValue(LISTEN_AUDIO_TEST);
        svc.submitMockTest.mockResolvedValue({
          sourceTest: 60,
          section: 'listening',
          totalItems: 3,
          answered: 1,
          correct: 0,
          percentage: 0,
          band: 'Below L3',
          items: [
            {
              itemId: '2001',
              picked: 'a',
              correctChoiceId: 'b',
              isCorrect: false,
              explanation: 'She answers that she is a student.',
            },
            {
              itemId: '2003',
              picked: null,
              correctChoiceId: 'a',
              isCorrect: false,
              explanation: 'The man is the artisan being interviewed.',
            },
          ],
        });
        const user = userEvent.setup();
        render(<MockMode />, { wrapper: MemoryRouter });
        await startExam(user, 'Listening');
        await waitFor(() => {
          expect(screen.getByRole('timer')).toBeInTheDocument();
        });
        await user.click(screen.getByRole('radio', { name: /나/ }));
        await user.click(screen.getByRole('button', { name: /Submit test/i }));
        await user.click(screen.getByRole('button', { name: '제출 · Submit' }));
        await waitFor(() => {
          expect(screen.getByText('Below L3')).toBeInTheDocument();
        });

        // The dialogue transcript the timed runner hid IS visible here —
        // review is where the learner studies what they misheard.
        expect(screen.getByText(/남자: 학생이에요\?/)).toBeInTheDocument();
        // Item 2003's shared dialogue passage renders in its review row too.
        expect(
          screen.getByText(/한지 공예를 시작하신 지/),
        ).toBeInTheDocument();
      });

      it('a verbatim prompt === passage dup item (48 real rows) leaks the dialogue ZERO times in the runner, still visible in review (fix-pass S-3)', async () => {
        // The dup corpus shape: a paired paper that copies the shared
        // dialogue verbatim into the item's stem → the wire carries the SAME
        // text in BOTH the prompt slot and the passage slot, and the server
        // marks it `promptIsTranscript: true`. BOTH slots must stay blank in
        // the timed runner — one leak through either defeats the listening
        // item.
        const DUP_DIALOGUE = '여자: 회의가 언제예요?\n남자: 내일 오후 두 시입니다.';
        svc.fetchMockTest.mockResolvedValue({
          sourceTest: 60,
          topikLevel: 'TOPIK II',
          section: 'listening',
          audioUrl: '/topik/audio/60/2',
          items: [
            {
              id: '2101',
              section: '듣기',
              number: 25,
              level: 4,
              prompt: DUP_DIALOGUE,
              passage: DUP_DIALOGUE,
              options: [
                { id: 'a', kr: '월요일', en: 'Monday' },
                { id: 'b', kr: '화요일', en: 'Tuesday' },
                { id: 'c', kr: '수요일', en: 'Wednesday' },
                { id: 'd', kr: '목요일', en: 'Thursday' },
              ],
              audioStartMs: 200_000,
              audioEndMs: 230_000,
              promptIsTranscript: true,
            },
          ],
        });
        svc.submitMockTest.mockResolvedValue({
          sourceTest: 60,
          section: 'listening',
          totalItems: 1,
          answered: 1,
          correct: 0,
          percentage: 0,
          band: 'Below L3',
          items: [
            {
              itemId: '2101',
              picked: 'a',
              correctChoiceId: 'b',
              isCorrect: false,
              explanation: 'The man says the meeting is tomorrow at two.',
            },
          ],
        });
        const user = userEvent.setup();
        render(<MockMode />, { wrapper: MemoryRouter });
        await startExam(user, 'Listening');
        await waitFor(() => {
          expect(screen.getByRole('timer')).toBeInTheDocument();
        });

        // ZERO occurrences anywhere in the timed runner — neither the prompt
        // slot nor the passage slot may print the dialogue.
        expect(screen.queryAllByText(/회의가 언제예요/)).toHaveLength(0);
        // The item is still fully takeable: player + choices remain.
        expect(
          screen.getByRole('button', { name: /Play question audio/i }),
        ).toBeInTheDocument();
        expect(screen.getAllByRole('radio')).toHaveLength(4);

        // Review surface: the dialogue IS visible for studying the miss.
        await user.click(screen.getByRole('radio', { name: /월요일/ }));
        await user.click(screen.getByRole('button', { name: /Submit test/i }));
        await user.click(screen.getByRole('button', { name: '제출 · Submit' }));
        await waitFor(() => {
          expect(screen.getByText('Below L3')).toBeInTheDocument();
        });
        expect(
          screen.getAllByText(/회의가 언제예요/).length,
        ).toBeGreaterThan(0);
      });
    });

    describe('F-160 runtime stream failure (fix-pass B1 + S-2/rev1)', () => {
      it('an <audio> error un-hides the transcript so the item stays answerable — the alert tells the truth (B1)', async () => {
        const user = userEvent.setup();
        const audio = await startListeningAudioExam(user);

        // Sanity: while playable, item 2001's dialogue prompt is hidden.
        expect(
          screen.queryByText(/남자: 학생이에요\?/),
        ).not.toBeInTheDocument();

        fireEvent.error(audio);

        // The F-160 alert appears — and its claim ("shows its transcript
        // instead") must be TRUE: the dialogue prompt is back.
        expect(screen.getByRole('alert')).toHaveTextContent(
          /Audio couldn't load/,
        );
        expect(screen.getByText(/남자: 학생이에요\?/)).toBeInTheDocument();
        // The play control is gone…
        expect(
          screen.queryByRole('button', { name: /Play question audio/i }),
        ).not.toBeInTheDocument();
        // …and the DISTINCT per-item "not mapped yet" note is not conflated
        // with the error state.
        expect(
          screen.queryByText(/No audio for this question yet/),
        ).not.toBeInTheDocument();

        // The failure is exam-global (one element, one whole-section file):
        // the paired item's shared dialogue passage reappears too, alongside
        // its always-visible printed question.
        await user.click(screen.getByRole('button', { name: /Question 3/i }));
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(
          screen.getByText('남자는 누구인지 고르십시오.'),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/한지 공예를 시작하신 지/),
        ).toBeInTheDocument();
      });

      it('a successful load after an error clears it — the player and decision-#2 hiding come back (S-2/rev1)', async () => {
        const user = userEvent.setup();
        const audio = await startListeningAudioExam(user);

        fireEvent.error(audio);
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/남자: 학생이에요\?/)).toBeInTheDocument();

        // The stream recovers (say, the network came back and the element
        // re-fetched its metadata): `loadedmetadata` clears the error…
        fireEvent.loadedMetadata(audio);

        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: /Play question audio/i }),
        ).toBeInTheDocument();
        // …and the transcript hides again (pure listening resumes).
        expect(
          screen.queryByText(/남자: 학생이에요\?/),
        ).not.toBeInTheDocument();

        // `canplay` clears it too — whichever event the browser fires first.
        fireEvent.error(audio);
        expect(screen.getByRole('alert')).toBeInTheDocument();
        fireEvent.canPlay(audio);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });
  });

  describe('exam-active context (Overhaul P1.1)', () => {
    function ExamFlagProbe(): JSX.Element {
      const { examActive } = useExamActive();
      return <div data-testid="exam-active">{String(examActive)}</div>;
    }

    function harness(children: JSX.Element | null): JSX.Element {
      return (
        <ExamActiveProvider>
          <ExamFlagProbe />
          <MemoryRouter>{children}</MemoryRouter>
        </ExamActiveProvider>
      );
    }

    it('publishes true on entering the exam and false again on results', async () => {
      const user = userEvent.setup();
      render(harness(<MockMode />));

      // Select phase — no exam yet.
      expect(screen.getByTestId('exam-active')).toHaveTextContent('false');

      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      expect(screen.getByTestId('exam-active')).toHaveTextContent('true');

      // Submit → results: the flag must drop with the phase.
      await user.click(screen.getByRole('button', { name: /Submit test/i }));
      await user.click(screen.getByRole('button', { name: '제출 · Submit' }));
      await waitFor(() => {
        expect(screen.getByTestId('exam-active')).toHaveTextContent('false');
      });
    });

    it('clears the flag when MockMode unmounts mid-exam (leaving the page)', async () => {
      const user = userEvent.setup();
      const { rerender } = render(harness(<MockMode />));

      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      expect(screen.getByTestId('exam-active')).toHaveTextContent('true');

      // Simulate navigating away — MockMode unmounts; the effect cleanup
      // must reset the shared flag so the ChatFab doesn't stay hidden.
      rerender(harness(null));
      expect(screen.getByTestId('exam-active')).toHaveTextContent('false');
    });
  });

  describe('PROD posture — no fixture substitution for real failures', () => {
    // In production the MockBadge renders null, so a fixture fallback would
    // paint a fabricated exam / fabricated grades indistinguishable from real
    // data. These stub `import.meta.env.PROD` and assert the honest error
    // path fires instead (same policy as useEndpointOrMock).
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('a failed exam fetch surfaces the error card, never the offline fixture', async () => {
      vi.stubEnv('PROD', true);
      const { loadTopikMockTest } = await import('../../data/mocks/topik');
      svc.fetchMockTest.mockRejectedValueOnce(
        new Error('km-api unreachable'),
      );
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });

      await startExam(user, 'Reading');

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      // The fixture loader was never consulted — prod shows the error, it
      // does not open a fabricated exam.
      expect(loadTopikMockTest).not.toHaveBeenCalled();
      expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    });

    it('a failed submit surfaces a retryable error, never the offline pseudo-grader', async () => {
      vi.stubEnv('PROD', true);
      const { submitTopikMockTestMock } = await import(
        '../../data/mocks/topik'
      );
      svc.submitMockTest.mockRejectedValueOnce(new Error('km-api blip'));
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });

      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('radio', { name: /나/ }));
      await user.click(screen.getByRole('button', { name: /Submit test/i }));
      await user.click(screen.getByRole('button', { name: '제출 · Submit' }));

      // No fabricated results screen — the pseudo-grader must not run.
      const alert = await screen.findByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(submitTopikMockTestMock).not.toHaveBeenCalled();
      expect(screen.queryByText('L3 range')).not.toBeInTheDocument();

      // The retry re-sends the SAME picks and reaches results on success.
      svc.submitMockTest.mockResolvedValueOnce(RESULT);
      await user.click(screen.getByRole('button', { name: /Retry submit/i }));
      await waitFor(() => {
        expect(screen.getByText('L3 range')).toBeInTheDocument();
      });
      expect(svc.submitMockTest).toHaveBeenCalledTimes(2);
      const [first, second] = svc.submitMockTest.mock.calls as [
        [{ answers: unknown[] }],
        [{ answers: unknown[] }],
      ];
      expect(second[0].answers).toEqual(first[0].answers);
    });
  });

  describe('P3b language wiring — chrome bilingual, exam CONTENT raw', () => {
    // No SettingsProvider here, so `useLanguageDisplay` serves the default
    // 'both' (Korean-first) mode — the Korean half of every wired pair must
    // be in the DOM, while TOPIK material (prompts/passages/choices/reveals)
    // must render outside <Bilingual> entirely.

    it('renders Korean chrome on the section select', () => {
      render(<MockMode />, { wrapper: MemoryRouter });
      // Lead line carries its Korean half (모의고사 — the canonical term).
      expect(
        screen.getByText(/영역을 골라 시간 제한 모의고사를 풀어 보세요/),
      ).toBeInTheDocument();
      // Section-card meta uses the glossary counters (N문항 · N분). Compact
      // pairs render their Korean twice (visible + sr-only), hence getAll.
      expect(screen.getAllByText('50문항 · 70분').length).toBeGreaterThan(0);
      expect(screen.getAllByText('50문항 · 60분').length).toBeGreaterThan(0);
      // The deferred Writing card wears the glossary's 준비 중.
      expect(screen.getAllByText('준비 중').length).toBeGreaterThan(0);
    });

    it('renders Korean exam chrome while the TOPIK item content stays raw', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });

      // Chrome went bilingual: timer pill, progress line, item nav, submit.
      expect(screen.getAllByText('실전 · 시간 제한').length).toBeGreaterThan(0);
      expect(screen.getAllByText('읽기 · 1 / 2').length).toBeGreaterThan(0);
      expect(
        screen.getByRole('button', { name: '이전 · Prev' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '다음 · Next' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '시험 제출 · Submit test' }),
      ).toBeInTheDocument();

      // CONTENT stays raw: the TOPIK prompt and choice text render outside
      // any <Bilingual> wrapper (never chrome-wrapped).
      const prompt = screen.getByText('첫 번째 문제입니다.');
      expect(prompt.closest('.km-bilingual')).toBeNull();
      const choice = screen.getByText('가');
      expect(choice.closest('.km-bilingual')).toBeNull();

      // The submit-confirm dialog is bilingual chrome end to end.
      await user.click(
        screen.getByRole('button', { name: '시험 제출 · Submit test' }),
      );
      expect(screen.getByText('시험을 제출할까요?')).toBeInTheDocument();
      expect(
        screen.getByText(/전체 2문항 중 0문항에 답했어요/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '계속 풀기 · Keep going' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '제출 · Submit' }),
      ).toBeInTheDocument();
    });

    it('renders Korean results chrome while the graded reveal content stays raw', async () => {
      const user = userEvent.setup();
      renderWithChatProbe();
      await driveToResults(user);

      // Score meta uses the canonical counters (답변 N개, 복습할 문제 N개).
      expect(
        screen.getByText('정답 1 / 2 · 답변 2개 · 복습할 문제 1개'),
      ).toBeInTheDocument();
      // Verdicts use the app-wide 맞았어요/틀렸어요 pair; the pick labels are
      // bilingual (compact pairs appear visible + sr-only, hence getAll).
      expect(screen.getAllByText('맞았어요').length).toBeGreaterThan(0);
      expect(screen.getAllByText('틀렸어요').length).toBeGreaterThan(0);
      expect(screen.getAllByText('내 답').length).toBeGreaterThan(0);
      expect(screen.getAllByText('정답').length).toBeGreaterThan(0);
      expect(
        screen.getByRole('button', { name: '새 모의고사 · New mock' }),
      ).toBeInTheDocument();

      // CONTENT stays raw: the server's band headline and the reveal's
      // prompt / choice text never pass through <Bilingual>.
      expect(
        screen.getByText('L3 range').closest('.km-bilingual'),
      ).toBeNull();
      expect(
        screen.getByText('두 번째 문제입니다.').closest('.km-bilingual'),
      ).toBeNull();
      expect(screen.getByText('셋').closest('.km-bilingual')).toBeNull();
    });
  });

  describe('F-183 "Seoul Day & Night" reskin', () => {
    it('renders each section pick as a CityCard signboard/hanji-paper tile, toned per section (devices #1/#2)', () => {
      render(<MockMode />, { wrapper: MemoryRouter });
      const reading = screen.getByRole('button', { name: /Reading mock exams/i });
      const listening = screen.getByRole('button', { name: /Listening mock exams/i });
      // Reading tracks the global accent picker; Listening pins to a fixed
      // blue regardless of it (sectionTone) — distinct tiles, not one flat
      // reused card.
      expect(reading.closest('.km-citycard')).toHaveClass('km-tone--accent');
      expect(listening.closest('.km-citycard')).toHaveClass('km-tone--blue');
    });

    it('does NOT re-apply the ambient rain-sheen on its own root (fix-pass batch5) — Topik.tsx\'s outer wrapper already carries device #8 for the whole tab panel, so a second copy here would double the overlay opacity over the same shared subtree', () => {
      const { container } = render(<MockMode />, { wrapper: MemoryRouter });
      expect(container.querySelector('.km-mock')).not.toHaveClass('km-rain-sheen');
    });

    it('renders the running exam with a SubwayProgress alongside the jump-grid palette (device #5) — real navigation, not decoration', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      const progress = screen.getByRole('progressbar', {
        name: /Reading progress/i,
      });
      expect(progress).toHaveAttribute('aria-valuenow', '1');
      expect(progress).toHaveAttribute('aria-valuemax', '2');
      // The jump-grid palette still renders alongside it — the subway line
      // is a supplementary at-a-glance readout, never a replacement for the
      // richer per-item answered/current jump grid (regression guard).
      expect(
        screen.getByRole('group', { name: 'Question navigator' }),
      ).toBeInTheDocument();

      // Jumping via the palette moves the subway line too — real state, not
      // a static decoration painted once at mount.
      await user.click(screen.getByRole('button', { name: /Question 2/i }));
      expect(progress).toHaveAttribute('aria-valuenow', '2');
    });

    it('wraps the live exam item (meta/prompt/choices/nav/submit) in one CityCard hero surface (devices #1/#2)', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      const prompt = screen.getByText('첫 번째 문제입니다.');
      const heroCard = prompt.closest('.km-citycard');
      expect(heroCard).not.toBeNull();
      // The Submit button lives inside the SAME hero card as the prompt —
      // structural parity with Study mode's TopikBody treatment in
      // Topik.tsx, where meta/prompt/choices/footer share one CityCard.
      const submit = screen.getByRole('button', { name: /Submit test/i });
      expect(submit.closest('.km-citycard')).toBe(heroCard);
    });

    it('marks a finished exam with the milestone SealStamp before the shared results screen (device #7)', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await driveToResults(user);
      // Compact Bilingual pairs render both a visible label and an sr-only
      // echo, hence getAllByText (matches this file's existing convention
      // for compact-pair assertions).
      expect(screen.getAllByText('시험 완료').length).toBeGreaterThan(0);
    });

    it('the score panel is a feat CityCard hero, not the old flat card (devices #1/#2)', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await driveToResults(user);
      const scoreCard = screen.getByText('L3 range').closest('.km-citycard');
      expect(scoreCard).not.toBeNull();
      expect(scoreCard).toHaveClass('km-citycard--feat');
    });

    it('the honest-empty past-papers list carries the giwa/watermark texture (devices #3/#6), never fabricated data', async () => {
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await user.click(
        screen.getByRole('button', { name: /Reading mock exams/i }),
      );
      const empty = await screen.findByText(
        /No past papers are available for this section yet/i,
      );
      const card = empty.closest('.km-giwa');
      expect(card).not.toBeNull();
      expect(card).toHaveClass('km-hangul-watermark');
      expect(card).toHaveAttribute('data-glyph', '기출');
    });

    it('a mobile-width exam head/nav row is allowed to wrap instead of clipping (F-129, no forced single-line overflow)', async () => {
      // jsdom/happy-dom don't lay out CSS, so this asserts the structural
      // hook the F-129 media query (MockMode.css, max-width: 380px) keys
      // off of — the SAME `.km-mock__exam-head`/`.km-mock__nav` elements the
      // rest of this suite already exercises — rather than a flaky pixel
      // measurement.
      const user = userEvent.setup();
      render(<MockMode />, { wrapper: MemoryRouter });
      await startExam(user, 'Reading');
      await waitFor(() => {
        expect(screen.getByRole('timer')).toBeInTheDocument();
      });
      expect(document.querySelector('.km-mock__exam-head')).toBeInTheDocument();
      expect(document.querySelector('.km-mock__nav')).toBeInTheDocument();
    });
  });
});

describe('F-220 P3 — generated mock (beta) flow', () => {
  beforeEach(() => {
    svc.fetchAttempt.mockResolvedValue(null);
    svc.fetchAvailableTests.mockResolvedValue({ tests: [], total: 0 });
    svc.fetchAttemptHistory.mockResolvedValue({ attempts: [], total: 0 });
    svc.fetchGeneratedMock.mockReset();
    svc.saveGeneratedMockProgress.mockReset();
    svc.submitGeneratedMock.mockReset();
    svc.saveGeneratedMockProgress.mockResolvedValue(undefined);
  });

  const ASSEMBLED = {
    attemptId: 'gm-1',
    tier: 'II' as const,
    section: 'reading' as const,
    items: [
      {
        id: 'single:501',
        kind: 'fill-blank',
        prompt: '생성형 문제 1번입니다.',
        choices: [
          { id: 'a' as const, kr: '가', en: 'A' },
          { id: 'b' as const, kr: '나', en: 'B' },
          { id: 'c' as const, kr: '다', en: 'C' },
          { id: 'd' as const, kr: '라', en: 'D' },
        ],
      },
      {
        id: 'group:g1:1',
        kind: 'paired-passage-mc',
        prompt: '생성형 문제 2번입니다.',
        passage: '공유 지문 텍스트입니다.',
        choices: [
          { id: 'a' as const, kr: '하나', en: 'One' },
          { id: 'b' as const, kr: '둘', en: 'Two' },
          { id: 'c' as const, kr: '셋', en: 'Three' },
          { id: 'd' as const, kr: '넷', en: 'Four' },
        ],
      },
    ],
    requestedCount: 50,
    currentIndex: 0,
    picks: {},
    remainingMs: 4_200_000,
    resumed: false,
  };

  const GENERATED_RESULT = {
    attemptId: 'gm-1',
    tier: 'II' as const,
    section: 'reading' as const,
    totalItems: 2,
    answered: 1,
    correct: 1,
    percentage: 50,
    band: 'L3 range',
    items: [
      {
        itemId: 'single:501',
        picked: 'a' as const,
        correctChoiceId: 'a' as const,
        isCorrect: true,
        explanation: '',
      },
      {
        itemId: 'group:g1:1',
        picked: null,
        correctChoiceId: 'b' as const,
        isCorrect: false,
        explanation: '설명입니다.',
      },
    ],
  };

  it('the entry link is on the section-select screen', () => {
    render(<MockMode />, { wrapper: MemoryRouter });
    expect(
      screen.getByRole('button', { name: /Try a generated mock/i }),
    ).toBeInTheDocument();
  });

  it('assembles a section, renders answer-stripped items, grades server-side, and shows results', async () => {
    svc.fetchGeneratedMock.mockResolvedValue(ASSEMBLED);
    svc.submitGeneratedMock.mockResolvedValue(GENERATED_RESULT);
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /Try a generated mock/i }));
    await user.click(screen.getByRole('button', { name: /Start/ }));

    await waitFor(() => {
      expect(screen.getByText('생성형 문제 1번입니다.')).toBeInTheDocument();
    });
    expect(svc.fetchGeneratedMock).toHaveBeenCalledWith(
      'II',
      'reading',
      expect.any(AbortSignal),
    );
    // Answer-strip: the wire item carries no correctness/explanation field.
    const served = (await svc.fetchGeneratedMock.mock.results[0]?.value) as typeof ASSEMBLED;
    expect(served.items[0]).not.toHaveProperty('correctChoiceId');
    expect(served.items[0]).not.toHaveProperty('explanation');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    // Pick the first item's answer, navigate to the paired-group question
    // (proving the shared passage renders), then submit.
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => {
      expect(screen.getByText('공유 지문 텍스트입니다.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Submit test/i }));

    await waitFor(() => {
      expect(screen.getByText(/L3 range/)).toBeInTheDocument();
    });
    expect(svc.submitGeneratedMock).toHaveBeenCalledWith(
      'gm-1',
      { picks: { 'single:501': 'a' } },
    );
  });

  it('a thin bank (items: []) shows an inline notice instead of entering the exam', async () => {
    svc.fetchGeneratedMock.mockResolvedValue({
      attemptId: null,
      tier: 'II',
      section: 'reading',
      items: [],
      requestedCount: 50,
      currentIndex: 0,
      picks: {},
      remainingMs: 4_200_000,
      resumed: false,
    });
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /Try a generated mock/i }));
    await user.click(screen.getByRole('button', { name: /Start/ }));

    await waitFor(() => {
      expect(screen.getByText(/Not enough generated items/i)).toBeInTheDocument();
    });
    // Still on the select screen — no exam item rendered.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('the flag being off (404) degrades to an inline error with retry, never a crash', async () => {
    svc.fetchGeneratedMock.mockRejectedValue(new Error('not found'));
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /Try a generated mock/i }));
    await user.click(screen.getByRole('button', { name: /Start/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });
  });

  it('"Back to mock" returns to the real mock section select', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /Try a generated mock/i }));
    await user.click(screen.getByRole('button', { name: /Back to mock/i }));

    expect(
      screen.getByRole('button', { name: /Reading mock exams/i }),
    ).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
