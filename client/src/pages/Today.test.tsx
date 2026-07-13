/**
 * Today — the action hub. Wave-2 "Seoul Day & Night" reskin + feature set
 * (F-128–F-140): loading + rendered + interaction.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. Five
 * fetches share the hook, dispatched on the `key` arg: the plan
 * (`today`), the F-007 open-exam lookup (`today.attempt`), and the three
 * F-138 attempt-history sources (`today.grammarAttempts`,
 * `today.writingAttempts`, `today.topikAttempts`). All are realFn-backed;
 * the hook mock here stands in for any source, so the screen assertions
 * hold regardless of which resolved. `services/topik`, `services/writing`,
 * and `services/grammarDrill` are also mocked so no realFn/generator
 * closure can touch the network.
 *
 * P3a/Wave-2 contract pinned here:
 *   - F-139: the vocab/"words" due-count tile is GONE — no due-count CTA,
 *     no "/learn/vocab" navigation anywhere on this page.
 *   - F-140: a Hanja tile lives in the Review & drills carousel →
 *     /learn/hanja.
 *   - F-135/F-136: "Today's tasks" + "TOPIK" collapse into one "Suggested
 *     learning" carousel covering Reading/Writing/Listening/TOPIK, with
 *     "Review mistakes" folded in as a shortcut on the TOPIK page (not its
 *     own carousel tab).
 *   - F-134: the Writing page is a `CollapsibleTile` that expands INLINE
 *     (aria-expanded toggles) instead of navigating to /learn/writing on
 *     tap; the "Write this topic" handoff inside it still navigates with
 *     the generated topic in `location.state` (F-101).
 *   - F-138: grammar/writing/TOPIK tiles show a real "done today" count
 *     derived from attempt-history fixtures, never a fabricated one.
 *   - NO "coming soon" placeholder survives anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import type { TodayPlan } from '../types/domain';
import type { AttemptState } from '../services/topik';
import { ApiError } from '../services/api';

// Hook mock — control loading + data per key. `vi.hoisted` is necessary
// because `vi.mock` is hoisted above imports; sharing mutable state requires
// the holder to be hoisted too, otherwise the factory hits TDZ.
const hoisted = vi.hoisted(() => {
  type HookState =
    | { kind: 'loading' }
    | { kind: 'data'; data: unknown }
    | { kind: 'error' };
  return {
    today: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    attempt: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    grammarAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    writingAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    topikAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const source =
      key === 'today' ? hoisted.today :
      key === 'today.attempt' ? hoisted.attempt :
      key === 'today.grammarAttempts' ? hoisted.grammarAttempts :
      key === 'today.writingAttempts' ? hoisted.writingAttempts :
      hoisted.topikAttempts;
    const s = source.state;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: source.refetch,
      };
    }
    if (s.kind === 'error') {
      return {
        data: null,
        loading: false,
        error: new Error('plan failed'),
        isMock: false,
        refetch: source.refetch,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: true,
      refetch: source.refetch,
    };
  },
}));

// The screen imports these for its realFn closures; with the hook mocked
// out entirely, realFn is never invoked, but the modules must still export
// something so no test path can reach the real axios layer.
vi.mock('../services/topik', () => ({
  fetchAttempt: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
  fetchAttemptHistory: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));
vi.mock('../services/writing', () => ({
  generateWritingPrompt: vi.fn(() =>
    Promise.reject(new Error('not wired in tests')),
  ),
  fetchWritingAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));
vi.mock('../services/grammarDrill', () => ({
  listAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// Pull the page AFTER the hook mock is set up so the screen wires to it.
import { Today } from './Today';
import { getChatContext } from '../lib/chatContext';
import { generateWritingPrompt } from '../services/writing';
import type { GeneratedWritingPrompt } from '../services/writing';

const generateMock = vi.mocked(generateWritingPrompt);

const PLAN: TodayPlan = {
  reviewCount: 24,
  reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
  listening: {
    title: 'KBS — 재택근무 확산',
    mins: 4,
    level: 'L3→L4',
    tag: 'Listening',
  },
  writing: {
    title: 'Paragraph in 합쇼체',
    mins: 8,
    level: 'L4',
    tag: 'Writing',
  },
  largestGap: 'Listening',
};

/** A saved F-007 mock attempt, as GET /topik/attempt returns it. */
const ATTEMPT: AttemptState = {
  section: 'listening',
  sourceTest: 60,
  currentIdx: 12,
  picks: { '101': 'a', '102': 'c' },
  remainingMs: 1_260_000,
  answered: 12,
  updatedAt: '2026-07-01T09:00:00.000Z',
};

/** A Claude-authored topic, as POST /writing/generate returns it. */
const GENERATED: GeneratedWritingPrompt = {
  promptKr: '환경 보호를 위한 개인의 역할에 대해 쓰십시오.',
  promptEn: 'Write about the individual’s role in protecting the environment.',
  lengthHint: '600-700자',
  mode: 'topik',
  rubric: 'topik_ii_54',
};

/** ISO timestamps for the F-138 "done today" fixtures — genuinely "today"
 *  and genuinely "not today" relative to the real system clock (the screen
 *  itself derives "today" from `new Date()`, so the fixtures must too —
 *  never `vi.useFakeTimers` here, matching the rest of this suite). */
const TODAY_ISO = new Date().toISOString();
const LONG_AGO_ISO = '2019-03-01T00:00:00.000Z';

const GRAMMAR_ATTEMPTS_EMPTY = { attempts: [], total: 0, limit: 20, offset: 0 };
const WRITING_ATTEMPTS_EMPTY = { attempts: [], limit: 20, offset: 0 };
const TOPIK_ATTEMPTS_EMPTY = { attempts: [], total: 0 };

const GRAMMAR_ATTEMPTS_MIXED = {
  attempts: [
    {
      id: 1,
      pattern_key: 'a-eoseo',
      pattern_display: '-아/어서',
      drill_type: 'fill_blank' as const,
      user_answer: '가서',
      score: 90,
      verdict: 'correct' as const,
      scored_at: TODAY_ISO,
    },
    {
      id: 2,
      pattern_key: 'a-eoseo',
      pattern_display: '-아/어서',
      drill_type: 'fill_blank' as const,
      user_answer: '와서',
      score: 80,
      verdict: 'correct' as const,
      scored_at: TODAY_ISO,
    },
    {
      id: 3,
      pattern_key: 'go-itda',
      pattern_display: '-고 있다',
      drill_type: 'transform' as const,
      user_answer: '하고 있다',
      score: 70,
      verdict: 'partial' as const,
      scored_at: LONG_AGO_ISO,
    },
  ],
  total: 3,
  limit: 20,
  offset: 0,
};

const WRITING_ATTEMPTS_MIXED = {
  attempts: [
    {
      id: 1,
      promptId: 5,
      rubric: 'topik_ii_54' as const,
      promptKr: '환경 문제',
      sample: '환경은 중요합니다.',
      totalScore: 40,
      maxTotal: 50,
      estimatedLevel: 'L4' as const,
      gradedAt: TODAY_ISO,
    },
  ],
  limit: 20,
  offset: 0,
};

const TOPIK_ATTEMPTS_MIXED = {
  attempts: [
    {
      attemptId: 'abc',
      section: '읽기' as const,
      sourceTest: 60,
      topikLevel: 'II' as const,
      correct: 18,
      totalItems: 20,
      completedAt: TODAY_ISO,
    },
    {
      attemptId: 'def',
      section: '듣기' as const,
      sourceTest: 58,
      topikLevel: 'II' as const,
      correct: 15,
      totalItems: 20,
      completedAt: LONG_AGO_ISO,
    },
  ],
  total: 2,
};

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/learn/grammar" element={<div>GRAMMAR PAGE</div>} />
        <Route path="/learn/hanja" element={<div>HANJA PAGE</div>} />
        <Route path="/learn/reading" element={<div>READING PAGE</div>} />
        <Route path="/learn/writing" element={<div>WRITING PAGE</div>} />
        <Route path="/learn/listen" element={<div>LISTENING PAGE</div>} />
        <Route path="/learn/topik" element={<div>TOPIK PAGE</div>} />
        <Route path="/review/mistakes" element={<div>MISTAKES PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Load every source with the happy-path fixtures (no saved attempt, no
 *  attempt history — the honest all-empty default). */
function loadDefaults(): void {
  hoisted.today.state = { kind: 'data', data: PLAN };
  hoisted.attempt.state = { kind: 'data', data: null };
  hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
  hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
  hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
}

/** Bring the Suggested-learning carousel's Writing page on-screen (page 2
 *  of 4 with the full PLAN fixture — Reading, Writing, Listening, TOPIK)
 *  and expand its CollapsibleTile (F-134: collapsed by default). Returns
 *  the carousel region. */
async function activateWritingPage(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const region = screen.getByRole('region', { name: 'Suggested learning' });
  await user.click(within(region).getByRole('tab', { name: 'Page 2 of 4' }));
  const header = within(region).getByRole('button', { name: /Paragraph in/ });
  if (header.getAttribute('aria-expanded') === 'false') {
    await user.click(header);
  }
  return region;
}

describe('Today', () => {
  beforeEach(() => {
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'loading' };
    hoisted.grammarAttempts.state = { kind: 'loading' };
    hoisted.writingAttempts.state = { kind: 'loading' };
    hoisted.topikAttempts.state = { kind: 'loading' };
    hoisted.today.refetch.mockClear();
    hoisted.attempt.refetch.mockClear();
    hoisted.grammarAttempts.refetch.mockClear();
    hoisted.writingAttempts.refetch.mockClear();
    hoisted.topikAttempts.refetch.mockClear();
    generateMock.mockReset();
    generateMock.mockRejectedValue(new Error('not wired in tests'));
  });

  it('renders loading skeletons while the plan is pending', () => {
    renderTodayAt();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
    expect(getChatContext()).toBeNull();
  });

  it('publishes the loaded plan to the chat-context store and retracts on unmount (Slice 3)', () => {
    loadDefaults();
    const { unmount } = renderTodayAt();

    const ctx = getChatContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.pageLabel).toBe('Today · 오늘');
    // Mirrors the visible tiles: reading/listening/writing titles — NOT the
    // review-count (F-139 removed its tile, so it is no longer summarised).
    expect(ctx?.summary).toContain('Listening: KBS — 재택근무 확산');
    expect(ctx?.summary).toContain('Reading: 도시화와 환경');
    expect(ctx?.summary).not.toContain('review');

    unmount();
    expect(getChatContext()).toBeNull();
  });

  // ── Review & drills carousel: Grammar + Hanja (F-139 / F-140) ──

  it('renders the title and the Review & drills carousel with grammar + Hanja pages (F-139/F-140)', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.getByRole('heading', { level: 1, name: '오늘 · Today' }),
    ).toBeInTheDocument();

    const lead = screen.getByRole('region', { name: 'Review and drills' });
    expect(lead).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(lead).getAllByRole('tab')).toHaveLength(2);

    expect(within(lead).getByText('Grammar drills')).toBeInTheDocument();
    expect(within(lead).getByText('Hanja study')).toBeInTheDocument();
  });

  it('F-139: never shows a vocab/"words" due-count tile or navigates to /learn/vocab', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.queryByText(/cards due/)).not.toBeInTheDocument();
    expect(screen.queryByText('지금 복습')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open review/ }),
    ).not.toBeInTheDocument();
  });

  it('F-140: navigates to /learn/hanja from the Hanja tile', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const lead = screen.getByRole('region', { name: 'Review and drills' });
    await user.click(within(lead).getByRole('tab', { name: 'Page 2 of 2' }));
    await user.click(screen.getByRole('button', { name: 'Open Hanja study' }));

    expect(screen.getByText('HANJA PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/grammar from the grammar drills tile (real page, not "coming soon")', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );

    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('loops the lead carousel: a real forward swipe on the last page wraps to page 1 (F-029)', () => {
    loadDefaults();
    renderTodayAt();

    const lead = screen.getByRole('region', { name: 'Review and drills' });
    const viewport = lead.querySelector('.km-carousel__viewport');
    expect(viewport).not.toBeNull();

    fireEvent.click(within(lead).getByRole('tab', { name: 'Page 2 of 2' }));
    const pointer = { pointerId: 7, isPrimary: true };
    fireEvent.pointerDown(viewport!, {
      ...pointer, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport!, { ...pointer, clientX: 140, clientY: 52 });
    fireEvent.pointerMove(viewport!, { ...pointer, clientX: 80, clientY: 55 });
    fireEvent.pointerUp(viewport!, { ...pointer, clientX: 80, clientY: 55 });

    expect(
      within(lead).getByRole('tab', { name: 'Page 1 of 2' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('renders NO coming-soon placeholder anywhere', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('준비 중')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily grammar drills')).not.toBeInTheDocument();
  });

  it('the Review & drills carousel has no plan dependency — it keeps working when the plan fails', async () => {
    hoisted.today.state = { kind: 'error' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );
    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('degrades a real plan failure to an honest ErrorCard in Suggested learning, wired to retry', async () => {
    hoisted.today.state = { kind: 'error' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    const user = userEvent.setup();
    renderTodayAt();

    expect(
      screen.getByText("Today's plan is unavailable."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(hoisted.today.refetch).toHaveBeenCalledTimes(1);
    expect(hoisted.attempt.refetch).not.toHaveBeenCalled();

    // TOPIK has no plan dependency — still present alongside the error (its
    // page is off-screen while the error page is active, hence `hidden`).
    expect(
      screen.getByRole('button', {
        name: 'Open TOPIK study practice',
        hidden: true,
      }),
    ).toBeInTheDocument();
  });

  it('no longer renders the stats carousel, the TOPIK-level snapshot, or any progress bar (moved to Progress / F-137)', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.queryByRole('region', { name: 'Progress by skill' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Progress by skill/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radiogroup', { name: 'Reference level' }),
    ).not.toBeInTheDocument();
    // F-137: the TOPIK tile carries no highlighted progress bar — this page
    // renders no `progressbar` role at all (every "done today" signal is
    // plain text + an honest SealStamp, never a fabricated meter).
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  // ── Suggested learning carousel (F-135/F-136) ───────────────

  it('renders the Suggested learning carousel with Reading/Writing/Listening/TOPIK pages in order', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(region).getAllByRole('tab')).toHaveLength(4);

    const panels = within(region).getAllByRole('tabpanel', { hidden: true });
    expect(within(panels[0]).getByText('도시화와 환경')).toBeInTheDocument();
    expect(within(panels[1]).getByText('Paragraph in 합쇼체', { exact: false })).toBeInTheDocument();
    expect(within(panels[2]).getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(
      within(panels[3]).getByRole('button', { name: 'Open TOPIK study practice', hidden: true }),
    ).toBeInTheDocument();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('navigates to /learn/reading when the Reading tile is clicked', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const tile = screen.getByRole('button', { name: /도시화와 환경/ });
    await user.click(tile);

    expect(screen.getByText('READING PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/listen when the Listening tile is clicked', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    await user.click(within(region).getByRole('tab', { name: 'Page 3 of 4' }));
    await user.click(screen.getByRole('button', { name: /KBS/ }));

    expect(screen.getByText('LISTENING PAGE')).toBeInTheDocument();
  });

  it('moves the "Largest gap" pill onto the modality named by largestGap', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, largestGap: 'Writing' },
    };
    renderTodayAt();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.queryByText('Register drill')).not.toBeInTheDocument();
  });

  it('omits a task page whose server task is null (empty corpus) — TOPIK still appends', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    renderTodayAt();

    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Suggested learning' });
    // Writing + Listening + TOPIK = 3 pages.
    expect(within(region).getAllByRole('tab')).toHaveLength(3);
  });

  // ── F-134 — Writing expands inline instead of navigating ────

  it('F-134: the Writing tile starts collapsed and does NOT navigate to /learn/writing on tap', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    await user.click(within(region).getByRole('tab', { name: 'Page 2 of 4' }));

    const header = within(region).getByRole('button', { name: /Paragraph in/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    await user.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    // Still on Today — no navigation happened.
    expect(screen.queryByText('WRITING PAGE')).not.toBeInTheDocument();
    // The generator is now reachable (previously inert while collapsed).
    expect(
      screen.getByRole('button', { name: /Generate topic/ }),
    ).toBeInTheDocument();

    // Toggling again collapses it.
    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  // ── F-027 — Claude topic generator on the Writing task page ─

  it('mounts the topic generator on the Writing page only, and renders a generated topic', async () => {
    loadDefaults();
    generateMock.mockResolvedValue(GENERATED);
    const user = userEvent.setup();
    renderTodayAt();

    expect(screen.getAllByRole('radiogroup', { hidden: true })).toHaveLength(1);

    await activateWritingPage(user);
    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    expect(await screen.findByText(GENERATED.promptKr)).toBeInTheDocument();
    expect(screen.getByText(GENERATED.promptEn)).toBeInTheDocument();
    expect(screen.getByText('600-700자')).toBeInTheDocument();
    expect(generateMock).toHaveBeenCalledWith(
      { mode: 'topik' },
      expect.any(AbortSignal),
    );
  });

  it('offers the TOPIK-style vs free-write choice and sends the chosen mode', async () => {
    loadDefaults();
    generateMock.mockResolvedValue({
      ...GENERATED,
      mode: 'general',
      rubric: null,
      lengthHint: null,
    });
    const user = userEvent.setup();
    renderTodayAt();

    await activateWritingPage(user);
    await user.click(screen.getByRole('radio', { name: /Free write/ }));
    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    expect(await screen.findByText(GENERATED.promptKr)).toBeInTheDocument();
    expect(generateMock).toHaveBeenCalledWith(
      { mode: 'general' },
      expect.any(AbortSignal),
    );
  });

  it('surfaces the expensive-bucket 429 with real retry copy, not a dead end', async () => {
    loadDefaults();
    generateMock.mockRejectedValue(
      new ApiError('too many requests', {
        status: 429,
        code: 'rate_limited',
        retryAfter: 42,
      }),
    );
    const user = userEvent.setup();
    renderTodayAt();

    await activateWritingPage(user);
    const button = screen.getByRole('button', { name: /Generate topic/ });
    await user.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Rate-limited. Try again in about 42 seconds.',
    );
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('F-101: "Write this topic" hands the exact generated topic to /learn/writing via location.state', async () => {
    loadDefaults();
    generateMock.mockResolvedValue(GENERATED);
    const user = userEvent.setup();

    function WritingRouteStub(): JSX.Element {
      const location = useLocation();
      return (
        <div>
          WRITING PAGE
          <pre data-testid="handoff-state">
            {JSON.stringify(location.state)}
          </pre>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/learn/writing" element={<WritingRouteStub />} />
        </Routes>
      </MemoryRouter>,
    );

    await activateWritingPage(user);
    await user.click(screen.getByRole('button', { name: /Generate topic/ }));
    await screen.findByText(GENERATED.promptKr);

    await user.click(
      screen.getByRole('button', { name: /Write this topic/ }),
    );

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
    const raw = screen.getByTestId('handoff-state').textContent;
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? 'null')).toEqual({
      generatedTopic: GENERATED,
    });
  });

  // ── TOPIK folded in (F-135/F-136) ────────────────────────────

  it('navigates to /learn/topik (study) from the recommended TOPIK tile', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    const tabs = within(region).getAllByRole('tab');
    await user.click(tabs[tabs.length - 1]);
    await user.click(
      screen.getByRole('button', { name: 'Open TOPIK study practice' }),
    );
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  it('offers "Review mistakes" as a folded-in shortcut on the TOPIK page (not a separate carousel tab)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    const tabs = within(region).getAllByRole('tab');
    await user.click(tabs[tabs.length - 1]);
    await user.click(screen.getByRole('button', { name: /Review mistakes/ }));

    expect(screen.getByText('MISTAKES PAGE')).toBeInTheDocument();
  });

  it('surfaces a saved mock attempt as the corner resume banner → /learn/topik', async () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT };
    const user = userEvent.setup();
    renderTodayAt();

    const banner = screen.getByRole('button', {
      name: 'Resume exam — Listening mock, 12 answered',
    });
    await user.click(banner);
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  it('renders NO resume banner when no attempt is saved (honest empty state)', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.queryByRole('button', { name: /Resume exam/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No exam in progress/)).not.toBeInTheDocument();
  });

  // ── F-138 — real per-tile "done today" counts ───────────────

  it('F-138: shows a REAL "done today" count for grammar, derived from attempt history filtered to today', () => {
    loadDefaults();
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_MIXED };
    renderTodayAt();

    // 2 of the 3 fixture rows are dated today; the third is from 2019.
    expect(screen.getByText('2 drills today')).toBeInTheDocument();
    expect(screen.getByText('Done today')).toBeInTheDocument();
  });

  it('F-138: shows a REAL "done today" count for writing and TOPIK, and omits the milestone at zero', async () => {
    loadDefaults();
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_MIXED };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_MIXED };
    const user = userEvent.setup();
    renderTodayAt();

    await activateWritingPage(user);
    expect(screen.getByText('1 essay graded today')).toBeInTheDocument();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    const tabs = within(region).getAllByRole('tab');
    await user.click(tabs[tabs.length - 1]);
    expect(screen.getByText('1 mock attempt today')).toBeInTheDocument();

    // Grammar stayed at the all-empty default — zero done today, no
    // milestone stamp rendered (never a fabricated one at zero).
    expect(screen.getByText('0 drills today')).toBeInTheDocument();
    expect(screen.getAllByText('Done today')).toHaveLength(2);
  });

  it('F-138: shows no count at all while an attempt-history source is still loading (never a fabricated zero)', () => {
    loadDefaults();
    hoisted.grammarAttempts.state = { kind: 'loading' };
    renderTodayAt();

    expect(screen.queryByText(/drills today/)).not.toBeInTheDocument();
  });

  // ── P3b — bilingual page chrome ────────────────────────────

  it('renders the section eyebrows and tile chrome bilingually in both-mode', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.getByText('추천 학습')).toBeInTheDocument();
    expect(screen.getByText('Suggested learning')).toBeInTheDocument();
    expect(screen.getByText('복습 · 드릴')).toBeInTheDocument();
    expect(screen.getByText('Review & drills')).toBeInTheDocument();
    expect(screen.getByText('문법 드릴')).toBeInTheDocument();
    expect(screen.getByText('한자 학습')).toBeInTheDocument();
    expect(screen.getByText('오답 복습')).toBeInTheDocument();
  });
});
