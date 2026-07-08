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
}));

vi.mock('../../services/topik', () => ({
  fetchMockTest: svc.fetchMockTest,
  submitMockTest: svc.submitMockTest,
  fetchAttempt: svc.fetchAttempt,
  saveAttempt: svc.saveAttempt,
  clearAttempt: svc.clearAttempt,
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
  section: 'reading',
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
 * Drive the mock flow start → submit → confirm → results (no answers needed
 * — `submitMockTest` is mocked, so the graded rows come from the fixture).
 */
async function driveToResults(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(
    screen.getByRole('button', { name: /Start Reading mock test/i }),
  );
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
    svc.fetchMockTest.mockResolvedValue(TEST);
    svc.submitMockTest.mockResolvedValue(RESULT);
    // No saved attempt by default (no resume banner); saves/clears are no-ops.
    svc.fetchAttempt.mockResolvedValue(null);
    svc.saveAttempt.mockResolvedValue(undefined);
    svc.clearAttempt.mockResolvedValue(undefined);
  });

  it('renders the section select with a disabled Writing card', () => {
    render(<MockMode />, { wrapper: MemoryRouter });
    expect(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Start Listening mock test/i }),
    ).toBeEnabled();
    const writing = screen.getByRole('button', {
      name: /Writing mock test, coming soon/i,
    });
    expect(writing).toBeDisabled();
  });

  it('starts a section → enters the exam with answer-stripped items', async () => {
    const user = userEvent.setup();
    render(<MockMode />, { wrapper: MemoryRouter });

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );

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
    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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
    await user.click(
      screen.getByRole('button', { name: /Start Listening mock test/i }),
    );
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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
    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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
      picks: Record<string, string>;
    };
    expect(lastSave.sourceTest).toBe(7);
    expect(lastSave.picks).toMatchObject({ '1001': 'b', '1002': 'a' });

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

    // New mock returns to section select.
    await user.click(screen.getByRole('button', { name: /New mock/i }));
    expect(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    ).toBeInTheDocument();
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
    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );

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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );

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

    await user.click(
      screen.getByRole('button', { name: /Start Reading mock test/i }),
    );
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
    // Still on the select screen, sections startable.
    const reading = screen.getByRole('button', {
      name: /Start Reading mock test/i,
    });
    expect(reading).toBeEnabled();

    // Starting a fresh section clears the notice.
    await user.click(reading);
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
      fireEvent.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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

      await user.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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

      await user.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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

      await user.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );

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

      await user.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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
      await user.click(
        screen.getByRole('button', { name: /Start Reading mock test/i }),
      );
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
});

afterEach(() => {
  vi.clearAllMocks();
});
