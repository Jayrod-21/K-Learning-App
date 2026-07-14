/**
 * Today — the action hub, restructured into THREE carousels per direct
 * user feedback (mobile-hardening pass; see Today.tsx's module header for
 * the full rationale):
 *
 *   1. "Review & drills" (native scroll-snap peek slider — SAME mechanism
 *      as #2, converted from `SwipeCarousel` per a later direct user
 *      request that the two carousels feel identical) — Vocab (restored,
 *      reversing F-139) / Grammar / Hanja, in that order, all
 *      simultaneously real+focusable (no page-hiding).
 *   2. "Suggested learning" (native scroll-snap peek slider, NOT a
 *      `SwipeCarousel`) — Reading / Listening / Writing, all
 *      simultaneously real+focusable (no page-hiding).
 *   3. "TOPIK" (`SwipeCarousel`, single page) — last, carrying the
 *      "Review mistakes" shortcut and the F-007 resume banner.
 *      `SwipeCarousel` is exercised ONLY here now.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. Five
 * fetches share the hook, dispatched on the `key` arg: the plan
 * (`today`), the F-007 open-exam lookup (`today.attempt`), and the three
 * F-138 attempt-history sources (`today.grammarAttempts`,
 * `today.writingAttempts`, `today.topikAttempts`). All are realFn-backed;
 * the hook mock here stands in for any source, so the screen assertions
 * hold regardless of which resolved. `services/topik`, `services/writing`,
 * and `services/grammarDrill` are also mocked so no realFn closure can
 * touch the network.
 *
 * Contract pinned here:
 *   - Vocab is a first-class tile again → `/learn/vocab`, reading its
 *     count off the plan's real `reviewCount` (never fabricated); it
 *     degrades to an honest ErrorCard when the plan fails, same as the
 *     peek slider — Grammar/Hanja/TOPIK have no plan dependency and keep
 *     working regardless.
 *   - F-140: Hanja lives in the Review & drills carousel → /learn/hanja.
 *   - Review & drills and Suggested learning are BOTH peek sliders — no
 *     tabs/dots, every tile on-screen and focusable simultaneously, no
 *     tab-switch needed to reach any tile.
 *   - The peek slider covers Reading/Writing/Listening; Writing NOW
 *     navigates to /learn/writing (F-134's inline CollapsibleTile expand
 *     doesn't fit the peek slider's fixed-width layout — see Today.tsx).
 *   - F-138: grammar/writing/TOPIK tiles show a real "done today" count
 *     derived from attempt-history fixtures, never a fabricated one.
 *   - The CSS mechanism (scroll-snap on the peek slider) is pinned from
 *     source, mirroring `SkillsCompare.test.tsx`'s established pattern for
 *     this codebase — happy-dom does no layout, so the actual on-screen
 *     scroll/snap behavior can't be measured by rendering.
 *   - NO "coming soon" placeholder survives anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { TodayPlan } from '../types/domain';
import type { AttemptState } from '../services/topik';

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
  fetchWritingAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));
vi.mock('../services/grammarDrill', () => ({
  listAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// Pull the page AFTER the hook mock is set up so the screen wires to it.
import { Today } from './Today';
import { getChatContext } from '../lib/chatContext';

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
        <Route path="/learn/vocab" element={<div>VOCAB PAGE</div>} />
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
    // Mirrors the visible tiles: the live due-review count (Vocab restored)
    // plus reading/listening/writing titles.
    expect(ctx?.summary).toContain('24 review cards due');
    expect(ctx?.summary).toContain('Listening: KBS — 재택근무 확산');
    expect(ctx?.summary).toContain('Reading: 도시화와 환경');

    unmount();
    expect(getChatContext()).toBeNull();
  });

  it('renders exactly THREE carousels: Review & drills, Suggested learning, TOPIK — TOPIK last', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.getByRole('heading', { level: 1, name: '오늘 · Today' }),
    ).toBeInTheDocument();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    // Review & drills is now the SAME peek-slider widget as Suggested
    // learning (converted from SwipeCarousel per direct user request) — a
    // plain labeled region, not a paged carousel.
    expect(drills).not.toHaveAttribute('aria-roledescription');

    const suggested = screen.getByRole('region', { name: 'Suggested learning' });
    expect(suggested).not.toHaveAttribute('aria-roledescription');

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    expect(topik).toHaveAttribute('aria-roledescription', 'carousel');

    // Order in the DOM: drills, then suggested, then TOPIK last.
    const order = Array.from(
      document.querySelectorAll(
        '[aria-label="Review and drills"], [aria-label="Suggested learning"], [aria-roledescription="carousel"]',
      ),
    );
    expect(order).toEqual([drills, suggested, topik]);
  });

  it('Review & drills and Suggested learning are the SAME peek-slider mechanism — same track/item classes, no tabs on either', () => {
    loadDefaults();
    renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    const suggested = screen.getByRole('region', { name: 'Suggested learning' });

    expect(within(drills).queryAllByRole('tab')).toHaveLength(0);
    expect(within(suggested).queryAllByRole('tab')).toHaveLength(0);

    expect(drills.querySelector('.km-today__peekTrack')).not.toBeNull();
    expect(suggested.querySelector('.km-today__peekTrack')).not.toBeNull();
    expect(drills.querySelectorAll('.km-today__peekItem')).toHaveLength(3);
  });

  // ── Carousel 1 — Review & drills: Vocab (restored) / Grammar / Hanja ──

  it('Vocab tile is RESTORED as a first-class activity — first tile of Review & drills, real due-count, routes to /learn/vocab', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    // Vocab, Grammar, and Hanja are all on-screen at once — no tab switch
    // needed to reach any of them (same peek-slider mechanism as Carousel 2).
    expect(screen.getByText('24 cards due')).toBeInTheDocument();
    expect(screen.getByText('지금 복습')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Open review — 24 cards due' }),
    );
    expect(screen.getByText('VOCAB PAGE')).toBeInTheDocument();
  });

  it('singularizes the Vocab due-count copy at exactly 1', () => {
    loadDefaults();
    hoisted.today.state = { kind: 'data', data: { ...PLAN, reviewCount: 1 } };
    renderTodayAt();

    expect(screen.getByText('1 card due')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open review — 1 card due' }),
    ).toBeInTheDocument();
  });

  it('degrades the Vocab tile to an honest ErrorCard when the plan fails, wired to retry — Grammar/Hanja keep working', async () => {
    hoisted.today.state = { kind: 'error' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    const user = userEvent.setup();
    renderTodayAt();

    const lead = screen.getByRole('region', { name: 'Review and drills' });
    expect(
      within(lead).getByText("Today's plan is unavailable."),
    ).toBeInTheDocument();
    await user.click(within(lead).getByRole('button', { name: 'Retry' }));
    expect(hoisted.today.refetch).toHaveBeenCalledTimes(1);

    // Grammar has no plan dependency — it's on-screen the whole time (same
    // peek-slider mechanism as Carousel 2, no tab switch needed) and still
    // navigates correctly even though the plan failed.
    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );
    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('F-140: navigates to /learn/hanja from the Hanja tile', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: 'Open Hanja study' }));

    expect(screen.getByText('HANJA PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/grammar from the grammar drills tile (real page not "coming soon")', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );

    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('renders NO coming-soon placeholder anywhere', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('준비 중')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily grammar drills')).not.toBeInTheDocument();
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

  // ── Carousel 2 — Suggested learning peek slider ─────────────────────

  it('renders the Suggested learning peek slider with Reading/Listening/Writing all simultaneously real+focusable (no page-hiding)', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    // No SwipeCarousel dots/tabs here — every tile is on-screen at once.
    expect(within(region).queryAllByRole('tab')).toHaveLength(0);

    expect(within(region).getByText('도시화와 환경')).toBeInTheDocument();
    expect(within(region).getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(
      within(region).getByText('Paragraph in 합쇼체', { exact: false }),
    ).toBeInTheDocument();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('navigates to /learn/reading when the Reading tile is clicked — no tab switch needed', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /도시화와 환경/ }));

    expect(screen.getByText('READING PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/listen when the Listening tile is clicked — no tab switch needed', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /KBS/ }));

    expect(screen.getByText('LISTENING PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/writing when the Writing tile is clicked (F-134 inline-expand replaced by direct nav)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Paragraph in/ }));

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
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

  it('omits a peek tile whose server task is null (empty corpus)', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    renderTodayAt();

    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Suggested learning' });
    expect(within(region).getAllByRole('button')).toHaveLength(2);
  });

  it('shows an honest empty message when reading/listening/writing are all null (never a broken empty scroll rail)', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null, listening: null, writing: null },
    };
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(region).getByText('No suggested content right now'),
    ).toBeInTheDocument();
  });

  it('degrades the Suggested learning peek slider to an honest ErrorCard when the plan fails, wired to retry', async () => {
    hoisted.today.state = { kind: 'error' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    expect(
      within(region).getByText("Today's plan is unavailable."),
    ).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(hoisted.today.refetch).toHaveBeenCalledTimes(1);

    // TOPIK has no plan dependency — still present and fully interactive.
    expect(
      screen.getByRole('button', { name: 'Open TOPIK study practice' }),
    ).toBeInTheDocument();
  });

  it('CSS: the peek slider (shared by Review & drills and Suggested learning) uses native scroll-snap, not a JS carousel', () => {
    // happy-dom does no layout, so the actual on-screen scroll/snap
    // behavior can't be measured by rendering — pin the CSS mechanism from
    // source instead (same pattern as SkillsCompare.test.tsx's mobile-
    // overflow-fix contract test). Both carousels render the SAME
    // `.km-today__peek{Track,Item}` classes, so this single source-level
    // pin covers both — see the runtime structural check above
    // ("same peek-slider mechanism") that both regions actually use them.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );

    const trackRule =
      /\.km-today__peekTrack\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(trackRule).not.toBe('');
    expect(trackRule).toContain('overflow-x: auto;');
    expect(trackRule).toContain('scroll-snap-type: x mandatory;');

    const itemRule =
      /\.km-today__peekItem\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(itemRule).not.toBe('');
    expect(itemRule).toContain('scroll-snap-align: center;');
    // Peek geometry: a tile narrower than 100% so its neighbors are
    // partially visible at the edges.
    expect(itemRule).toMatch(/flex:\s*0 0 78%;/);

    // Reduced-motion: the progressive center-emphasis animation is
    // explicitly disabled, never left running. Matched structurally (not
    // just a substring search) so this can't false-match the base
    // `.km-today__peekItem` rule declared earlier in the file.
    const reducedMotionBlock =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.km-today__peekItem \{[^}]*\}\s*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(reducedMotionBlock).not.toBe('');
    expect(reducedMotionBlock).toContain('animation: none;');
  });

  // ── Carousel 3 — TOPIK, last ──────────────────────────────────────

  it('navigates to /learn/topik (study) from the recommended TOPIK tile — no tab switch needed', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open TOPIK study practice' }),
    );
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  it('offers "Review mistakes" as a folded-in shortcut on the TOPIK carousel (not a separate carousel/page)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Review mistakes/ }));

    expect(screen.getByText('MISTAKES PAGE')).toBeInTheDocument();
  });

  it('surfaces a saved mock attempt as the TOPIK carousel\'s corner resume banner → /learn/topik', async () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT };
    const user = userEvent.setup();
    renderTodayAt();

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    const banner = within(topik).getByRole('button', {
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

  it('F-138: shows REAL "done today" counts for writing and TOPIK at a glance — no tap/expand needed, and omits the milestone at zero', () => {
    loadDefaults();
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_MIXED };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_MIXED };
    renderTodayAt();

    expect(screen.getByText('1 essay graded today')).toBeInTheDocument();
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
    expect(screen.getByText('토픽')).toBeInTheDocument();
    expect(screen.getAllByText('TOPIK').length).toBeGreaterThan(0);
    expect(screen.getByText('문법 드릴')).toBeInTheDocument();
    expect(screen.getByText('한자 학습')).toBeInTheDocument();
    expect(screen.getByText('오답 복습')).toBeInTheDocument();
  });
});
