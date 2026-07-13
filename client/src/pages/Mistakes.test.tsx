/**
 * Mistakes page (F-021, reworked P3b: F-044/F-045/F-046/F-024; Wave-2
 * F-128/F-154 — square question-tile grid + Sheet popup) — render
 * behaviour over a mocked `useEndpointOrMock`.
 *
 * The hook is mocked so we drive the loading / data / empty / error surfaces
 * directly (mirrors Hanja.test.tsx). Fixtures pass through `vi.hoisted` so the
 * hoisted `vi.mock` factory can reference them. The CollapsibleTile / Sheet /
 * FilterSelect / BackButton primitives are REAL — the tests exercise the
 * actual disclosure, popup, filtering, and navigation behaviour, not mocks
 * of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import type { ApiError } from '../services/api';
import type { Mistake } from '../services/topik';

const hoisted = vi.hoisted(() => ({
  state: { kind: 'loading' } as
    | { kind: 'loading' }
    | { kind: 'data'; data: Mistake[] }
    | { kind: 'error' },
  /** The options the page handed to useEndpointOrMock on its last render —
   *  lets tests exercise the REAL `realFn` closure (fetch-limit contract). */
  lastOptions: null as { realFn?: () => unknown } | null,
}));

const FAKE_ERR = new Error('boom') as unknown as ApiError;

function resultFor(): UseEndpointOrMockResult<Mistake[]> {
  const s = hoisted.state;
  const refetch = vi.fn();
  if (s.kind === 'loading') {
    return { data: null, loading: true, error: null, isMock: false, refetch };
  }
  if (s.kind === 'error') {
    return { data: null, loading: false, error: FAKE_ERR, isMock: false, refetch };
  }
  return { data: s.data, loading: false, error: null, isMock: false, refetch };
}

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: vi.fn(
    (_key: string, _mockFn: unknown, options?: { realFn?: () => unknown }) => {
      hoisted.lastOptions = options ?? null;
      return resultFor();
    },
  ),
}));
vi.mock('../services/topik', () => ({ fetchMistakes: vi.fn() }));

import Mistakes from './Mistakes';
import { fetchMistakes } from '../services/topik';

/** Study-mode miss — July 6. */
const MISTAKE: Mistake = {
  responseId: 'r1',
  picked: 'a', // wrong — 'b' is correct
  answeredAt: '2026-07-06T09:00:00.000Z',
  mode: 'study',
  item: {
    id: 'i1',
    section: '읽기',
    number: 12,
    level: 4,
    prompt: '알맞은 것을 고르십시오.',
    options: [
      { id: 'a', kr: '가 오답', en: '', correct: false },
      { id: 'b', kr: '나 정답', en: '', correct: true },
      { id: 'c', kr: '다', en: '', correct: false },
      { id: 'd', kr: '라', en: '', correct: false },
    ],
    explanation: '정답은 나입니다.',
    hasImage: false,
  },
};

/**
 * Second study-mode miss in the SAME (local day, mode) session as MISTAKE —
 * five minutes later, so both timestamps share a local calendar day for any
 * real UTC offset. Distinct item so the two tiles are tellable apart.
 */
const MISTAKE_SAME_SESSION: Mistake = {
  ...MISTAKE,
  responseId: 'r3',
  picked: 'c', // wrong — 'b' is correct
  answeredAt: '2026-07-06T09:05:00.000Z',
  item: {
    ...MISTAKE.item,
    id: 'i3',
    number: 20,
    prompt: '빈칸에 알맞은 말을 고르십시오.',
  },
};

/** Mock-exam miss two days earlier — a distinct (day, mode) session. */
const MISTAKE_MOCK: Mistake = {
  responseId: 'r2',
  picked: 'c',
  answeredAt: '2026-07-04T12:00:00.000Z',
  mode: 'mock',
  item: {
    id: 'i2',
    section: '듣기',
    number: 8,
    level: 3,
    prompt: '들은 내용과 같은 것을 고르십시오.',
    options: [
      { id: 'a', kr: '회의가 취소되었다.', en: '', correct: false },
      { id: 'b', kr: '여자는 서류를 못 찾았다.', en: '', correct: true },
      { id: 'c', kr: '두 사람은 점심을 먹었다.', en: '', correct: false },
      { id: 'd', kr: '남자는 회의에 늦었다.', en: '', correct: false },
    ],
    explanation: '여자의 말이 근거입니다.',
    hasImage: false,
  },
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Mistakes />
    </MemoryRouter>,
  );
}

/**
 * F-154 — the square question-number tile for a given mistake. Every tile's
 * accessible name is `Question ${number}, ${section}, ${modeLabel} — tap to
 * review`, so a plain number match is enough to disambiguate.
 */
function questionTile(number: number): HTMLElement {
  return screen.getByRole('button', {
    name: new RegExp(`^Question ${String(number)}, `),
  });
}

/** Open the study-mode question's tile (item.number === 12) and return the
 *  resolved popup dialog. */
async function openStudyMistake(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(questionTile(12));
  return screen.findByRole('dialog');
}

/**
 * Lands at `/chat` after an "Ask about this" click (F-020) and prints the
 * router state the navigation carried, so the test can assert the seed.
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

describe('Mistakes page (F-021 + P3b rework)', () => {
  beforeEach(() => {
    hoisted.state = { kind: 'loading' };
    hoisted.lastOptions = null;
    vi.mocked(fetchMistakes).mockClear();
  });

  // ── F-154: square question-tile grid, divided by session/date ─────────

  it('F-154: each miss renders as a small square question-number tile, grouped under its own date/session divider', () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    renderPage();
    // Two distinct (day, mode) groups → two dividers, each carrying the
    // session label (day · mode · missed count), matching the km-final.html
    // Mistakes mock (date-divided groups of square tiles).
    // Scoped to the divider itself — the same session label also appears
    // (unavoidably) as a <select><option>, which getByText would otherwise
    // also match.
    expect(
      screen.getByText(/학습 · 1 missed/, { selector: '.km-mistakes__divider' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/모의고사 · 1 missed/, {
        selector: '.km-mistakes__divider',
      }),
    ).toBeInTheDocument();
    // Each tile is a real button carrying just the question number visibly,
    // with the full identity in its accessible name.
    const tile = questionTile(12);
    expect(tile).toHaveTextContent('12');
    expect(tile).toHaveAccessibleName('Question 12, 읽기, 학습 — tap to review');
    // No popup open yet — the Sheet dialog doesn't exist until a tile is
    // tapped.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('F-154: tapping a tile opens the Sheet popup with the question, the answer key, and a "See explanation" reveal', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    renderPage();
    const dialog = await openStudyMistake(user);

    // The question (+ the user's wrong pick, the correct option) is visible
    // immediately — no reveal needed for "the question, the user's answer".
    expect(within(dialog).getByText('알맞은 것을 고르십시오.')).toBeInTheDocument();
    expect(within(dialog).getByText('Your answer')).toBeInTheDocument();
    expect(
      within(dialog).getAllByText('나 정답').length,
    ).toBeGreaterThanOrEqual(1);

    // The explanation is NOT shown until the jump-to-explanation reveal —
    // this app has no separate explanation route, so the reveal expands it
    // in place rather than fabricating a deep link.
    expect(
      within(dialog).queryByText('정답은 나입니다.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Ask about this' }),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: /See explanation/ }),
    );
    expect(within(dialog).getByText('정답은 나입니다.')).toBeInTheDocument();
    expect(within(dialog).getByText('Correct answer')).toBeInTheDocument();
    // The Ask handoff is now reachable inside the revealed section.
    expect(
      within(dialog).getByRole('button', { name: 'Ask about this' }),
    ).toBeInTheDocument();
  });

  it('F-154: closing the popup removes the dialog', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    renderPage();
    await openStudyMistake(user);
    await user.click(
      screen.getByRole('button', { name: 'Close question detail' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ── F-044: session selector ───────────────────────────────────────────

  it('F-044: the session selector groups the log into (day, mode) sessions with an option each', () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const options = within(select).getAllByRole('option');
    // Placeholder ("All sessions") + one option per derived session.
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent(/All sessions/);
    // Newest session first (server order preserved).
    expect(options[1]).toHaveTextContent(/학습/);
    expect(options[2]).toHaveTextContent(/모의고사/);
  });

  it('F-044: multiple same-day same-mode misses merge into ONE session option with the real count', async () => {
    hoisted.state = {
      kind: 'data',
      data: [MISTAKE, MISTAKE_SAME_SESSION, MISTAKE_MOCK],
    };
    const user = userEvent.setup();
    renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const options = within(select).getAllByRole('option');
    // Placeholder + TWO sessions — the two study misses share one bucket.
    expect(options).toHaveLength(3);
    expect(options[1]).toHaveTextContent(/학습/);
    expect(options[1]).toHaveTextContent(/2 missed/);
    expect(options[2]).toHaveTextContent(/모의고사/);
    expect(options[2]).toHaveTextContent(/1 missed/);

    // Filtering to the merged session shows BOTH of its tiles, in the SAME
    // group (log order — insertion order within the bucket), and nothing
    // from the other one.
    await user.selectOptions(select, (options[1] as HTMLOptionElement).value);
    const first = questionTile(12);
    const second = questionTile(20);
    expect(
      first.compareDocumentPosition(second) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      screen.queryByRole('button', { name: /^Question 8, / }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('2 missed in this session')).toBeInTheDocument();
  });

  it('F-044: a data reshape that orphans the selected session falls back to "All sessions", not an empty list', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    const user = userEvent.setup();
    const view = renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const mockOption = within(select)
      .getAllByRole('option')
      .find((o) => /모의고사/.test(o.textContent ?? '')) as HTMLOptionElement;
    await user.selectOptions(select, mockOption.value);
    expect(screen.getByText('1 missed in this session')).toBeInTheDocument();

    // The log reshapes under the selection (e.g. the mock session aged out
    // of the 30-day window on a refetch) — its key no longer exists.
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    view.rerender(
      <MemoryRouter>
        <Mistakes />
      </MemoryRouter>,
    );

    // The stale key degrades to the all-sessions scope: full list + total
    // stat, NOT a silently empty filtered view.
    const reshapedSelect = screen.getByRole('combobox', {
      name: /Session/,
    }) as HTMLSelectElement;
    expect(reshapedSelect.value).toBe('');
    expect(
      screen.getByText('1 missed in the last 30 days'),
    ).toBeInTheDocument();
    expect(questionTile(12)).toBeInTheDocument();
  });

  it('F-044: selecting a session filters the tile grid to that session\'s group only', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    const user = userEvent.setup();
    renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const mockOption = within(select)
      .getAllByRole('option')
      .find((o) => /모의고사/.test(o.textContent ?? '')) as HTMLOptionElement;
    await user.selectOptions(select, mockOption.value);
    // Only the mock-exam session's tile (and its divider) remains.
    expect(questionTile(8)).toBeInTheDocument();
    expect(
      screen.queryByText(/학습 · 1 missed/, {
        selector: '.km-mistakes__divider',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Question 12, / }),
    ).not.toBeInTheDocument();
    // Clearing back to the placeholder restores every group.
    await user.selectOptions(select, '');
    expect(questionTile(12)).toBeInTheDocument();
    expect(questionTile(8)).toBeInTheDocument();
  });

  // ── F-045: honest per-session / per-scope stats ───────────────────────

  it('F-045: session options carry the missed count, and the stat line totals the visible scope', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    const user = userEvent.setup();
    renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const options = within(select).getAllByRole('option');
    expect(options[1]).toHaveTextContent(/1 missed/);
    expect(options[2]).toHaveTextContent(/1 missed/);
    // All-sessions scope stat.
    expect(
      screen.getByText('2 missed in the last 30 days'),
    ).toBeInTheDocument();
    // Session-scoped stat after filtering.
    const mockOption = options.find((o) =>
      /모의고사/.test(o.textContent ?? ''),
    ) as HTMLOptionElement;
    await user.selectOptions(select, mockOption.value);
    expect(screen.getByText('1 missed in this session')).toBeInTheDocument();
  });

  // ── F-045: fetch-cap honesty (the server silently defaults limit=100) ─

  it('F-045: the real fetch asks for the server max (limit 200), never the silent 100 default', () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    renderPage();
    // The page hands useEndpointOrMock a realFn closure — run it and assert
    // the wire contract it encodes.
    expect(hoisted.lastOptions?.realFn).toBeDefined();
    hoisted.lastOptions?.realFn?.();
    expect(vi.mocked(fetchMistakes)).toHaveBeenCalledWith({ limit: 200 });
  });

  it('F-045: a log that fills the fetch cap softens the stat to "most recent N" — no fabricated period total', () => {
    const bulk: Mistake[] = Array.from({ length: 200 }, (_, i) => ({
      ...MISTAKE,
      responseId: `bulk-${String(i)}`,
    }));
    hoisted.state = { kind: 'data', data: bulk };
    renderPage();
    expect(
      screen.getByText('Your most recent 200 missed'),
    ).toBeInTheDocument();
    // The truncated fetch must NOT be presented as a 30-day total.
    expect(
      screen.queryByText(/missed in the last 30 days/),
    ).not.toBeInTheDocument();
  });

  // ── F-020: Chat handoff (behaviour preserved through the rework) ──────

  it('F-020: a mistake opened from its tile carries an "Ask about this" handoff seeded with the item', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/review/mistakes']}>
        <Routes>
          <Route path="/review/mistakes" element={<Mistakes />} />
          <Route path="/chat" element={<ChatSeedProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const dialog = await openStudyMistake(user);
    // The handoff lives behind the explanation reveal (F-154).
    await user.click(
      within(dialog).getByRole('button', { name: /See explanation/ }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Ask about this' }),
    );

    // The navigation carried the mistake's fields into the Chat seed.
    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('알맞은 것을 고르십시오.');
    expect(probe.textContent).toContain('Correct answer: 나 정답');
    expect(probe.textContent).toContain('My answer: 가 오답 (incorrect)');
    expect(probe.textContent).toContain('Why: 정답은 나입니다.');
    expect(probe.textContent).toContain('mode=topik_prep');
  });

  // ── F-024: back control to the Library index ──────────────────────────

  it('F-024: the BackButton navigates to the canonical parent route /review', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/review/mistakes']}>
        <Routes>
          <Route path="/review/mistakes" element={<Mistakes />} />
          <Route
            path="/review"
            element={<div data-testid="review-library">library</div>}
          />
        </Routes>
      </MemoryRouter>,
    );
    // The label comes from navItem('review') — the tab is "Library" (F-043).
    await user.click(screen.getByRole('button', { name: 'Back to Library' }));
    expect(screen.getByTestId('review-library')).toBeInTheDocument();
  });

  // ── F-046: writing review (stubbed pending F-106) ─────────────────────

  it('F-046: the writing-review section renders its two parts as collapsed tiles with honest coming-soon copy', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Writing review/ }),
    ).toBeInTheDocument();
    const topikTile = screen.getByRole('button', {
      name: /TOPIK writing responses/,
    });
    const promptsTile = screen.getByRole('button', {
      name: /Generated prompts/,
    });
    expect(topikTile).toHaveAttribute('aria-expanded', 'false');
    expect(promptsTile).toHaveAttribute('aria-expanded', 'false');
    // Expanding shows the HONEST stub — no fabricated history rows.
    await user.click(topikTile);
    const body = document.getElementById(
      topikTile.getAttribute('aria-controls') as string,
    ) as HTMLElement;
    expect(within(body).getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('F-046: the writing-review section renders even while mistakes are loading or errored', () => {
    hoisted.state = { kind: 'error' };
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Writing review/ }),
    ).toBeInTheDocument();
  });

  // ── Load / empty / error states (F-021 behaviour preserved) ───────────

  it('shows a single-line empty state (P3b trim) with Korean present, and no session selector', () => {
    hoisted.state = { kind: 'data', data: [] };
    renderPage();
    expect(
      screen.getByText(/No mistakes in the last 30 days/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/최근 30일간 틀린 문제가 없어요/),
    ).toBeInTheDocument();
    const empty = document.querySelector('.km-mistakes__empty');
    expect(empty).not.toBeNull();
    expect(empty?.querySelectorAll('p')).toHaveLength(1);
    // No sessions to select from — the filter row is absent, not empty.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders the nav-manifest eyebrow bilingually in both-mode', () => {
    hoisted.state = { kind: 'data', data: [] };
    renderPage();
    // nav.ts pair: Missed questions · 틀린 문제 모음.
    expect(screen.getByText('Missed questions')).toBeInTheDocument();
    expect(screen.getByText('틀린 문제 모음')).toBeInTheDocument();
  });

  it('shows an error state when the load fails', () => {
    hoisted.state = { kind: 'error' };
    renderPage();
    expect(
      screen.getByText(/couldn't load your mistakes/i),
    ).toBeInTheDocument();
  });
});
