/**
 * Today — the action hub (Overhaul P1.2, Slice A; P3a rework): loading +
 * rendered + interaction.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. Both
 * fetches (today plan + the F-007 open-exam lookup) share the same hook, so
 * we dispatch on the `key` arg. Both are realFn-backed (`/plan/today`,
 * `/topik/attempt`); the hook mock here stands in for any source, so the
 * screen assertions hold regardless of which resolved. `services/topik` and
 * `services/writing` are also mocked so no realFn/generator closure can
 * touch the network.
 *
 * P3a contract pinned here:
 *   - F-026/B-018: the lead action is a looping "Review and drills" carousel
 *     — vocab due-count tile → /learn/vocab, grammar drills tile →
 *     /learn/grammar. NO "coming soon" placeholder survives anywhere.
 *   - F-027: the Writing task page mounts the topic generator (full
 *     component behavior covered in WritingTopicGenerator.test.tsx; the
 *     integration + 429 copy are exercised here).
 *   - F-028: the TOPIK carousel is recommended-study first (→ /learn/topik),
 *     review-mistakes second (→ /review/mistakes; the old standalone
 *     shortcut row is gone), with the saved-attempt resume banner in the
 *     corner slot — present only when an attempt exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
    today: { state: { kind: 'loading' } as HookState },
    attempt: { state: { kind: 'loading' } as HookState },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const s = key === 'today' ? hoisted.today.state : hoisted.attempt.state;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: () => undefined,
      };
    }
    if (s.kind === 'error') {
      // PROD-shaped failure: no mock fallback — data stays null, the screen
      // shows its error state. (Plain Error: the screen branches on `data`,
      // never on the error's type.)
      return {
        data: null,
        loading: false,
        error: new Error('plan failed'),
        isMock: false,
        refetch: () => undefined,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: true,
      refetch: () => undefined,
    };
  },
}));

// The screen imports `fetchAttempt` for its realFn; with the hook mocked it
// is never invoked, but mock the module anyway so no test path can reach the
// real axios layer.
vi.mock('../services/topik', () => ({
  fetchAttempt: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// The F-027 generator calls this directly (not via the hook) — mocked so the
// generate flow is controllable and network-free.
vi.mock('../services/writing', () => ({
  generateWritingPrompt: vi.fn(() =>
    Promise.reject(new Error('not wired in tests')),
  ),
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

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        {/* Overhaul targets: lead-carousel tiles land on /learn/vocab and
            /learn/grammar; task tiles on /learn/*; the TOPIK carousel on
            /learn/topik and /review/mistakes. */}
        <Route path="/learn/vocab" element={<div>FLASHCARDS PAGE</div>} />
        <Route path="/learn/grammar" element={<div>GRAMMAR PAGE</div>} />
        <Route path="/learn/writing" element={<div>WRITING PAGE</div>} />
        <Route path="/learn/topik" element={<div>TOPIK PAGE</div>} />
        <Route path="/review/mistakes" element={<div>MISTAKES PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Load both sources with the happy-path fixtures (no saved attempt). */
function loadDefaults(): void {
  hoisted.today.state = { kind: 'data', data: PLAN };
  hoisted.attempt.state = { kind: 'data', data: null };
}

/** Bring the Writing task page on-screen (page 3 — off-screen pages are
 *  aria-hidden + inert) and return the tasks region. */
async function activateWritingPage(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const region = screen.getByRole('region', { name: "Today's tasks" });
  await user.click(within(region).getByRole('tab', { name: 'Page 3 of 3' }));
  return region;
}

describe('Today', () => {
  beforeEach(() => {
    // Every fetch starts pending; each test opts specific keys into data.
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'loading' };
    generateMock.mockReset();
    generateMock.mockRejectedValue(new Error('not wired in tests'));
  });

  it('renders loading skeletons while the fetches are pending', () => {
    renderTodayAt();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
    // Nothing is published to the chat-context store while loading — the
    // FAB's discuss-this-page popup would have nothing honest to offer.
    expect(getChatContext()).toBeNull();
  });

  it('publishes the loaded plan to the chat-context store and retracts on unmount (Slice 3)', () => {
    loadDefaults();
    const { unmount } = renderTodayAt();

    const ctx = getChatContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.pageLabel).toBe('Today · 오늘');
    // The summary mirrors the visible cards: due count + resolved tasks.
    expect(ctx?.summary).toContain('24 review cards due');
    expect(ctx?.summary).toContain('Listening: KBS — 재택근무 확산');
    expect(ctx?.summary).toContain('Reading: 도시화와 환경');

    unmount();
    expect(getChatContext()).toBeNull();
  });

  // ── Lead carousel: vocab + grammar (F-026 / B-018 / F-029) ──

  it('renders the title and the lead Review-and-drills carousel with vocab + grammar pages', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.getByRole('heading', { level: 1, name: '오늘 · Today' }),
    ).toBeInTheDocument();

    const lead = screen.getByRole('region', { name: 'Review and drills' });
    expect(lead).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(lead).getAllByRole('tab')).toHaveLength(2);

    // Page 1 — the live vocab due count.
    expect(within(lead).getByText('24 cards due')).toBeInTheDocument();
    expect(within(lead).getByText('지금 복습')).toBeInTheDocument();
    // Page 2 — the grammar drills tile exists in the DOM (off-screen).
    expect(within(lead).getByText('Grammar drills')).toBeInTheDocument();
  });

  it('navigates to /learn/vocab (flashcards) when the vocab queue tile is clicked', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const cta = screen.getByRole('button', {
      name: /Open review — 24 cards due/,
    });
    await user.click(cta);

    expect(screen.getByText('FLASHCARDS PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/grammar from the grammar drills tile (B-018 — real page, not "coming soon")', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    // Grammar is lead-carousel page 2 — bring it on-screen via its dot
    // first (off-screen pages are aria-hidden + inert).
    const lead = screen.getByRole('region', { name: 'Review and drills' });
    await user.click(within(lead).getByRole('tab', { name: 'Page 2 of 2' }));
    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );

    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('renders NO coming-soon placeholder anywhere (B-018)', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('준비 중')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily grammar drills')).not.toBeInTheDocument();
  });

  it('degrades a plan failure to an ErrorCard on the vocab page while the grammar tile keeps working', async () => {
    hoisted.today.state = { kind: 'error' };
    hoisted.attempt.state = { kind: 'data', data: null };
    const user = userEvent.setup();
    renderTodayAt();

    // Vocab page (page 1, active) shows the honest error state.
    expect(
      screen.getByText("Today's plan is unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // The grammar tile has no plan dependency — still fully functional.
    const lead = screen.getByRole('region', { name: 'Review and drills' });
    await user.click(within(lead).getByRole('tab', { name: 'Page 2 of 2' }));
    await user.click(
      screen.getByRole('button', { name: 'Open grammar drills' }),
    );
    expect(screen.getByText('GRAMMAR PAGE')).toBeInTheDocument();
  });

  it('no longer renders the stats carousel or the TOPIK-level snapshot (moved to Progress)', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.queryByRole('region', { name: 'Progress by skill' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Progress by skill/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radiogroup', { name: 'Reference level' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('singularises the due count at 1 ("1 card due", not "cards")', () => {
    loadDefaults();
    hoisted.today.state = { kind: 'data', data: { ...PLAN, reviewCount: 1 } };
    renderTodayAt();
    expect(screen.getByText('1 card due')).toBeInTheDocument();
    expect(screen.queryByText('1 cards due')).not.toBeInTheDocument();
  });

  // ── Tasks carousel (unchanged targets; loops per F-029) ─────

  it('renders the R/L/W task carousel with per-task pills', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: "Today's tasks" });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(region).getAllByRole('tab')).toHaveLength(3);

    // All three task titles exist in the DOM (off-screen pages included).
    expect(screen.getByText('도시화와 환경')).toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    // Largest gap pill on Listening tile; Register drill on Writing.
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('navigates to /learn/writing when the Writing task page is clicked (F-001)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await activateWritingPage(user);
    const tile = screen.getByRole('button', { name: /Paragraph in/ });
    await user.click(tile);

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
  });

  it('moves the "Largest gap" pill onto the modality named by largestGap', () => {
    // Writing is the weakest skill today → its tile wears "Largest gap" and the
    // "Register drill" copy is suppressed (gap precedence over the default).
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, largestGap: 'Writing' },
    };
    renderTodayAt();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.queryByText('Register drill')).not.toBeInTheDocument();
  });

  it('omits a task page whose server task is null (empty corpus)', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    renderTodayAt();

    // Reading page gone (2 dots, not 3); listening + writing still render.
    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: "Today's tasks" });
    expect(within(region).getAllByRole('tab')).toHaveLength(2);
  });

  // ── F-027 — Claude topic generator on the Writing task page ─

  it('mounts the topic generator on the Writing page only, and renders a generated topic', async () => {
    loadDefaults();
    generateMock.mockResolvedValue(GENERATED);
    const user = userEvent.setup();
    renderTodayAt();

    // Exactly one generator on the screen (the Writing page's — its page is
    // aria-hidden until selected, so include hidden in the sweep).
    expect(screen.getAllByRole('radiogroup', { hidden: true })).toHaveLength(1);

    await activateWritingPage(user);
    await user.click(screen.getByRole('button', { name: /Generate topic/ }));

    // The topic renders as escaped text: Korean task, English gloss, hint.
    expect(
      await screen.findByText(GENERATED.promptKr),
    ).toBeInTheDocument();
    expect(screen.getByText(GENERATED.promptEn)).toBeInTheDocument();
    expect(screen.getByText('600-700자')).toBeInTheDocument();
    // Default style is TOPIK — the closed-enum body reflects it.
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
    // The button is the retry — it must stay enabled.
    expect(button).toBeEnabled();
  });

  // ── TOPIK carousel (F-028 / F-029) ──────────────────────────

  it('orders the TOPIK carousel recommended-study first, review-mistakes second', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'TOPIK exams' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(region).getAllByRole('tab')).toHaveLength(2);

    const panels = within(region).getAllByRole('tabpanel', { hidden: true });
    expect(
      within(panels[0]).getByRole('button', {
        name: 'Open TOPIK study practice',
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(
      within(panels[1]).getByRole('button', {
        name: 'Review mistakes',
        hidden: true,
      }),
    ).toBeInTheDocument();
  });

  it('navigates to /learn/topik (study) from the recommended tile', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: 'Open TOPIK study practice' }),
    );
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  it('navigates to /review/mistakes from the second TOPIK carousel page (shortcut row folded in)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'TOPIK exams' });
    await user.click(within(region).getByRole('tab', { name: 'Page 2 of 2' }));
    await user.click(screen.getByRole('button', { name: 'Review mistakes' }));

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

    // No fabricated resume CTA, and the old open-exam panel is gone.
    expect(
      screen.queryByRole('button', { name: /Resume exam/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No exam in progress/)).not.toBeInTheDocument();
  });

  // ── P3b — bilingual page chrome ────────────────────────────

  it('renders the section eyebrows and tile chrome bilingually in both-mode', () => {
    loadDefaults();
    renderTodayAt();

    // Tasks carousel eyebrow.
    expect(screen.getByText('오늘의 과제')).toBeInTheDocument();
    expect(screen.getByText('Today’s tasks')).toBeInTheDocument();
    // TOPIK section eyebrow.
    expect(screen.getByText('시험')).toBeInTheDocument();
    expect(screen.getByText('TOPIK')).toBeInTheDocument();
    // Lead-carousel chrome carries Korean too.
    expect(screen.getByText('지금 복습')).toBeInTheDocument();
    expect(screen.getByText('복습할 카드 24장')).toBeInTheDocument();
    expect(screen.getByText('문법 드릴')).toBeInTheDocument();
    // Review mistakes lives in the TOPIK carousel now.
    expect(screen.getByText('오답 복습')).toBeInTheDocument();
  });
});
