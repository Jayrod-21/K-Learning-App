/**
 * Mistakes page (F-021, reworked P3b: F-044/F-045/F-046/F-024) — render
 * behaviour over a mocked `useEndpointOrMock`.
 *
 * The hook is mocked so we drive the loading / data / empty / error surfaces
 * directly (mirrors Hanja.test.tsx). Fixtures pass through `vi.hoisted` so the
 * hoisted `vi.mock` factory can reference them. The CollapsibleTile /
 * FilterSelect / BackButton primitives are REAL — the tests exercise the
 * actual disclosure, filtering, and navigation behaviour, not mocks of it.
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

/** The study-mode question's tile toggle (header carries section · number). */
function studyTileToggle(): HTMLElement {
  return screen.getByRole('button', { name: /읽기 · 12번 · 학습/ });
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

  // ── F-044: collapsible question tiles ─────────────────────────────────

  it('F-044: each miss renders as a tile that starts COLLAPSED (aria-expanded=false, body hidden)', () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    renderPage();
    const toggle = studyTileToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The disclosure body is the aria-controls target and is hidden from AT.
    const bodyId = toggle.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    const body = document.getElementById(bodyId as string);
    expect(body).not.toBeNull();
    expect(body).toHaveAttribute('aria-hidden', 'true');
    // Interactive content inside the collapsed body is NOT reachable.
    expect(
      screen.queryByRole('button', { name: 'Ask about this' }),
    ).not.toBeInTheDocument();
  });

  it('F-044: expanding a tile reveals the full review — prompt, correct answer, wrong-pick tag, explanation', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE] };
    const user = userEvent.setup();
    renderPage();
    const toggle = studyTileToggle();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(
      toggle.getAttribute('aria-controls') as string,
    ) as HTMLElement;
    expect(body).toHaveAttribute('aria-hidden', 'false');
    // Full review content (scoped to the body region — the header snippet
    // also carries the prompt, so page-global text queries would be soft).
    expect(within(body).getByText('알맞은 것을 고르십시오.')).toBeInTheDocument();
    expect(within(body).getByText('정답은 나입니다.')).toBeInTheDocument();
    expect(within(body).getByText('Your answer')).toBeInTheDocument();
    expect(within(body).getByText('Correct answer')).toBeInTheDocument();
    expect(within(body).getByText('정답')).toBeInTheDocument();
    expect(
      within(body).getAllByText('나 정답').length,
    ).toBeGreaterThanOrEqual(1);
    // The Ask handoff is now reachable.
    expect(
      screen.getByRole('button', { name: 'Ask about this' }),
    ).toBeInTheDocument();
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

    // Filtering to the merged session shows BOTH of its tiles (log order —
    // insertion order within the bucket), and nothing from the other one.
    await user.selectOptions(select, (options[1] as HTMLOptionElement).value);
    const first = screen.getByRole('button', { name: /읽기 · 12번 · 학습/ });
    const second = screen.getByRole('button', { name: /읽기 · 20번 · 학습/ });
    expect(
      first.compareDocumentPosition(second) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      screen.queryByRole('button', { name: /듣기 · 8번 · 모의고사/ }),
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
    expect(
      screen.getByRole('button', { name: /읽기 · 12번 · 학습/ }),
    ).toBeInTheDocument();
  });

  it('F-044: selecting a session filters the tile list to that session only', async () => {
    hoisted.state = { kind: 'data', data: [MISTAKE, MISTAKE_MOCK] };
    const user = userEvent.setup();
    renderPage();
    const select = screen.getByRole('combobox', { name: /Session/ });
    const mockOption = within(select)
      .getAllByRole('option')
      .find((o) => /모의고사/.test(o.textContent ?? '')) as HTMLOptionElement;
    await user.selectOptions(select, mockOption.value);
    // Only the mock-exam session's tile remains.
    expect(
      screen.getByRole('button', { name: /듣기 · 8번 · 모의고사/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /읽기 · 12번 · 학습/ }),
    ).not.toBeInTheDocument();
    // Clearing back to the placeholder restores the full list.
    await user.selectOptions(select, '');
    expect(
      screen.getByRole('button', { name: /읽기 · 12번 · 학습/ }),
    ).toBeInTheDocument();
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

  it('F-020: an expanded miss carries an "Ask about this" handoff seeded with the item', async () => {
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

    await user.click(studyTileToggle()); // expand first — collapsed body is inert
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

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
