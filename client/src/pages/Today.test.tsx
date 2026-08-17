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
 * We mock `useEndpointOrMock` to control the data the screen reads. EIGHT
 * fetches share the hook, dispatched on the `key` arg: the plan (`today`),
 * the F-007 open-exam lookup (`today.attempt`), and six F-138 attempt-history
 * sources (`today.grammarAttempts`, `today.writingAttempts`,
 * `today.topikAttempts`, and — Wave 2 backend batch —
 * `today.hanjaAttempts`, `today.readingAttempts`, `today.listeningAttempts`).
 * All are realFn-backed; the hook mock here stands in for any source, so the
 * screen assertions hold regardless of which resolved. `services/topik`,
 * `services/writing`, `services/grammarDrill`, `services/hanja`,
 * `services/reading`, and `services/ttmik` are also mocked so no realFn
 * closure can touch the network.
 *
 * Contract pinned here:
 *   - Vocab is a first-class tile again → `/learn/vocab?study=due`, reading
 *     its count off the plan's real `reviewCount` (never fabricated); it
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
 *   - F-138: grammar/writing/TOPIK/Hanja/Reading/Listening tiles show a
 *     real "done today" count derived from attempt-history fixtures, never
 *     a fabricated one.
 *   - Wave 2 (B4/B5/B6): Reading/Listening/Writing deep-link to the EXACT
 *     item shown (`?chapter=`/`?story=`, `?corpus=&episode=`, `?promptId=`),
 *     falling back to the bare landing page only when the plan payload
 *     lacks the relevant field — asserted via the full pathname+search a
 *     `LocationProbe` renders on each target route.
 *   - The CSS mechanism (scroll-snap on the peek slider) is pinned from
 *     source, mirroring `SkillsCompare.test.tsx`'s established pattern for
 *     this codebase — happy-dom does no layout, so the actual on-screen
 *     scroll/snap behavior can't be measured by rendering.
 *   - NO "coming soon" placeholder survives anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { JSX } from 'react';
import type { Recommendation, TodayPlan } from '../types/domain';
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
    hanjaAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    readingAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
    listeningAttempts: { state: { kind: 'loading' } as HookState, refetch: vi.fn() },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const source =
      key === 'today' ? hoisted.today :
      key === 'today.attempt' ? hoisted.attempt :
      key === 'today.grammarAttempts' ? hoisted.grammarAttempts :
      key === 'today.writingAttempts' ? hoisted.writingAttempts :
      key === 'today.hanjaAttempts' ? hoisted.hanjaAttempts :
      key === 'today.readingAttempts' ? hoisted.readingAttempts :
      key === 'today.listeningAttempts' ? hoisted.listeningAttempts :
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
vi.mock('../services/hanja', () => ({
  fetchHanjaAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));
vi.mock('../services/reading', () => ({
  listReadingAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));
vi.mock('../services/ttmik', () => ({
  listListeningAttempts: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// Pull the page AFTER the hook mock is set up so the screen wires to it.
import { Today } from './Today';
import { getChatContext } from '../lib/chatContext';
// F-212 P4 — the real mock fixture, to pin that the mock path renders the
// Recommended-next card (fixture parity, not a hand-rolled stand-in).
import { TODAY_FIXTURE } from '../data/mocks/today';

const PLAN: TodayPlan = {
  reviewCount: 24,
  // Wave 2 deep-link fields (sourceKind/chapterId, corpus/episodeNumber,
  // promptId) — a chapter-sourced reading pick by default; a dedicated test
  // below covers the story-sourced case separately.
  reading: {
    title: '도시화와 환경',
    mins: 3,
    level: 'L4',
    tag: 'Reading',
    sourceKind: 'chapter',
    chapterId: 501,
  },
  listening: {
    title: 'KBS — 재택근무 확산',
    mins: 4,
    level: 'L3→L4',
    tag: 'Listening',
    corpus: 'iyagi',
    episodeNumber: 42,
  },
  writing: {
    title: 'Paragraph in 합쇼체',
    mins: 8,
    level: 'L4',
    tag: 'Writing',
    promptId: 77,
    // F-134: the full prompt body of bank row 77 — the tile previews it.
    promptKr: '재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.',
  },
  largestGap: 'Listening',
  // F-212 P4 — the default plan carries NO recommendation (cold-start /
  // pre-P4 shape), so every pre-existing test above the P4 describe block
  // also implicitly pins the additive-only contract: no card, everything
  // else unchanged. The P4 block below swaps in real recommendations.
  recommendation: null,
};

/** A saved F-007 mock attempt, as GET /topik/attempt returns it. `totalItems`
 *  (F-173) is deliberately DIFFERENT from `answered` so a test asserting the
 *  real total can't pass by coincidence against a fallback-to-`answered`
 *  value. */
const ATTEMPT: AttemptState = {
  section: 'listening',
  sourceTest: 60,
  currentIdx: 12,
  picks: { '101': 'a', '102': 'c' },
  remainingMs: 1_260_000,
  answered: 12,
  totalItems: 20,
  updatedAt: '2026-07-01T09:00:00.000Z',
};

/** F-173 — a pre-F-173 attempt fixture missing `totalItems` entirely (an
 *  older saved attempt, or a fixture predating the field). The client type
 *  marks it optional for exactly this case; the resumed-progress readout
 *  must fall back to the real `answered` count, never fabricate a total. */
const ATTEMPT_NO_TOTAL: AttemptState = {
  section: 'reading',
  sourceTest: 41,
  currentIdx: 7,
  picks: { '201': 'b' },
  remainingMs: 900_000,
  answered: 7,
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
const HANJA_ATTEMPTS_EMPTY = { attempts: [], total: 0, limit: 20, offset: 0 };
const READING_ATTEMPTS_EMPTY = { attempts: [], total: 0, limit: 20, offset: 0 };
const LISTENING_ATTEMPTS_EMPTY = { attempts: [], total: 0, limit: 20, offset: 0 };

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

const HANJA_ATTEMPTS_MIXED = {
  attempts: [
    {
      id: 1,
      cardId: 9,
      char: '計',
      rating: 'good',
      correct: true,
      createdAt: TODAY_ISO,
    },
    {
      id: 2,
      cardId: 10,
      char: '算',
      rating: 'again',
      correct: false,
      createdAt: LONG_AGO_ISO,
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

const READING_ATTEMPTS_MIXED = {
  attempts: [
    {
      id: 1,
      sourceKind: 'chapter' as const,
      chapterId: 501,
      storyId: null,
      titleSnapshot: '1장',
      passageNumber: 3,
      completedAt: TODAY_ISO,
    },
    {
      id: 2,
      sourceKind: 'story' as const,
      chapterId: null,
      storyId: 12,
      titleSnapshot: '옛날 이야기',
      passageNumber: null,
      completedAt: LONG_AGO_ISO,
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

const LISTENING_ATTEMPTS_MIXED = {
  attempts: [
    {
      id: 1,
      sourceKind: 'iyagi_episode' as const,
      lessonId: null,
      episodeId: 42,
      titleSnapshot: 'Iyagi #42: KBS — 재택근무 확산',
      completedAt: TODAY_ISO,
    },
    {
      id: 2,
      sourceKind: 'ttmik_lesson' as const,
      lessonId: 7,
      episodeId: null,
      titleSnapshot: 'Level 3 Lesson 7',
      completedAt: LONG_AGO_ISO,
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

/** Renders the destination label plus the FULL path+query it was reached
 *  at, so tests can assert the exact URL (including search params) Today
 *  navigated to — a route match alone (react-router ignores `?search` when
 *  matching `path`) can't catch a missing/wrong query param, which is
 *  exactly the bug class both nav fixes below guard against. */
function LocationProbe({ label }: { label: string }): JSX.Element {
  const location = useLocation();
  return (
    <div>
      {label} {location.pathname}
      {location.search}
    </div>
  );
}

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route
          path="/learn/vocab"
          element={<LocationProbe label="VOCAB PAGE" />}
        />
        <Route path="/learn/grammar" element={<div>GRAMMAR PAGE</div>} />
        <Route path="/learn/hanja" element={<div>HANJA PAGE</div>} />
        <Route
          path="/learn/reading"
          element={<LocationProbe label="READING PAGE" />}
        />
        <Route
          path="/learn/writing"
          element={<LocationProbe label="WRITING PAGE" />}
        />
        <Route
          path="/learn/listen"
          element={<LocationProbe label="LISTENING PAGE" />}
        />
        <Route
          path="/learn/topik"
          element={<LocationProbe label="TOPIK PAGE" />}
        />
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
  hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_EMPTY };
  hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_EMPTY };
  hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_EMPTY };
}

describe('Today', () => {
  beforeEach(() => {
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'loading' };
    hoisted.grammarAttempts.state = { kind: 'loading' };
    hoisted.writingAttempts.state = { kind: 'loading' };
    hoisted.topikAttempts.state = { kind: 'loading' };
    hoisted.hanjaAttempts.state = { kind: 'loading' };
    hoisted.readingAttempts.state = { kind: 'loading' };
    hoisted.listeningAttempts.state = { kind: 'loading' };
    hoisted.today.refetch.mockClear();
    hoisted.attempt.refetch.mockClear();
    hoisted.grammarAttempts.refetch.mockClear();
    hoisted.writingAttempts.refetch.mockClear();
    hoisted.topikAttempts.refetch.mockClear();
    hoisted.hanjaAttempts.refetch.mockClear();
    hoisted.readingAttempts.refetch.mockClear();
    hoisted.listeningAttempts.refetch.mockClear();
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

  it('F-177: renders the header via the shared PageHubHeader recipe, not its own inline SkylineHeader+DancheongRail copy', () => {
    loadDefaults();
    const { container } = renderTodayAt();

    // PageHubHeader's own class names — proof the shared component (not a
    // hand-rolled duplicate) rendered the header.
    expect(
      container.querySelector('.km-hubheader__skyline'),
    ).not.toBeNull();
    expect(
      container.querySelector('.km-hubheader__rail-divider'),
    ).not.toBeNull();

    // The old page-local classes this recipe used to carry (removed from
    // Today.css alongside the migration) must be gone — never left dangling
    // as dead-but-harmless markup.
    expect(container.querySelector('.km-today__skyline')).toBeNull();
    expect(container.querySelector('.km-today__rail-divider')).toBeNull();

    // Content/semantics unchanged: real <h1>, same id as the page's own
    // `aria-labelledby`, same bilingual pair.
    const h1 = screen.getByRole('heading', { level: 1, name: '오늘 · Today' });
    expect(h1).toHaveAttribute('id', 'today-title');
    expect(container.querySelector('.screen.km-today')).toHaveAttribute(
      'aria-labelledby',
      'today-title',
    );
  });

  it('F-177: restores the page\'s own extra 14px of title-to-rail-divider gap via a scoped `.km-today__hub` override (same fix Progress.tsx got)', () => {
    // Before this migration, Today.css's own `.km-today__title` carried
    // `margin: 4px 0 14px` — one step more bottom margin than the shared
    // `PageHubHeader.css`'s base recipe (`margin: 4px 0 0`). Progress.tsx's
    // migration restored this via a `className="km-progress__hub"` +
    // scoped `.km-progress__hub .km-hubheader__title { margin-bottom: 14px }`
    // override; Today's initial migration silently dropped it (BLOCKER-1,
    // REVIEW_polish-logic.md / REVIEW_polish-fidelity.md). happy-dom does no
    // layout, so the actual computed gap can't be measured by rendering —
    // pin both halves of the fix from source instead (same CSS-source-read
    // pattern as the section-title/peek-slider tests elsewhere in this
    // file, and as Hanja.test.tsx's cross-file token pin).
    loadDefaults();
    const { container } = renderTodayAt();

    // Half 1: the DOM side — PageHubHeader must actually receive the
    // scoping className (it forwards `className` onto its `.km-hubheader`
    // root, per components/PageHubHeader.tsx).
    const hub = container.querySelector('.km-hubheader');
    expect(hub).not.toBeNull();
    expect(hub).toHaveClass('km-today__hub');

    // Half 2: the CSS side — the scoped override rule exists in Today.css
    // and restores exactly 14px, mirroring Progress.css's rule byte-for-byte
    // (module-scoped `.km-progress__hub` -> `.km-today__hub`).
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );
    const overrideRule =
      /\.km-today__hub \.km-hubheader__title\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(overrideRule).not.toBe('');
    expect(overrideRule).toContain('margin-bottom: 14px;');
  });

  it('Review & drills and Suggested learning are the SAME peek-slider mechanism — same track/item classes, no tabs on either', () => {
    loadDefaults();
    renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    const suggested = screen.getByRole('region', { name: 'Suggested learning' });

    expect(within(drills).queryAllByRole('tab')).toHaveLength(0);
    expect(within(suggested).queryAllByRole('tab')).toHaveLength(0);

    expect(drills.querySelector('.km-today__peek-track')).not.toBeNull();
    expect(suggested.querySelector('.km-today__peek-track')).not.toBeNull();
    expect(drills.querySelectorAll('.km-today__peek-item')).toHaveLength(3);
  });

  // ── Carousel 1 — Review & drills: Vocab (restored) / Grammar / Hanja ──

  it('Vocab tile is RESTORED as a first-class activity — MIDDLE tile of Review & drills (F-190), real due-count, routes to the FSRS due-review session (not the bare landing)', async () => {
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
    // Must land on /learn/vocab?study=due — Review.tsx's `study === 'due'`
    // branch, the actual FSRS flashcard session — NOT bare /learn/vocab
    // (the lists-first landing), which would cost an extra "Study" tap.
    expect(
      screen.getByText('VOCAB PAGE /learn/vocab?study=due'),
    ).toBeInTheDocument();
  });

  it('F-190: Review & drills opens with Vocab as the MIDDLE (centered) tile — Grammar / Vocab / Hanja in DOM order', () => {
    loadDefaults();
    renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    const items = within(drills).getAllByRole('button');
    // Three tile buttons, in DOM order — Vocab (the plan's due-review tile)
    // sits in the MIDDLE slot, not first, so the peek slider's native
    // scroll-snap centering lands on it (see the runtime centering test
    // below for the actual scrollIntoView wiring).
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAccessibleName('Open grammar drills');
    expect(items[1]).toHaveAccessibleName(
      'Open review — 24 cards due',
    );
    expect(items[2]).toHaveAccessibleName('Open Hanja study');
  });

  it('F-190: centers the Review & drills peek slider on the Vocab tile on mount (native scrollIntoView, once)', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    loadDefaults();
    renderTodayAt();

    const vocabTile = screen.getByRole('button', {
      name: 'Open review — 24 cards due',
    });
    const vocabItem = vocabTile.closest('.km-today__peek-item');
    expect(vocabItem).not.toBeNull();

    // Called exactly once (mount), inline-centered — never re-centers on
    // every render (attempt-history fetches resolving later must not yank
    // the view back to center out from under the user). `mock.contexts`
    // (not `mock.instances`, which vitest/jest reserve for `new`-operator
    // calls) records the `this` a plain method call like `el.scrollIntoView`
    // ran against.
    const centeringCalls = scrollIntoView.mock.contexts.filter(
      (ctx) => ctx === vocabItem,
    );
    expect(centeringCalls).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: 'center' }),
    );

    scrollIntoView.mockRestore();
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
    hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_EMPTY };
    hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_EMPTY };
    hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_EMPTY };
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

  it('F-178: the Hanja tile uses the shared ochre skill tone, not the pre-ochre plain fallback', () => {
    loadDefaults();
    renderTodayAt();

    const hanjaTile = screen
      .getByRole('button', { name: 'Open Hanja study' })
      .querySelector('.km-citycard');
    expect(hanjaTile).toHaveClass('km-tone--ochre');
    expect(hanjaTile).not.toHaveClass('km-tone--plain');

    // The tile's pill and "done today" SealStamp ride the same tone —
    // ochre throughout, not a mix of the old plain fallback and the newer
    // hue on just one element.
    expect(screen.getByText('연습').closest('.km-pill')).toHaveClass(
      'km-pill--ochre',
    );
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

  it('F-189: Vocab/Grammar/Hanja each carry a distinct canonical skill tone — the same tokens the LEARN honeycomb uses', () => {
    loadDefaults();
    renderTodayAt();

    const vocabTile = screen
      .getByRole('button', { name: 'Open review — 24 cards due' })
      .querySelector('.km-citycard');
    const grammarTile = screen
      .getByRole('button', { name: 'Open grammar drills' })
      .querySelector('.km-citycard');
    const hanjaTile = screen
      .getByRole('button', { name: 'Open Hanja study' })
      .querySelector('.km-citycard');

    // Vocab = blue (indigo); Hanja = ochre (locked, unchanged). Grammar
    // moves OFF "blue" (which used to cluster all three of these tiles
    // together as the same hue) onto "crimson" — a dedicated, fixed
    // (non-accent-tracking) hue added in the F-189 fix-pass round 4
    // (BLOCKER-2, REVIEW_r4-colors.md), which replaced the old "accent"
    // assignment: Grammar used to share the literal `--vermilion` token
    // (and CSS class) with TOPIK, fusing the two honeycomb tiles into one
    // shape and risking a 3-way collision with another skill's fixed hue
    // under the blue/mint accent presets. See lib/skill-colors.ts.
    expect(vocabTile).toHaveClass('km-tone--blue');
    expect(grammarTile).toHaveClass('km-tone--crimson');
    expect(grammarTile).not.toHaveClass('km-tone--blue');
    expect(grammarTile).not.toHaveClass('km-tone--accent');
    expect(hanjaTile).toHaveClass('km-tone--ochre');

    // All three are pairwise distinct tones — no more blue/blue/ochre
    // clustering.
    const tones = [vocabTile, grammarTile, hanjaTile].map(
      (el) =>
        Array.from(el?.classList ?? []).find((c) => c.startsWith('km-tone--')),
    );
    expect(new Set(tones).size).toBe(3);
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

  it('F-190: Suggested learning opens with Reading as the MIDDLE (centered) tile — Listening / Reading / Writing in DOM order', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Suggested learning' });
    const items = within(region).getAllByRole('button');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAccessibleName(/Open listening/);
    expect(items[1]).toHaveAccessibleName(/Open reading/);
    expect(items[2]).toHaveAccessibleName(/Open writing/);
  });

  it('F-190: centers the Suggested learning peek slider on the Reading tile on mount (native scrollIntoView, once)', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    loadDefaults();
    renderTodayAt();

    const readingTile = screen.getByRole('button', {
      name: /Open reading/,
    });
    const readingItem = readingTile.closest('.km-today__peek-item');
    expect(readingItem).not.toBeNull();

    const centeringCalls = scrollIntoView.mock.contexts.filter(
      (ctx) => ctx === readingItem,
    );
    expect(centeringCalls).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: 'center' }),
    );

    // Listening/Writing must NOT also have been centered — only Reading.
    const listeningItem = screen
      .getByRole('button', { name: /Open listening/ })
      .closest('.km-today__peek-item');
    const writingItem = screen
      .getByRole('button', { name: /Open writing/ })
      .closest('.km-today__peek-item');
    expect(
      scrollIntoView.mock.contexts.filter((ctx) => ctx === listeningItem),
    ).toHaveLength(0);
    expect(
      scrollIntoView.mock.contexts.filter((ctx) => ctx === writingItem),
    ).toHaveLength(0);

    scrollIntoView.mockRestore();
  });

  it('F-189: Reading/Listening/Writing each carry a distinct canonical skill tone — cyan/moss/violet, no more shared "blue"/"accent"', () => {
    loadDefaults();
    renderTodayAt();

    const readingTile = screen
      .getByRole('button', { name: /Open reading/ })
      .querySelector('.km-citycard');
    const listeningTile = screen
      .getByRole('button', { name: /Open listening/ })
      .querySelector('.km-citycard');
    const writingTile = screen
      .getByRole('button', { name: /Open writing/ })
      .querySelector('.km-citycard');

    expect(readingTile).toHaveClass('km-tone--cyan');
    expect(listeningTile).toHaveClass('km-tone--mint');
    expect(writingTile).toHaveClass('km-tone--violet');
    // Writing must no longer read "accent" — that's what used to collide
    // it with the TOPIK tile below (the F-189 first pass's tradeoff).
    expect(writingTile).not.toHaveClass('km-tone--accent');

    // TOPIK (a separate carousel) — F-189 fix-pass round 4 (BLOCKER-2,
    // REVIEW_r4-colors.md) gave it its OWN dedicated "stone" hue instead of
    // sharing "accent"/vermilion with Grammar: the shared-token arrangement
    // rendered Grammar and TOPIK as the identical CSS class (not just a
    // similar color) and could 3-way-collide with another skill's fixed
    // hue under the blue/mint accent presets. See lib/skill-colors.ts.
    const topikTile = screen
      .getByRole('button', { name: 'Open TOPIK study practice' })
      .querySelector('.km-citycard');
    expect(topikTile).toHaveClass('km-tone--stone');
    expect(topikTile).not.toHaveClass('km-tone--accent');
  });

  // ── Wave 2 (backend batch, TODAY_NAV_SCOPING.md B4/B5/B6) — deep-link
  // navigations. Each tile must land on the EXACT item it displays, not the
  // bare landing page — asserted via the full pathname+search LocationProbe
  // renders (a route-match alone would miss a wrong/missing query param).

  it('deep-links the Reading tile to the exact chapter shown — /learn/reading?chapter=<id>', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /도시화와 환경/ }));

    expect(
      screen.getByText('READING PAGE /learn/reading?chapter=501'),
    ).toBeInTheDocument();
  });

  it('deep-links the Reading tile to the exact generated story shown — /learn/reading?story=<id>', async () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        reading: {
          title: '옛날 이야기',
          mins: 4,
          level: 'L3',
          tag: 'Reading',
          sourceKind: 'story',
          storyId: 12,
        },
      },
    };
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /옛날 이야기/ }));

    expect(
      screen.getByText('READING PAGE /learn/reading?story=12'),
    ).toBeInTheDocument();
  });

  it('falls back to the bare Reading landing page when the plan carries no deep-link id (never fabricates one)', async () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
      },
    };
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /도시화와 환경/ }));

    expect(screen.getByText('READING PAGE /learn/reading')).toBeInTheDocument();
  });

  it('deep-links the Listening tile to the exact episode shown — /learn/listen?corpus=iyagi&episode=<n>', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /KBS/ }));

    expect(
      screen.getByText('LISTENING PAGE /learn/listen?corpus=iyagi&episode=42'),
    ).toBeInTheDocument();
  });

  it('falls back to the bare Listening landing page when the plan carries no episode key', async () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        listening: { title: 'KBS — 재택근무 확산', mins: 4, level: 'L3→L4', tag: 'Listening' },
      },
    };
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /KBS/ }));

    expect(screen.getByText('LISTENING PAGE /learn/listen')).toBeInTheDocument();
  });

  it('deep-links the Writing tile to the exact bank prompt shown — /learn/writing?promptId=<id>', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Paragraph in/ }));

    expect(
      screen.getByText('WRITING PAGE /learn/writing?promptId=77'),
    ).toBeInTheDocument();
  });

  it('falls back to the bare Writing landing page when the plan carries no promptId', async () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        writing: { title: 'Paragraph in 합쇼체', mins: 8, level: 'L4', tag: 'Writing' },
      },
    };
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Paragraph in/ }));

    expect(screen.getByText('WRITING PAGE /learn/writing')).toBeInTheDocument();
  });

  it('F-134: the Writing tile PREVIEWS the real prompt body from the plan', () => {
    loadDefaults();
    renderTodayAt();

    // The preview is the exact promptKr text of the SAME bank row the tile
    // deep-links to (promptId 77) — readable on the home page, inside the
    // tile button itself.
    const writingTile = screen.getByRole('button', { name: /Paragraph in/ });
    expect(
      within(writingTile).getByText(
        '재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.',
      ),
    ).toBeInTheDocument();
    // aria-label REPLACES the button's accessible name (its subtree is
    // presentational to AT), so the FULL prompt body must be folded into
    // the label — otherwise screen readers announce only the title and the
    // preview is invisible to the users who can't see the clamped text.
    expect(writingTile).toHaveAccessibleName(
      'Open writing — Paragraph in 합쇼체. 재택근무의 장점과 단점에 대해 200~300자로 쓰십시오.',
    );
  });

  it('F-134: no preview line renders when the plan carries no promptKr (older envelope)', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        writing: {
          title: 'Paragraph in 합쇼체',
          mins: 8,
          level: 'L4',
          tag: 'Writing',
          promptId: 77,
        },
      },
    };
    renderTodayAt();

    const writingTile = screen.getByRole('button', { name: /Paragraph in/ });
    // No fabricated stand-in text and no empty bordered stub.
    expect(
      writingTile.querySelector('.km-today__tile-prompt'),
    ).not.toBeInTheDocument();
    // …and the accessible name stays the plain title — no dangling period
    // or phantom preview folded into the label.
    expect(writingTile).toHaveAccessibleName(
      'Open writing — Paragraph in 합쇼체',
    );
  });

  it('F-134: an empty-string promptKr renders no preview stub and adds nothing to the accessible name', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: {
        ...PLAN,
        writing: {
          title: 'Paragraph in 합쇼체',
          mins: 8,
          level: 'L4',
          tag: 'Writing',
          promptId: 77,
          promptKr: '',
        },
      },
    };
    renderTodayAt();

    // Unreachable from the live server (prompt_kr is NOT NULL with a
    // length >= 1 CHECK) but the client type can't express the non-empty
    // invariant — an empty string must not paint an empty hairline-topped
    // stub or pollute the label.
    const writingTile = screen.getByRole('button', { name: /Paragraph in/ });
    expect(
      writingTile.querySelector('.km-today__tile-prompt'),
    ).not.toBeInTheDocument();
    expect(writingTile).toHaveAccessibleName(
      'Open writing — Paragraph in 합쇼체',
    );
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
    hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_EMPTY };
    hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_EMPTY };
    hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_EMPTY };
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
      /\.km-today__peek-track\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(trackRule).not.toBe('');
    expect(trackRule).toContain('overflow-x: auto;');
    expect(trackRule).toContain('scroll-snap-type: x mandatory;');

    const itemRule =
      /\.km-today__peek-item\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(itemRule).not.toBe('');
    expect(itemRule).toContain('scroll-snap-align: center;');
    // Peek geometry: a tile narrower than 100% so its neighbors are
    // partially visible at the edges.
    expect(itemRule).toMatch(/flex:\s*0 0 78%;/);

    // Reduced-motion: the progressive center-emphasis animation is
    // explicitly disabled, never left running. Matched structurally (not
    // just a substring search) so this can't false-match the base
    // `.km-today__peek-item` rule declared earlier in the file.
    const reducedMotionBlock =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.km-today__peek-item \{[^}]*\}\s*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(reducedMotionBlock).not.toBe('');
    expect(reducedMotionBlock).toContain('animation: none;');
  });

  // ── Carousel 3 — TOPIK, last ──────────────────────────────────────

  it('navigates to bare /learn/topik (chooser) from the recommended TOPIK tile — no tab switch needed; only the resume banner skips the chooser', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open TOPIK study practice' }),
    );
    expect(screen.getByText('TOPIK PAGE /learn/topik')).toBeInTheDocument();
  });

  it('offers "Review mistakes" as a folded-in shortcut on the TOPIK carousel (not a separate carousel/page)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Review mistakes/ }));

    expect(screen.getByText('MISTAKES PAGE')).toBeInTheDocument();
  });

  it('surfaces a saved mock attempt as the TOPIK carousel\'s corner resume banner → /learn/topik?mode=mock, skipping the Study/Mock chooser', async () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT };
    const user = userEvent.setup();
    renderTodayAt();

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    const banner = within(topik).getByRole('button', {
      name: 'Resume exam — Listening mock, 12 of 20 answered',
    });
    await user.click(banner);
    // Must carry `?mode=mock` — Topik.tsx seeds its Study/Mock chooser sheet
    // open ONLY when `mode` is absent from the URL, so a bare navigate would
    // strand "Resume exam" on the chooser instead of the in-progress exam.
    expect(
      screen.getByText('TOPIK PAGE /learn/topik?mode=mock'),
    ).toBeInTheDocument();
  });

  it('renders NO resume banner when no attempt is saved (honest empty state)', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.queryByRole('button', { name: /Resume exam/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No exam in progress/)).not.toBeInTheDocument();
  });

  // ── F-173 — real "X of N" resumed-attempt progress ───────────────

  it('F-173: renders a real "X of N" SubwayProgress + numeric readout for a resumed attempt, sourced from AttemptState.totalItems', () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT };
    renderTodayAt();

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    // The SubwayProgress bar itself: a real progressbar carrying the exact
    // answered/total the fixture set (12/20) — not a fabricated ratio.
    const bar = within(topik).getByRole('progressbar', {
      name: 'Resumed exam progress',
    });
    expect(bar).toHaveAttribute('aria-valuemin', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '20');
    expect(bar).toHaveAttribute('aria-valuenow', '13'); // 0-indexed `current` (12) + 1
    expect(bar).toHaveAttribute('aria-valuetext', '12 of 20 answered');
    // The paired numeric caption (Hanja.tsx's F-170 bar+readout convention) —
    // spells out the same real "12 of 20" for sighted users the dots alone
    // don't always convey.
    expect(within(topik).getByText('12 of 20 answered')).toBeInTheDocument();
  });

  it('F-173 fix-pass SHOULD-FIX #1: a saved attempt predating `totalItems` shows the honest "N answered" wording — no "of N", no ~100%-full bar that would read as "exam complete" beside "Resume exam"', () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT_NO_TOTAL };
    renderTodayAt();

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    // No fabricated "of N" — the fallback is a real lower bound, not a
    // known total, so it must not be presented as one.
    const banner = within(topik).getByRole('button', {
      name: 'Resume exam — Reading mock, 7 answered',
    });
    expect(banner).toBeInTheDocument();
    expect(
      within(topik).queryByRole('button', { name: /7 of 7 answered/ }),
    ).not.toBeInTheDocument();
    // No progress bar either — a bar built from `totalItems ?? answered`
    // always renders ~100% full, which is the "reads as complete" bug this
    // finding calls out.
    expect(
      within(topik).queryByRole('progressbar', { name: 'Resumed exam progress' }),
    ).not.toBeInTheDocument();
    expect(within(topik).getByText('7 answered')).toBeInTheDocument();
    expect(within(topik).queryByText(/7 of 7 answered/)).not.toBeInTheDocument();
  });

  it('F-173: renders no resumed-progress bar when no attempt is saved', () => {
    loadDefaults();
    renderTodayAt();

    const topik = screen.getByRole('region', { name: 'TOPIK' });
    expect(
      within(topik).queryByRole('progressbar', { name: 'Resumed exam progress' }),
    ).not.toBeInTheDocument();
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

  // ── Wave 2 (backend batch, F-171/F-172) — real "done today" counts for
  // Hanja/Reading/Listening, the three tiles that previously had no
  // attempt-history endpoint at all (module header). Same filtered-to-today
  // + honest-empty-default discipline as the pre-existing grammar/writing/
  // TOPIK counts above.

  it('F-171/F-172: shows a REAL "done today" count for Hanja, filtered to today', () => {
    loadDefaults();
    hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_MIXED };
    renderTodayAt();

    // 1 of the 2 fixture rows is dated today; the other is from 2019.
    expect(screen.getByText('1 character reviewed today')).toBeInTheDocument();
    expect(screen.getByText('Done today')).toBeInTheDocument();
  });

  it('F-171/F-172: shows REAL "done today" counts for Reading and Listening, and omits the milestone at zero', () => {
    loadDefaults();
    hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_MIXED };
    hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_MIXED };
    renderTodayAt();

    expect(screen.getByText('1 reading finished today')).toBeInTheDocument();
    expect(screen.getByText('1 episode finished today')).toBeInTheDocument();

    // Hanja stayed at the all-empty default — zero done today, no milestone
    // stamp rendered (never a fabricated one at zero).
    expect(screen.getByText('0 characters reviewed today')).toBeInTheDocument();
    expect(screen.getAllByText('Done today')).toHaveLength(2);
  });

  it('F-171/F-172: shows no count at all for Hanja/Reading/Listening while their sources are still loading (never a fabricated zero)', () => {
    loadDefaults();
    hoisted.hanjaAttempts.state = { kind: 'loading' };
    hoisted.readingAttempts.state = { kind: 'loading' };
    hoisted.listeningAttempts.state = { kind: 'loading' };
    renderTodayAt();

    expect(screen.queryByText(/reviewed today/)).not.toBeInTheDocument();
    expect(screen.queryByText(/finished today/)).not.toBeInTheDocument();
  });

  // ── P3b — bilingual page chrome ────────────────────────────

  it('renders the section titles and tile chrome bilingually in both-mode', () => {
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

  // ── Layout polish (mobile-hardening pass, direct user feedback) ──────

  it('renders the three section titles as real, centered `<h2>` headers — not the old small-eyebrow subscript', () => {
    loadDefaults();
    renderTodayAt();

    // The old eyebrow-styled subscript class is gone entirely; the new
    // header class is the ONLY thing carrying these three section titles.
    expect(document.querySelector('.km-today__section-eyebrow')).toBeNull();
    const titles = document.querySelectorAll('.km-today__section-title');
    expect(titles).toHaveLength(3);

    // Real headings (level 2, below the page's own `<h1>`), in carousel
    // order — Review & drills, then Suggested learning, then TOPIK.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(3);
    expect(headings[0]).toHaveTextContent('Review & drills');
    expect(headings[0]).toHaveClass('km-today__section-title');
    expect(headings[1]).toHaveTextContent('Suggested learning');
    expect(headings[1]).toHaveClass('km-today__section-title');
    expect(headings[2]).toHaveTextContent('TOPIK');
    expect(headings[2]).toHaveClass('km-today__section-title');

    // Suggested learning keeps its decorative Hangul-watermark glyph — only
    // the wrapping element changed (Eyebrow div → h2), not the device.
    expect(headings[1]).toHaveClass('km-hangul-watermark');
    expect(headings[1]).toHaveAttribute('data-glyph', '배');
  });

  it('CSS: section titles read as centered real headers, not a tiny eyebrow subscript', () => {
    // happy-dom does no layout, so visual centering/size can't be measured
    // by rendering — pin the CSS from source, same pattern as the peek-
    // slider mechanism test below.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );

    expect(stylesheet).not.toMatch(/\.km-today__section-eyebrow\s*\{/);

    const titleRule =
      /\.km-today__section-title\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(titleRule).not.toBe('');
    expect(titleRule).toContain('text-align: center;');
    // Meaningfully larger than the old 10px eyebrow and bold enough to read
    // as a header rather than a caption. rem, not px (F-086 / B-036
    // px->rem migration) — 1rem == 16px at the md root, same rendered size.
    expect(titleRule).toMatch(/font-size:\s*1rem;/);
    expect(titleRule).toMatch(/font-weight:\s*700;/);
  });

  it('CSS: vertical spacing between the three stacked sections is tightened', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );

    const sectionRule =
      /\.km-today__section\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(sectionRule).not.toBe('');
    // A section no longer piles its own bottom margin on top of the next
    // header's top margin — the header's margin-top is now the whole gap.
    expect(sectionRule).toContain('margin-bottom: 0;');

    const titleRule =
      /\.km-today__section-title\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    // The combined inter-section gap (section margin-bottom + title
    // margin-top) is well under the pre-tightening total of 24px (6px + the
    // old eyebrow's 18px).
    const marginMatch = /margin:\s*(\d+)px/.exec(titleRule);
    expect(marginMatch).not.toBeNull();
    expect(Number(marginMatch?.[1])).toBeLessThanOrEqual(12);
  });

  it('F-187: the TOPIK heading carries a scoped modifier that trims its top margin below the shared 12px — and ONLY the TOPIK heading', () => {
    loadDefaults();
    const { container } = renderTodayAt();

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings[0]).not.toHaveClass('km-today__section-title--topik');
    expect(headings[1]).not.toHaveClass('km-today__section-title--topik');
    expect(headings[2]).toHaveTextContent('TOPIK');
    expect(headings[2]).toHaveClass('km-today__section-title--topik');
    // Sanity: exactly one heading carries the modifier.
    expect(
      container.querySelectorAll('.km-today__section-title--topik'),
    ).toHaveLength(1);

    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );
    const modifierRule =
      /\.km-today__section-title--topik\s*\{[^}]*\}/.exec(stylesheet)?.[0] ??
      '';
    expect(modifierRule).not.toBe('');
    const modifierMargin = Number(
      /margin-top:\s*(\d+)px/.exec(modifierRule)?.[1] ?? NaN,
    );
    // Strictly less than the shared `.km-today__section-title` margin-top
    // (12px, asserted above) — the Suggested-learning → TOPIK boundary
    // specifically shrinks; Review&drills → Suggested-learning (which
    // reads fine) keeps the full 12px via the un-modified shared rule.
    expect(modifierMargin).toBeLessThan(12);
  });

  it('F-188: hides PageHubHeader\'s rail-divider glyph on Today ONLY, without collapsing the spacer box it reserves', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );

    // The fix targets the nested DancheongRail element specifically...
    const hideRule =
      /\.km-today__hub \.km-hubheader__rail-divider \.km-dancheong-rail\s*\{[^}]*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(hideRule).not.toBe('');
    expect(hideRule).toContain('display: none;');

    // ...never the wrapping `.km-hubheader__rail-divider` box itself — that
    // would collapse the header's own reserved spacing on top of removing
    // the stray line, an unrequested second change. (No rule targets the
    // bare wrapper selector directly — only the nested-rail selector above.)
    expect(stylesheet).not.toMatch(
      /\.km-today__hub \.km-hubheader__rail-divider\s*\{/,
    );

    // The wrapper element itself must still exist in the DOM (F-177's own
    // test already pins this — this is a belt-and-braces check that F-188
    // didn't quietly delete it instead of hiding just the inner rail).
    loadDefaults();
    const { container } = renderTodayAt();
    expect(
      container.querySelector('.km-hubheader__rail-divider'),
    ).not.toBeNull();
  });

  it('CSS: BOTH peek carousels scale the centered tile larger than its neighbors, scroll-driven, reduced-motion gated', () => {
    // happy-dom does no layout, so the actual on-screen scroll-driven scale
    // can't be measured by rendering — pin the CSS mechanism from source
    // (same pattern as the scroll-snap mechanism test above). Both
    // carousels render the same `.km-today__peek-item` class (asserted
    // structurally in the "SAME peek-slider mechanism" test above), so this
    // single source-level pin covers both.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );

    const supportsBlock =
      /@supports \(animation-timeline: view\(\)\) \{[\s\S]*?\n\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(supportsBlock).not.toBe('');

    // Center (50%) reads at full size/opacity; the partial neighbors (0%
    // /100%, at the track's edges) are visibly smaller AND dimmed — a real
    // size difference, not the earlier subtle 0.94 pop.
    const keyframes =
      /@keyframes km-today-peek-pop\s*\{[\s\S]*?\n {2}\}/.exec(supportsBlock)?.[0] ?? '';
    expect(keyframes).not.toBe('');
    const edgeBlock =
      /0%,\s*100%\s*\{([\s\S]*?)\}/.exec(keyframes)?.[1] ?? '';
    const centerBlock = /50%\s*\{([\s\S]*?)\}/.exec(keyframes)?.[1] ?? '';
    expect(edgeBlock).toMatch(/transform:\s*scale\(0\.88\);/);
    expect(centerBlock).toMatch(/transform:\s*scale\(1\);/);
    // Edge (neighbor) opacity is strictly lower than center opacity — a
    // real dim, not a no-op.
    const edgeOpacity = Number(/opacity:\s*([\d.]+);/.exec(edgeBlock)?.[1]);
    const centerOpacity = Number(/opacity:\s*([\d.]+);/.exec(centerBlock)?.[1]);
    expect(edgeOpacity).toBeGreaterThan(0);
    expect(edgeOpacity).toBeLessThan(centerOpacity);
    expect(centerOpacity).toBe(1);

    expect(supportsBlock).toContain('animation-timeline: view(inline);');

    // Reduced-motion: the scaling animation is explicitly disabled, never
    // left running — equal size, no scaling, matched structurally so this
    // can't false-match the base `.km-today__peek-item` rule.
    const reducedMotionBlock =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.km-today__peek-item \{[^}]*\}\s*\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(reducedMotionBlock).not.toBe('');
    expect(reducedMotionBlock).toContain('animation: none;');
  });
});

/**
 * F-212 Phase 4 — the "Recommended next" featured card.
 *
 * Contract pinned here:
 *   - A non-null `plan.recommendation` renders ONE featured ActivityTile
 *     (CityCard `feat` + the gold "Recommended" pill — the TOPIK tile's
 *     treatment) in its own labeled section ABOVE the Suggested-learning
 *     rail, wearing the dimension's canonical skill tone.
 *   - The WHY is honest and bilingual: the server-composed `reasonEn`/
 *     `reasonKr` render verbatim (never client-re-derived copy that could
 *     drift from the real ranking), plus a client framing line —
 *     "Suggested next step" normally, or the exploration framing ("let's
 *     build a read on your <dimension>", NO deficit claim) when
 *     `exploratory` is true. reasonEn is folded into the button's
 *     accessible name (the subtree is presentational to AT).
 *   - Navigation is id-built via the same href builders as every other tile
 *     (`?chapter=`/`?story=`, `?corpus=&episode=`, `/learn/vocab?study=due`,
 *     `/learn/grammar`) — NEVER the server's free-form `deepLink` string.
 *   - `recommendation: null` (cold-start, or an older server color) renders
 *     NO card and leaves the existing gap pill, tiles, and rails fully
 *     intact — the additive-only contract. (Every test in the main block
 *     above also runs with `recommendation: null`, so the whole legacy
 *     surface is implicitly pinned against regression too.)
 *   - Copy discipline: "Recommended" / "Suggested next step" — the page
 *     never claims "optimal" or a "best path".
 */
describe('Today — Recommended next card (F-212 P4)', () => {
  /** A sufficient-estimate weakest-dimension pick (the happy path). */
  const REC_LISTENING: Recommendation = {
    dimension: 'listening',
    exploratory: false,
    reasonCode: 'weakest_dimension',
    reasonEn: 'Listening is currently your weakest measured skill.',
    reasonKr: '현재 측정된 실력 중 듣기가 가장 약해요.',
    level: 'L3',
    deepLink: '/learn/listen?corpus=iyagi&episode=12',
    title: '이야기 #12 — 서울의 겨울',
    mins: 6,
    corpus: 'iyagi',
    episodeNumber: 12,
  };

  function loadWithRecommendation(rec: Recommendation): void {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, recommendation: rec },
    };
  }

  it('renders ONE featured card above the Suggested-learning rail, wearing the dimension\'s canonical tone + CityCard feat', () => {
    loadWithRecommendation(REC_LISTENING);
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Recommended next' });
    const buttons = within(region).getAllByRole('button');
    expect(buttons).toHaveLength(1);

    // Featured treatment: CityCard `feat` + the listening dimension's
    // canonical mint tone (the same SKILL_COLOR token the Listening tile
    // wears — one skill, one color, everywhere).
    const card = buttons[0]?.querySelector('.km-citycard');
    expect(card).toHaveClass('km-citycard--feat');
    expect(card).toHaveClass('km-tone--mint');

    // Position: strictly ABOVE the Suggested-learning rail, and below the
    // Review & drills carousel (slotted between the two).
    const suggested = screen.getByRole('region', { name: 'Suggested learning' });
    const drills = screen.getByRole('region', { name: 'Review and drills' });
    expect(
      region.compareDocumentPosition(suggested) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      drills.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the title, a dimension · level · mins meta line, and the gold Recommended pill', () => {
    loadWithRecommendation(REC_LISTENING);
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Recommended next' });
    expect(
      within(region).getByText('이야기 #12 — 서울의 겨울'),
    ).toBeInTheDocument();
    expect(within(region).getByText('Listening · L3 · 6 min')).toBeInTheDocument();
    expect(within(region).getByText('듣기 · L3 · 6분')).toBeInTheDocument();

    // The gold "Recommended" pill — the same treatment the TOPIK tile uses.
    const pill = within(region).getByText('Recommended').closest('.km-pill');
    expect(pill).toHaveClass('km-pill--gold');
    expect(within(region).getByText('추천')).toBeInTheDocument();
  });

  it('renders the server-composed WHY bilingually, verbatim, and folds reasonEn into the accessible name', () => {
    loadWithRecommendation(REC_LISTENING);
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Recommended next' });
    expect(
      within(region).getByText(
        'Listening is currently your weakest measured skill.',
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText('현재 측정된 실력 중 듣기가 가장 약해요.'),
    ).toBeInTheDocument();

    // aria-label REPLACES the button's accessible name (its subtree is
    // presentational to AT), so the WHY must be folded into the label —
    // same convention as the Writing tile's prompt preview.
    expect(within(region).getByRole('button')).toHaveAccessibleName(
      'Recommended next — 이야기 #12 — 서울의 겨울. Listening is currently your weakest measured skill.',
    );
  });

  it.each([
    ['weakest_dimension', false],
    ['due_backlog', false],
    ['low_confidence', false],
    ['baseline', false],
    ['exploration', true],
  ] as const)(
    'renders the card for reasonCode=%s with its server reason verbatim and the honest framing line',
    (reasonCode, exploratory) => {
      loadWithRecommendation({
        ...REC_LISTENING,
        reasonCode,
        exploratory,
        reasonEn: `Server reason for ${reasonCode}.`,
        reasonKr: `${reasonCode} 서버 사유.`,
      });
      renderTodayAt();

      const region = screen.getByRole('region', { name: 'Recommended next' });
      // The WHY is always the server's composed reason for THAT code —
      // rendered verbatim, whatever the code, so client copy can never
      // drift from the actual dominant scoring term.
      expect(
        within(region).getByText(`Server reason for ${reasonCode}.`),
      ).toBeInTheDocument();
      expect(
        within(region).getByText(`${reasonCode} 서버 사유.`),
      ).toBeInTheDocument();
      if (exploratory) {
        // Exploration framing — signal-gathering, never a deficit claim.
        expect(
          within(region).getByText("Let's build a read on your listening"),
        ).toBeInTheDocument();
        expect(
          within(region).queryByText('Suggested next step'),
        ).not.toBeInTheDocument();
      } else {
        expect(
          within(region).getByText('Suggested next step'),
        ).toBeInTheDocument();
      }
    },
  );

  it('exploratory pick frames as exploration in BOTH languages — no deficit wording', () => {
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'grammar',
      exploratory: true,
      reasonCode: 'exploration',
      reasonEn: 'We do not have enough grammar signal yet.',
      reasonKr: '아직 문법 데이터가 충분하지 않아요.',
      level: 'L3',
      title: 'Grammar drills',
    });
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Recommended next' });
    expect(
      within(region).getByText("Let's build a read on your grammar"),
    ).toBeInTheDocument();
    expect(
      within(region).getByText('문법 감각을 함께 알아봐요'),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText('Suggested next step'),
    ).not.toBeInTheDocument();
    // No deficit claim anywhere in the card for an unmeasured dimension.
    expect(within(region).queryByText(/weakest/i)).not.toBeInTheDocument();
  });

  it('cold-start (recommendation: null) renders NO card and leaves the existing rail + gap pill fully intact', () => {
    loadDefaults(); // PLAN carries recommendation: null
    renderTodayAt();

    expect(
      screen.queryByRole('region', { name: 'Recommended next' }),
    ).not.toBeInTheDocument();
    // The pre-P4 surface is untouched: all three suggested tiles, the
    // largest-gap pill, and the Review & drills carousel still render.
    const suggested = screen.getByRole('region', { name: 'Suggested learning' });
    expect(within(suggested).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Review and drills' }),
    ).toBeInTheDocument();
  });

  it('renders no card while the plan is still loading or after it failed (no fabricated pick)', () => {
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_EMPTY };
    hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_EMPTY };
    hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_EMPTY };
    const { unmount } = renderTodayAt();
    expect(
      screen.queryByRole('region', { name: 'Recommended next' }),
    ).not.toBeInTheDocument();
    unmount();

    hoisted.today.state = { kind: 'error' };
    renderTodayAt();
    expect(
      screen.queryByRole('region', { name: 'Recommended next' }),
    ).not.toBeInTheDocument();
  });

  // ── Deep links — id-built via the shared href builders, per dimension ──

  it('deep-links a listening recommendation to the exact episode — /learn/listen?corpus=iyagi&episode=<n>', async () => {
    loadWithRecommendation(REC_LISTENING);
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(
      screen.getByText('LISTENING PAGE /learn/listen?corpus=iyagi&episode=12'),
    ).toBeInTheDocument();
  });

  it('deep-links a reading recommendation to the exact chapter — /learn/reading?chapter=<id>', async () => {
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'reading',
      reasonCode: 'low_confidence',
      reasonEn: 'Your reading estimate is still uncertain.',
      reasonKr: '읽기 추정치가 아직 불확실해요.',
      deepLink: '/learn/reading?chapter=88',
      title: '3장 — 한강의 밤',
      sourceKind: 'chapter',
      chapterId: 88,
    });
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(
      screen.getByText('READING PAGE /learn/reading?chapter=88'),
    ).toBeInTheDocument();
  });

  it('deep-links a story-sourced reading recommendation — /learn/reading?story=<id>', async () => {
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'reading',
      deepLink: '/learn/reading?story=12',
      title: '옛날 이야기',
      sourceKind: 'story',
      storyId: 12,
    });
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(
      screen.getByText('READING PAGE /learn/reading?story=12'),
    ).toBeInTheDocument();
  });

  it('sends a vocab recommendation to the FSRS due-review session — /learn/vocab?study=due', async () => {
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'vocab',
      reasonCode: 'due_backlog',
      reasonEn: 'You have vocabulary reviews piling up.',
      reasonKr: '밀린 어휘 복습이 있어요.',
      deepLink: '/learn/vocab?study=due',
      title: 'Due vocabulary review',
      mins: 5,
    });
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(
      screen.getByText('VOCAB PAGE /learn/vocab?study=due'),
    ).toBeInTheDocument();
  });

  it('sends a grammar recommendation to the drills landing — /learn/grammar', async () => {
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'grammar',
      deepLink: '/learn/grammar',
      title: 'Grammar drills',
    });
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('NEVER navigates on the server deepLink string — a listening pick with no episode key falls back to the bare landing, ignoring deepLink entirely', async () => {
    const rec: Recommendation = {
      ...REC_LISTENING,
      // A hostile/garbage deepLink must be inert: navigation is id-built
      // (threat model — integer ids/enums only, no free-text URL surface).
      deepLink: 'https://evil.example/phish',
    };
    delete rec.corpus;
    delete rec.episodeNumber;
    loadWithRecommendation(rec);
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(screen.getByText('LISTENING PAGE /learn/listen')).toBeInTheDocument();
  });

  it('copy discipline: the page never claims "optimal" or a "best path"', () => {
    loadWithRecommendation(REC_LISTENING);
    renderTodayAt();

    expect(screen.queryByText(/optimal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/best path/i)).not.toBeInTheDocument();

    // The button's ACCESSIBLE NAME too — its aria-label replaces the
    // subtree for AT, so queryByText alone can't see a claim smuggled into
    // the label. Screen-reader users get the same honest copy.
    const button = within(
      screen.getByRole('region', { name: 'Recommended next' }),
    ).getByRole('button');
    const label = button.getAttribute('aria-label') ?? '';
    expect(label).not.toBe('');
    expect(label).not.toMatch(/optimal/i);
    expect(label).not.toMatch(/best path/i);
  });

  it('keeps exactly THREE .km-today__section-title h2 headers WITH the card present — the Recommended-next section adds no fourth header', () => {
    // Pins the locked layout decision: the card slots between Review &
    // drills and Suggested learning WITHOUT its own section header — the
    // page's h2 count must not grow when the recommendation renders.
    loadWithRecommendation(REC_LISTENING);
    renderTodayAt();

    expect(
      screen.getByRole('region', { name: 'Recommended next' }),
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll('.km-today__section-title'),
    ).toHaveLength(3);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(3);
    expect(headings[0]).toHaveTextContent('Review & drills');
    expect(headings[1]).toHaveTextContent('Suggested learning');
    expect(headings[2]).toHaveTextContent('TOPIK');
  });

  it('reading: a hostile deepLink is inert even WITH id fields present — navigation is id-built, never the server string', async () => {
    // Mirror of the listening hostile-deepLink test above, for the reading
    // dimension WITH its id fields intact: the id-built href must win and
    // the hostile string must never be navigated.
    loadWithRecommendation({
      ...REC_LISTENING,
      dimension: 'reading',
      deepLink: 'https://evil.example/phish',
      title: '3장 — 한강의 밤',
      sourceKind: 'chapter',
      chapterId: 88,
    });
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      within(
        screen.getByRole('region', { name: 'Recommended next' }),
      ).getByRole('button'),
    );
    expect(
      screen.getByText('READING PAGE /learn/reading?chapter=88'),
    ).toBeInTheDocument();
  });

  it('the mock fixture renders the card too (mock path parity)', () => {
    loadDefaults();
    hoisted.today.state = { kind: 'data', data: TODAY_FIXTURE };
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'Recommended next' });
    expect(TODAY_FIXTURE.recommendation).not.toBeNull();
    expect(
      within(region).getByText(TODAY_FIXTURE.recommendation?.title ?? ''),
    ).toBeInTheDocument();
  });
});

/**
 * Device-adaptive epic, Phase D1 — Today's tablet/desktop grid layout.
 *
 * `useDeviceClass` reads `window.matchMedia`; `src/test/setup.ts` installs a
 * `matches: false` default before every test (mobile-first baseline — see
 * that file's header for why), so every test ABOVE this block already
 * exercises the mobile peek-slider branch without any explicit stubbing.
 * This block stubs `matchMedia` to report tablet/desktop widths (same
 * `mockViewportWidth` idiom as `Shell.deviceAdaptive.test.tsx` /
 * `useDeviceClass.test.tsx`) to pin the grid branch, and re-confirms mobile
 * is unaffected at an EXPLICIT narrow width too (not just the implicit
 * default).
 */
describe('Today — device-adaptive grid layout (Phase D1)', () => {
  function mockViewportWidth(width: number): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        const m = /min-width:\s*(\d+)px/.exec(query);
        const threshold = m ? Number(m[1]) : 0;
        return {
          matches: width >= threshold,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as unknown as MediaQueryList;
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the mobile peek slider (not the grid) at the default test matchMedia — unchanged from before D1', () => {
    loadDefaults();
    const { container } = renderTodayAt();

    expect(container.querySelector('.km-today__peek-track')).not.toBeNull();
    expect(
      container.querySelectorAll('.km-today__peek-item').length,
    ).toBeGreaterThan(0);
    expect(container.querySelector('.km-today__grid')).toBeNull();
  });

  it('renders the mobile peek slider at an explicit narrow viewport too', () => {
    mockViewportWidth(375);
    loadDefaults();
    const { container } = renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    expect(drills.querySelector('.km-today__peek-track')).not.toBeNull();
    expect(drills.querySelectorAll('.km-today__peek-item')).toHaveLength(3);
    expect(container.querySelector('.km-today__grid')).toBeNull();
  });

  it('renders BOTH carousels as a plain grid — no peek-slider markup — at tablet width (768px)', () => {
    mockViewportWidth(768);
    loadDefaults();
    const { container } = renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    const suggested = screen.getByRole('region', {
      name: 'Suggested learning',
    });

    expect(drills.querySelector('.km-today__grid')).not.toBeNull();
    expect(drills.querySelectorAll('.km-today__grid-item')).toHaveLength(3);
    expect(suggested.querySelector('.km-today__grid')).not.toBeNull();
    expect(suggested.querySelectorAll('.km-today__grid-item')).toHaveLength(3);
    // No peek-slider markup survives anywhere on the page in the grid
    // branch — `TileRail` renders one markup or the other, never both.
    expect(container.querySelector('.km-today__peek-track')).toBeNull();
    expect(container.querySelector('.km-today__peek-item')).toBeNull();
  });

  it('renders the grid at desktop width (1280px) too, with every tile still real and focusable — same DOM order as mobile', () => {
    mockViewportWidth(1280);
    loadDefaults();
    renderTodayAt();

    const drills = screen.getByRole('region', { name: 'Review and drills' });
    const items = within(drills).getAllByRole('button');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAccessibleName('Open grammar drills');
    expect(items[1]).toHaveAccessibleName('Open review — 24 cards due');
    expect(items[2]).toHaveAccessibleName('Open Hanja study');
  });

  it('a tile in the grid branch keeps its exact deep-link navigation (Wave 2 B4) — grid layout never drops onClick behavior', async () => {
    mockViewportWidth(1024);
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(screen.getByRole('button', { name: /Open reading/ }));
    expect(
      screen.getByText('READING PAGE /learn/reading?chapter=501'),
    ).toBeInTheDocument();
  });

  it('the Vocab tile keeps its own skeleton/data/error branching inside the grid too (plan loading)', () => {
    mockViewportWidth(1024);
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'data', data: null };
    hoisted.grammarAttempts.state = { kind: 'data', data: GRAMMAR_ATTEMPTS_EMPTY };
    hoisted.writingAttempts.state = { kind: 'data', data: WRITING_ATTEMPTS_EMPTY };
    hoisted.topikAttempts.state = { kind: 'data', data: TOPIK_ATTEMPTS_EMPTY };
    hoisted.hanjaAttempts.state = { kind: 'data', data: HANJA_ATTEMPTS_EMPTY };
    hoisted.readingAttempts.state = { kind: 'data', data: READING_ATTEMPTS_EMPTY };
    hoisted.listeningAttempts.state = { kind: 'data', data: LISTENING_ATTEMPTS_EMPTY };
    const { container } = renderTodayAt();

    // Grammar/Hanja have no plan dependency and still render normally in
    // the grid; Vocab's slot shows the loading skeleton, not a tile.
    expect(screen.getByRole('button', { name: 'Open grammar drills' })).toBeInTheDocument();
    expect(container.querySelector('.km-today__grid [aria-busy="true"]')).not.toBeNull();
  });

  it('CSS: `.km-today__grid` is a real CSS grid, gated behind the ≥768px breakpoint, with the exact auto-fit/220px geometry the fix-pass arithmetic depends on', () => {
    // Fix-pass SHOULD-FIX #2 (REVIEW_d1-adaptive.md): the pre-fix-pass
    // version of this test only asserted `display: grid;` — a future edit
    // that silently swapped in a different column scheme (e.g. a fixed
    // 2-column grid, which would coincidentally "fix" the BLOCKER below by
    // accident, or a fixed 5-column grid, which would make the orphan
    // problem worse) would NOT have been caught. Pin the actual
    // `grid-template-columns` value the width arithmetic in Today.css's
    // header comment and the FIX_REPORT are computed against.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );
    const mediaBlock =
      /@media \(min-width: 768px\) \{\s*\.km-today__grid \{[\s\S]*?\n\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(mediaBlock).not.toBe('');
    expect(mediaBlock).toContain('display: grid;');
    expect(mediaBlock).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));',
    );
  });

  it('CSS BLOCKER FIX: the 768–935px band spans a trailing lone tile (1-of-1 or 3-of-3) full width instead of stranding it as a half-width orphan', () => {
    // Fix-pass BLOCKER (REVIEW_d1-adaptive.md): `.km-today__grid` only
    // computes 2 columns between 768–935px (see the width arithmetic in
    // Today.css's header comment above this rule), so Carousel 1's
    // ALWAYS-3-tile row landed a lone 3rd tile in a half-empty row at every
    // tablet-portrait viewport before this fix. jsdom cannot render real
    // grid layout, so this test pins the CSS SOURCE of the fix (the scoped
    // media query + selector), not the rendered geometry — correctness is
    // established by construction in the FIX_REPORT's width arithmetic.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Today.css'),
      'utf8',
    );
    const scopedBlock =
      /@media \(min-width: 768px\) and \(max-width: 935px\) \{[\s\S]*?\n\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(scopedBlock).not.toBe('');
    expect(scopedBlock).toContain('.km-today__grid > :last-child:nth-child(odd)');
    expect(scopedBlock).toContain('grid-column: 1 / -1;');
  });
});
