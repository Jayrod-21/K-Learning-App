/**
 * Grammar — the LEARN grammar-practice page (Phase 3C-1 shape).
 *
 * Post-3C-1 IA under test:
 *   - `?view=cards` (default) — the saved patterns in vocab mastery
 *     vocabulary (F-063/F-066): Learning | Known split, Mark known / Relearn
 *     actions, proficiency grouping (B-024), Due pills wired to the existing
 *     /vocab/cards/due queue.
 *   - `?view=practice` — the live drill, entered via the top-right
 *     "Practice" Topbar button (F-064), due-first pool ordering, BackButton
 *     to the cards view (F-024).
 *   - `?view=history` — the F-065 honest stub (no read endpoint yet).
 *
 * The old `list` browse tab (and its Bank action) lives in the library at
 * /review/grammar — pinned by pages/review/ReviewGrammar.test.tsx +
 * lib/grammarBank.test.ts.
 *
 * Services (grammar, vocab, grammarDrill) are mocked at module level so the
 * page sees predictable resolves/rejects. `useEndpointOrMock` is **not**
 * mocked — we let it call through to the real implementation against the
 * mocked services, so the realFn-first + fallback + abort paths participate.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  BankedGrammarList,
  DueCard,
  KgiuEntryDetail,
  KgiuEntrySummary,
} from '../types/domain';

// Hoisted service mocks — referenced inside the vi.mock factory.
const services = vi.hoisted(() => ({
  listPatterns: vi.fn(),
  listBanked: vi.fn(),
  bankPattern: vi.fn(),
  getPattern: vi.fn(),
  identifyPattern: vi.fn(),
  graduatePattern: vi.fn(),
  readmitPattern: vi.fn(),
}));

const vocabServices = vi.hoisted(() => ({
  getDueCards: vi.fn(),
}));

const drillServices = vi.hoisted(() => ({
  generateDrill: vi.fn(),
  submitDrill: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  loadGrammarMock: vi.fn(),
}));

vi.mock('../services/grammar', () => services);
vi.mock('../services/vocab', () => vocabServices);
vi.mock('../services/grammarDrill', () => drillServices);
vi.mock('../data/mocks/grammar', () => mocks);

import Grammar from './Grammar';
import type { DrillTarget } from './Grammar';
import { ApiError } from '../services/api';

/**
 * Render `<Grammar />` inside a MemoryRouter. `drillTarget`, when supplied,
 * seeds `location.state.drillTarget` so the FU-NF-42 deep-link path (page
 * opens on the practice view focused on a specific pattern) can be exercised
 * exactly as the Review screen drives it.
 */
function renderGrammar(drillTarget?: DrillTarget): ReturnType<typeof render> {
  return render(
    <MemoryRouter
      initialEntries={[
        drillTarget
          ? { pathname: '/learn/grammar', state: { drillTarget } }
          : '/learn/grammar',
      ]}
    >
      <Routes>
        <Route path="/learn/grammar" element={<Grammar />} />
        {/* D3 handoff target — the library's single grammar browse. */}
        <Route
          path="/review/grammar"
          element={<div data-testid="library-grammar-stub">LIBRARY GRAMMAR</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** Enter the practice view via the F-064 top-right Topbar button. */
async function openPractice(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Practice' }));
}

const ROW: KgiuEntrySummary = {
  id: 42,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-007',
  pattern: '-더라도',
  title_en: 'even if / even though',
  category: 'concessive',
  proficiency: 'intermediate',
  unit: 'Unit 7',
  source_pages: null,
};

const ROW_2: KgiuEntrySummary = {
  id: 43,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-008',
  pattern: '-느라고',
  title_en: 'because of doing X',
  category: 'causal',
  proficiency: 'intermediate',
  unit: 'Unit 8',
  source_pages: null,
};

/** A BEGINNER-corpus row, a different level than ROW/ROW_2 (intermediate).
 *  Used to prove the cards view never depends on the corpus fetch (B-SF-1). */
const BEGINNER_ROW: KgiuEntrySummary = {
  id: 10,
  corpus: 'kgiu_beginner',
  source_id: 'KGIU-BEG-001',
  pattern: '-이다',
  title_en: 'to be (copula)',
  category: 'copula',
  proficiency: 'beginner',
  unit: 'Unit 1',
  source_pages: null,
};

const EMPTY_BANK: BankedGrammarList = { entries: [] };

/** Server bank rows matching ROW / ROW_2 (grammarKey-derived pattern keys). */
const BANKED_ROW = {
  id: 501,
  pattern_key: 'GR-kgiu-int-007',
  pattern_display: '-더라도',
  summary_en: 'even if / even though',
  proficiency: 'L4',
  category: 'concessive',
  register: null,
  discovered_via: 'manual',
  created_at: '2026-06-01T00:00:00Z',
  graduated_at: null,
};

const BANKED_ROW_2 = {
  id: 502,
  pattern_key: 'GR-kgiu-int-008',
  pattern_display: '-느라고',
  summary_en: 'because of doing X',
  proficiency: 'L4',
  category: 'causal',
  register: null,
  discovered_via: 'manual',
  created_at: '2026-06-01T00:00:00Z',
  graduated_at: null,
};

/** A due grammar-production card as `GET /vocab/cards/due` returns it
 *  (post-A4: the pattern key is JOINed on). */
function dueProductionCard(id: number, patternKey: string): DueCard {
  return {
    id,
    face: 'production',
    due_at: '2026-07-09T00:00:00Z',
    stability: '1.2',
    difficulty: '5.0',
    fsrs_state: 'review',
    version: 1,
    vocab_entry_id: null,
    grammar_entry_id: 77,
    source_sentence_id: null,
    topik_item_id: null,
    grammarPatternDisplay: '-느라고',
    grammarSummaryEn: 'because of doing X',
    grammarPatternKey: patternKey,
  };
}

const DETAIL: KgiuEntryDetail = {
  ...ROW,
  explanation: 'Strong concessive — even if the premise holds.',
  // The wire always carries arrays here (JSONB NOT NULL DEFAULT '[]') —
  // empty arrays are the "pattern has no rich content" case (F-018).
  formation_rules: [],
  examples: [],
  dialogues: [],
  vocabulary: null,
  tips: null,
  compare_with: null,
  exercises: null,
  cultural_notes: null,
};

/** DETAIL with every F-018 rich section populated. */
const DETAIL_RICH: KgiuEntryDetail = {
  ...DETAIL,
  formation_rules: [
    'Verb stem + 더라도',
    'Adjective stem + 더라도',
  ],
  examples: [
    { korean: '비가 오더라도 갈 거예요.', english: "Even if it rains, we'll go." },
  ],
  dialogues: [
    {
      context: 'Two colleagues at the office, late in the day.',
      lines: [
        {
          speaker: '수진',
          korean: '일이 많더라도 오늘 끝내야 해요.',
          english: 'Even if there is a lot of work, we must finish today.',
        },
        {
          speaker: '민호',
          korean: '알겠어요. 힘들더라도 해 볼게요.',
          english: "Got it. Even if it's hard, I'll try.",
        },
      ],
    },
  ],
};

const FIXTURE = [
  {
    id: 'g1',
    pattern: '-더라도',
    title: 'even if / even though',
    desc: 'Strong concession.',
    ex_kr: '비가 오더라도 갈 거예요.',
    ex_en: "Even if it rains, we'll go.",
    state: 'practicing' as const,
    drill: {
      context: 'Concede a colleague has a point — reluctantly.',
      seed: '그 의견이 ___ 우리는 일정대로 진행해야 한다.',
      model: '그 의견이 일리가 있더라도 우리는 일정대로 진행해야 한다.',
      model_en: 'Even if that opinion has merit, we must proceed on schedule.',
    },
  },
];

function resetMocks(): void {
  for (const fn of Object.values(services)) (fn as Mock).mockReset();
  for (const fn of Object.values(vocabServices)) (fn as Mock).mockReset();
  for (const fn of Object.values(drillServices)) (fn as Mock).mockReset();
  (mocks.loadGrammarMock as Mock).mockReset();
  // Default mock fallback resolves with the fixture — happy-path tests
  // don't need to set this per-case. The ErrorCard test overrides it.
  mocks.loadGrammarMock.mockResolvedValue(FIXTURE);
  // No due cards unless a test says otherwise — due-ness is opt-in.
  vocabServices.getDueCards.mockResolvedValue([]);
  // The drill rotation persists its cursor to localStorage so it survives
  // remounts (the live always-N이다 fix). Clear it so tests don't bleed a
  // cursor into each other.
  window.localStorage.clear();
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Grammar — 3C-1 shape (cards default, Practice top-right, no tabs)', () => {
  it('defaults to the cards view with the Learning split selected and NO tablist', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);

    renderGrammar();

    // F-063/F-066: vocab mastery vocabulary — Learning | Known, no
    // banked/graduate jargon, no tab strip.
    expect(
      await screen.findByRole('button', { name: /^Learning \(0\)/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /^Known \(0\)/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText(/Graduate/)).not.toBeInTheDocument();
    // No per-row Bank affordance on this page — banking moved to the
    // library browse (/review/grammar).
    expect(
      screen.queryByRole('button', { name: /^Bank / }),
    ).not.toBeInTheDocument();
  });

  it('renders the F-064 "Practice" button in the Topbar and it opens the practice view', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 1,
      item: {
        type: 'transformation' as const,
        patternKey: 'GR-kgiu-int-007',
        patternDisplay: '-더라도',
        instruction: 'Rewrite using -더라도.',
        sourceKr: '비가 와요.',
        sourceEn: "It's raining.",
      },
    });

    const user = userEvent.setup();
    renderGrammar();

    // The button renders in the Topbar's right slot (top-right of the page).
    const practice = screen.getByRole('button', { name: 'Practice' });
    expect(practice.closest('.km-topbar')).not.toBeNull();
    await user.click(practice);

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    // The Practice entry button leaves the chrome on the nested view…
    expect(
      screen.queryByRole('button', { name: 'Practice' }),
    ).not.toBeInTheDocument();
    // …replaced by the F-024 BackButton to the cards view.
    expect(
      screen.getByRole('button', { name: 'Back to Grammar' }),
    ).toBeInTheDocument();
  });

  it('the BackButton on the practice view returns to the cards view (F-024)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 1,
      item: {
        type: 'transformation' as const,
        patternKey: 'GR-kgiu-int-007',
        patternDisplay: '-더라도',
        instruction: 'Rewrite using -더라도.',
        sourceKr: '비가 와요.',
        sourceEn: "It's raining.",
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await screen.findByRole('button', { name: /^Learning \(0\)/ });
    await openPractice(user);

    await user.click(
      await screen.findByRole('button', { name: 'Back to Grammar' }),
    );

    expect(
      await screen.findByRole('button', { name: /^Learning \(0\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Practice' }),
    ).toBeInTheDocument();
  });

  it('still fetches the FULL corpus page on mount (limit 400, no corpus filter) for the practice pool', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);

    renderGrammar();

    await waitFor(() => {
      expect(services.listPatterns).toHaveBeenCalledTimes(1);
    });
    const opts = services.listPatterns.mock.calls[0][0] as {
      limit?: number;
      corpus?: string;
    };
    expect(opts.limit).toBe(400);
    expect(opts.corpus).toBeUndefined();
  });

  it('the empty cards state hands off to the library browse', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);

    const user = userEvent.setup();
    renderGrammar();

    expect(
      await screen.findByText(/Save patterns from the grammar library/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Browse all patterns' }),
    );
    expect(
      await screen.findByTestId('library-grammar-stub'),
    ).toBeInTheDocument();
  });

  it('a populated cards list still links to the library browse', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);

    const user = userEvent.setup();
    renderGrammar();

    expect(
      await screen.findByRole('button', { name: 'Mark -더라도 as known' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Browse all patterns' }),
    );
    expect(
      await screen.findByTestId('library-grammar-stub'),
    ).toBeInTheDocument();
  });

  it('groups saved cards under their proficiency header (B-024)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW], // proficiency L4
    } satisfies BankedGrammarList);

    renderGrammar();

    // The group tile is a disclosure button carrying the level label.
    const group = await screen.findByRole('button', {
      name: /Upper-intermediate · L4/,
    });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    // The row renders inside it (kr form + en summary on separate lines).
    expect(
      screen.getByRole('button', { name: '-더라도 even if / even though' }),
    ).toBeInTheDocument();
  });
});

describe('Grammar — F-065 practice history (honest stub)', () => {
  it('opens the history view from the cards footer and states there is no endpoint yet', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);

    const user = userEvent.setup();
    renderGrammar();
    await screen.findByRole('button', { name: /^Learning \(0\)/ });

    await user.click(
      screen.getByRole('button', { name: 'Practice history' }),
    );

    // The stub is honest: no fake list, an explicit "not available yet"
    // with the backend ticket reference.
    expect(
      await screen.findByText(/Not available yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/F-065-B/)).toBeInTheDocument();
    // Nested view → BackButton (F-024).
    await user.click(
      screen.getByRole('button', { name: 'Back to Grammar' }),
    );
    expect(
      await screen.findByRole('button', { name: /^Learning \(0\)/ }),
    ).toBeInTheDocument();
  });
});

describe('Grammar — due wiring (F-063: /vocab/cards/due → Due pills + due-first pool)', () => {
  /** generateDrill stub that echoes the request pattern. */
  function echoGenerate(): void {
    drillServices.generateDrill.mockImplementation(
      async (body: { patternKey: string; patternDisplay: string }) => ({
        attemptId: 900,
        item: {
          type: 'transformation' as const,
          patternKey: body.patternKey,
          patternDisplay: body.patternDisplay,
          instruction: `Rewrite using ${body.patternDisplay}.`,
          sourceKr: '비가 와요.',
          sourceEn: "It's raining.",
        },
      }),
    );
  }

  it('badges a saved card "Due" when its production card is in the due queue', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW, BANKED_ROW_2],
    } satisfies BankedGrammarList);
    vocabServices.getDueCards.mockResolvedValue([
      dueProductionCard(9001, 'GR-kgiu-int-008'),
    ]);

    renderGrammar();

    const dueRow = await screen.findByRole('button', {
      name: '-느라고 because of doing X',
    });
    expect(within(dueRow).getByText('Due')).toBeInTheDocument();
    // …and only that row.
    const otherRow = screen.getByRole('button', {
      name: '-더라도 even if / even though',
    });
    expect(within(otherRow).queryByText('Due')).not.toBeInTheDocument();
    // The due summary note names the count.
    expect(
      screen.getByText(/1 pattern due for review/),
    ).toBeInTheDocument();
  });

  it('practice serves DUE patterns before the rest of the rotation', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    // Both saved; ROW (-더라도) is FIRST in bank order, but ROW_2 is due.
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW, BANKED_ROW_2],
    } satisfies BankedGrammarList);
    vocabServices.getDueCards.mockResolvedValue([
      dueProductionCard(9001, 'GR-kgiu-int-008'),
    ]);
    echoGenerate();

    const user = userEvent.setup();
    renderGrammar();
    await screen.findByRole('button', { name: 'Mark -더라도 as known' });

    await openPractice(user);
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    // Anki ordering: the due pattern is drilled first, not bank-order[0].
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-008',
      patternDisplay: '-느라고',
    });
  });

  it('a failed due fetch degrades to no badges — the cards still render', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    vocabServices.getDueCards.mockRejectedValue(
      new ApiError('down', { status: 503, code: 'server' }),
    );

    renderGrammar();

    expect(
      await screen.findByRole('button', {
        name: '-더라도 even if / even though',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Due')).not.toBeInTheDocument();
    expect(screen.queryByText(/due for review/)).not.toBeInTheDocument();
  });
});

describe('Grammar — cards + practice pool independent of the corpus fetch (B-SF-1)', () => {
  /** generateDrill stub that echoes the request pattern (scoped to this block —
   *  the drill describe has its own copy). */
  function echoGenerate(): void {
    drillServices.generateDrill.mockImplementation(
      async (body: { patternKey: string; patternDisplay: string }) => ({
        attemptId: 900,
        item: {
          type: 'transformation' as const,
          patternKey: body.patternKey,
          patternDisplay: body.patternDisplay,
          instruction: `Rewrite using ${body.patternDisplay}.`,
          sourceKr: '비가 와요.',
          sourceEn: "It's raining.",
        },
      }),
    );
  }

  it('shows a saved pattern that is MISSING from the corpus fetch (rendered from its bank-row fields)', async () => {
    // The corpus fetch returns only the beginner row — the saved
    // intermediate pattern (ROW → GR-kgiu-int-007) is NOT in it. The cards
    // view must render it anyway, from the bank row's own stored fields.
    services.listPatterns.mockResolvedValue([BEGINNER_ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);

    renderGrammar();

    expect(
      await screen.findByRole('button', { name: 'Mark -더라도 as known' }),
    ).toBeInTheDocument();
    // Learning count reflects the bank list, not the corpus fetch.
    expect(
      screen.getByRole('button', { name: /^Learning \(1\)/ }),
    ).toBeInTheDocument();
  });

  it('practises the saved pattern even when the corpus fetch excludes it', async () => {
    services.listPatterns.mockResolvedValue([BEGINNER_ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    echoGenerate();

    const user = userEvent.setup();
    renderGrammar();
    await screen.findByRole('button', { name: 'Mark -더라도 as known' });

    // The practice pool is the saved patterns, independent of the corpus
    // fetch: it drills the saved intermediate pattern, NOT the fetched
    // beginner row.
    await openPractice(user);
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-007',
      patternDisplay: '-더라도',
    });
  });
});

describe('Grammar — detail Sheet (opened from card rows)', () => {
  // The only rows on this page live in the cards view (the default view).
  // A saved pattern whose KGIU row IS in the corpus fetch upgrades to the
  // richer row, so the real getPattern detail fetch still runs.
  it('opens detail Sheet and calls getPattern on a card-row tap', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    services.getPattern.mockResolvedValue(DETAIL);

    const user = userEvent.setup();
    renderGrammar();

    const rowBtn = await screen.findByRole('button', {
      name: '-더라도 even if / even though',
    });
    await user.click(rowBtn);

    await waitFor(() => {
      expect(services.getPattern).toHaveBeenCalledWith(42);
    });
    expect(
      await screen.findByText(/Strong concessive/),
    ).toBeInTheDocument();
    // The row's standing pill uses the plain "Saved" wording (F-066 — the
    // old "Banked" jargon is gone).
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Saved')).toBeInTheDocument();
  });

  it('renders Formation bullets, Examples, and Dialogue lines when populated (F-018)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    services.getPattern.mockResolvedValue(DETAIL_RICH);

    const user = userEvent.setup();
    renderGrammar();

    await user.click(
      await screen.findByRole('button', {
        name: '-더라도 even if / even though',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    // Formation bullets.
    expect(await within(dialog).findByText('Formation')).toBeInTheDocument();
    expect(within(dialog).getByText('Verb stem + 더라도')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Adjective stem + 더라도'),
    ).toBeInTheDocument();
    // Examples: Korean + English gloss.
    expect(within(dialog).getByText('Examples')).toBeInTheDocument();
    expect(
      within(dialog).getByText('비가 오더라도 갈 거예요.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Even if it rains, we'll go."),
    ).toBeInTheDocument();
    // Dialogues: context + speaker-labelled turns.
    expect(within(dialog).getByText('Dialogues')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Two colleagues at the office, late in the day.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('수진')).toBeInTheDocument();
    expect(
      within(dialog).getByText('일이 많더라도 오늘 끝내야 해요.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('민호')).toBeInTheDocument();
    expect(
      within(dialog).getByText("Got it. Even if it's hard, I'll try."),
    ).toBeInTheDocument();
    // The explanation still leads the body.
    expect(
      within(dialog).getByText(/Strong concessive/),
    ).toBeInTheDocument();
  });

  it('renders no rich-section headers when the arrays are empty (F-018)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    services.getPattern.mockResolvedValue(DETAIL); // all three arrays empty

    const user = userEvent.setup();
    renderGrammar();

    await user.click(
      await screen.findByRole('button', {
        name: '-더라도 even if / even though',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    // Explanation + unit footer still render…
    expect(
      await within(dialog).findByText(/Strong concessive/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Unit ·/)).toBeInTheDocument();
    // …but no orphaned section headers for the empty arrays.
    expect(within(dialog).queryByText('Formation')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Examples')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Dialogues')).not.toBeInTheDocument();
  });

  it('drops a late detail settle for a previously opened row (stale-guard)', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW, BANKED_ROW_2],
    } satisfies BankedGrammarList);

    const DETAIL_2: KgiuEntryDetail = {
      ...ROW_2,
      explanation: 'Causal — because of doing X, a (bad) result followed.',
      formation_rules: [],
      examples: [],
      dialogues: [],
      vocabulary: null,
      tips: null,
      compare_with: null,
      exercises: null,
      cultural_notes: null,
    };

    // Row A's detail hangs until released; row B's resolves immediately —
    // the fast-row-switch race from the sweep finding.
    let releaseA!: (d: KgiuEntryDetail) => void;
    services.getPattern.mockImplementation(async (id: number) => {
      if (id === ROW.id) {
        return new Promise<KgiuEntryDetail>((resolve) => {
          releaseA = resolve;
        });
      }
      return DETAIL_2;
    });

    const user = userEvent.setup();
    renderGrammar();

    // Open A — its detail fetch stays in flight.
    await user.click(
      await screen.findByRole('button', {
        name: '-더라도 even if / even though',
      }),
    );
    await waitFor(() => {
      expect(services.getPattern).toHaveBeenCalledWith(42);
    });

    // Close it, then open B, whose detail lands right away.
    await user.click(
      screen.getByRole('button', { name: 'Close pattern detail' }),
    );
    await user.click(
      screen.getByRole('button', { name: '-느라고 because of doing X' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/Causal — because of doing X/),
    ).toBeInTheDocument();

    // A's stale settle lands late. Pre-fix it unconditionally setDetail()'d,
    // painting A's explanation under B's header. It must be dropped.
    await act(async () => {
      releaseA(DETAIL);
    });
    expect(
      within(dialog).getByText(/Causal — because of doing X/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/Strong concessive/),
    ).not.toBeInTheDocument();
  });
});

describe('Grammar — practice view (live generate → submit → reveal)', () => {
  const GEN_TRANSFORM = {
    attemptId: 7,
    item: {
      type: 'transformation' as const,
      patternKey: 'KGIU-INT-007',
      patternDisplay: '-더라도',
      instruction: 'Rewrite using -더라도.',
      sourceKr: '비가 와요. 우리는 갈 거예요.',
      sourceEn: "It's raining. We will go.",
    },
  };

  const SCORE = {
    score: 82,
    verdict: 'good' as const,
    usesPattern: true,
    summary: 'Reads natural — good register.',
    corrections: [
      { span: '진행합시다', issue: 'register mismatch', fix: '진행해야 한다' },
    ],
    referenceModelKr: '비가 오더라도 우리는 출발할 거예요.',
    referenceModelEn: "Even if it rains, we will set out.",
  };

  it('generates a transformation drill, submits, and reveals the score + reference', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue(SCORE);

    const user = userEvent.setup();
    renderGrammar();

    await openPractice(user);

    // Generate ran with the row's pattern source.
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      // Rows carry the same GR-shaped key the bank path uses, so drill
      // history and the grammar bank dedup on one key namespace.
      patternKey: 'GR-kgiu-int-007',
      patternDisplay: '-더라도',
    });

    // Transformation body renders.
    expect(await screen.findByText('Transform this')).toBeInTheDocument();
    expect(screen.getByText('비가 와요. 우리는 갈 거예요.')).toBeInTheDocument();

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 우리는 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      expect(drillServices.submitDrill).toHaveBeenCalledWith(
        7,
        '비가 오더라도 우리는 갈 거예요.',
        expect.anything(),
      );
    });

    // Reveal: score, verdict, correction, reference model.
    expect(await screen.findByText('82')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Model answer')).toBeInTheDocument();
    expect(
      screen.getByText('비가 오더라도 우리는 출발할 거예요.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/register mismatch/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next pattern/i }),
    ).toBeInTheDocument();
  });

  it('renders a cloze drill body when the server returns type=cloze', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 9,
      item: {
        type: 'cloze',
        patternKey: 'KGIU-INT-007',
        patternDisplay: '-느라고',
        instruction: 'Fill the blank with a -느라고 clause.',
        context: 'Explain why you missed dinner.',
        seedKr: '발표 자료를 ___ 저녁을 못 먹었어요.',
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    expect(await screen.findByText('Seed — fill the blank')).toBeInTheDocument();
    expect(
      screen.getByText('발표 자료를 ___ 저녁을 못 먹었어요.'),
    ).toBeInTheDocument();
  });

  it('renders a conversation drill body when the server returns type=conversation', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 11,
      item: {
        type: 'conversation',
        patternKey: 'KGIU-INT-007',
        patternDisplay: '-ㄹ 뿐만 아니라',
        instruction: 'Reply using -ㄹ 뿐만 아니라.',
        scenario: 'A friend asks about the café.',
        promptKr: '새 카페 어때요?',
        promptEn: 'How is the new café?',
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    expect(await screen.findByText('They say')).toBeInTheDocument();
    expect(screen.getByText('새 카페 어때요?')).toBeInTheDocument();
  });

  it('falls back to a local mock drill + 🅂 badge when generate is unreachable', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockRejectedValue(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    // The screen does NOT blank — a mock drill renders + the MockBadge shows.
    expect(await screen.findByTestId('mock-badge')).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText(/Write your answer using/i),
    ).toBeInTheDocument();
  });

  it('surfaces an inline alert + Retry when submit fails, keeping the answer', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockRejectedValue(
      new ApiError('upstream', { status: 502, code: 'upstream' }),
    );

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // Inline failure-safe error — the screen is intact, answer preserved.
    expect(await screen.findByText(/Scoring your answer failed/i)).toBeInTheDocument();
    expect(
      (screen.getByPlaceholderText(/Write your answer using/i) as HTMLTextAreaElement)
        .value,
    ).toBe('비가 오더라도 갈 거예요.');
    // Submit button is back (not stuck on a spinner).
    expect(screen.getByRole('button', { name: /^submit$/i })).toBeInTheDocument();
  });

  it("the error card's Retry RE-SUBMITS the preserved answer — it must not regenerate the drill and wipe it", async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill
      .mockRejectedValueOnce(
        new ApiError('upstream', { status: 502, code: 'upstream' }),
      )
      .mockResolvedValue(SCORE);

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    const textarea = await screen.findByPlaceholderText(
      /Write your answer using/i,
    );
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // Submit failed — the error promises the answer is preserved.
    expect(
      await screen.findByText(/Scoring your answer failed/i),
    ).toBeInTheDocument();

    // The Retry button INSIDE that error must re-submit the same answer.
    // Pre-fix it was wired to the generate path: it bumped the retry tick,
    // regenerated the drill, and cleared the user's answer — contradicting
    // the message sitting right above it.
    await user.click(screen.getByRole('button', { name: /^Retry$/i }));
    await waitFor(() => {
      expect(drillServices.submitDrill).toHaveBeenCalledTimes(2);
    });
    expect(drillServices.submitDrill.mock.calls[1]).toEqual([
      7,
      '비가 오더라도 갈 거예요.',
      expect.anything(),
    ]);
    // No regenerate happened (the drill — and the answer — survived).
    expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    // The retried submit succeeds and reveals the score.
    expect(await screen.findByText('82')).toBeInTheDocument();
  });

  // ── PROD posture — no fixture substitution for a failed generate ────────
  //
  // In production MockBadge renders null, so serving MOCK_DRILLS + the local
  // pseudo-scorer on a generate failure would present a fabricated drill and
  // a fabricated score as REAL — the same fake-data-as-real class the sweep
  // gated in useEndpointOrMock and MockMode. These stub `import.meta.env.PROD`
  // and pin the honest error path, its regenerate-Retry, and that the
  // dev-only fallback survives on the non-PROD side of the gate.

  describe('PROD posture — generate failure must error, never fabricate', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('a PROD generate failure shows a retryable error — not a mock drill — and its Retry RE-GENERATES', async () => {
      vi.stubEnv('PROD', true);
      services.listPatterns.mockResolvedValue([ROW]);
      services.listBanked.mockResolvedValue(EMPTY_BANK);
      drillServices.generateDrill
        .mockRejectedValueOnce(
          new ApiError('network unreachable', { status: 0, code: 'network' }),
        )
        .mockResolvedValue(GEN_TRANSFORM);

      const user = userEvent.setup();
      renderGrammar();
      await openPractice(user);

      // The honest error state renders (fixed copy, role=alert via ErrorCard)…
      expect(
        await screen.findByText(/The drill couldn't be generated/i),
      ).toBeInTheDocument();
      // …and NO fabricated drill: no answer box to be locally "scored", and
      // no 🅂 badge pretending the fixture is flagged.
      expect(
        screen.queryByPlaceholderText(/Write your answer using/i),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();

      // Retry must RE-GENERATE. Pre-fix wiring pointed error retries at
      // submit(), whose `if (!item) return` guard makes the button a silent
      // dead-end when the generate failure left item === null.
      await user.click(screen.getByRole('button', { name: /^Retry$/i }));
      await waitFor(() => {
        expect(drillServices.generateDrill).toHaveBeenCalledTimes(2);
      });
      expect(drillServices.submitDrill).not.toHaveBeenCalled();
      // The retried generate succeeds and the REAL drill renders.
      expect(
        await screen.findByPlaceholderText(/Write your answer using/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/The drill couldn't be generated/i),
      ).not.toBeInTheDocument();
    });

    it('a PROD submit failure still retries the SUBMIT with the preserved answer (no dead-end, no regenerate)', async () => {
      vi.stubEnv('PROD', true);
      services.listPatterns.mockResolvedValue([ROW]);
      services.listBanked.mockResolvedValue(EMPTY_BANK);
      drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
      drillServices.submitDrill
        .mockRejectedValueOnce(
          new ApiError('upstream', { status: 502, code: 'upstream' }),
        )
        .mockResolvedValue(SCORE);

      const user = userEvent.setup();
      renderGrammar();
      await openPractice(user);

      const textarea = await screen.findByPlaceholderText(
        /Write your answer using/i,
      );
      await user.type(textarea, '비가 오더라도 갈 거예요.');
      await user.click(screen.getByRole('button', { name: /^submit$/i }));

      expect(
        await screen.findByText(/Scoring your answer failed/i),
      ).toBeInTheDocument();

      // The submit-failure Retry re-submits the SAME preserved answer — it
      // must not have been rewired to the generate path by the gating.
      await user.click(screen.getByRole('button', { name: /^Retry$/i }));
      await waitFor(() => {
        expect(drillServices.submitDrill).toHaveBeenCalledTimes(2);
      });
      expect(drillServices.submitDrill.mock.calls[1]).toEqual([
        7,
        '비가 오더라도 갈 거예요.',
        expect.anything(),
      ]);
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('82')).toBeInTheDocument();
    });

    it('non-PROD keeps the failure-safe fallback: a generate failure serves the mock drill + 🅂 badge, no error card', async () => {
      vi.stubEnv('PROD', false);
      services.listPatterns.mockResolvedValue([ROW]);
      services.listBanked.mockResolvedValue(EMPTY_BANK);
      drillServices.generateDrill.mockRejectedValue(
        new ApiError('network unreachable', { status: 0, code: 'network' }),
      );

      const user = userEvent.setup();
      renderGrammar();
      await openPractice(user);

      // Dev/offline still exercises the full flow — badge flags the fixture.
      expect(await screen.findByTestId('mock-badge')).toBeInTheDocument();
      expect(
        await screen.findByPlaceholderText(/Write your answer using/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/The drill couldn't be generated/i),
      ).not.toBeInTheDocument();
    });
  });

  // ── FU-NF-42 B2 + F-063: reveal names the derived FSRS rating ───────────

  it('shows the "Rated Good · next review in N days" line when the score carries a schedule (vocab rating vocabulary)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue({
      ...SCORE,
      schedule: {
        rating: 'good',
        dueAt: '2026-06-02T00:00:00Z',
        scheduledDays: 3,
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(
      await screen.findByText('Rated Good · next review in 3 days'),
    ).toBeInTheDocument();
  });

  it('renders the "Rated Again · ~10 minutes" variant when scheduledDays is 0 (relearning step)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue({
      ...SCORE,
      verdict: 'incorrect' as const,
      schedule: {
        rating: 'again',
        dueAt: '2026-05-30T00:10:00Z',
        scheduledDays: 0,
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 와요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(
      await screen.findByText('Rated Again · next review in ~10 minutes'),
    ).toBeInTheDocument();
  });

  it('omits the schedule line when the score has no schedule (pre-bump server)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue(SCORE);

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // The reveal lands (score visible) but no schedule line is shown.
    expect(await screen.findByText('82')).toBeInTheDocument();
    expect(screen.queryByText(/next review in/)).not.toBeInTheDocument();
  });

  // ── Drill rotation: Skip/Next must move to a DIFFERENT pattern ──────────
  //
  // Live bug (2026-07-02): the practice view regenerated N이다 (the first
  // corpus row) forever — the rotation index reset to 0 on every panel
  // remount (any view switch / reload), so the learner never progressed.
  // These tests pin the fixed contract: Skip advances the pattern, saved
  // patterns are the preferred pool, and the cursor survives a remount.

  /** generateDrill stub that echoes the request so assertions can read which
   *  pattern each generate was for. */
  function echoGenerate(): void {
    let nextAttempt = 100;
    drillServices.generateDrill.mockImplementation(
      async (body: { patternKey: string; patternDisplay: string }) => ({
        attemptId: (nextAttempt += 1),
        item: {
          type: 'transformation' as const,
          patternKey: body.patternKey,
          patternDisplay: body.patternDisplay,
          instruction: `Rewrite using ${body.patternDisplay}.`,
          sourceKr: '비가 와요.',
          sourceEn: "It's raining.",
        },
      }),
    );
  }

  it('Skip advances the rotation to a DIFFERENT pattern', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    echoGenerate();

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-007',
    });

    await user.click(await screen.findByRole('button', { name: /^Skip$/ }));

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(2);
    });
    // The second generate is for the NEXT pattern — not a same-pattern reroll.
    expect(drillServices.generateDrill.mock.calls[1][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-008',
      patternDisplay: '-느라고',
    });
  });

  it('prefers the saved pool over the full list when the user has saved patterns', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    // ROW_2 (-느라고) is saved; ROW is not. The drill must start from the
    // saved pool, not from items[0].
    services.listBanked.mockResolvedValue({
      entries: [
        {
          id: 7,
          pattern_key: 'GR-kgiu-int-008',
          pattern_display: '-느라고',
          summary_en: 'because of doing X',
          proficiency: 'L4',
          category: 'causal',
          register: null,
          discovered_via: 'manual',
          created_at: '2026-06-01T00:00:00Z',
          graduated_at: null,
        },
      ],
    } satisfies BankedGrammarList);
    echoGenerate();

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-008',
      patternDisplay: '-느라고',
    });
  });

  it('resumes the rotation across a remount instead of resetting to the first pattern (live always-N이다 regression)', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    echoGenerate();

    const user = userEvent.setup();
    renderGrammar();
    await openPractice(user);
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });

    // Advance to the second pattern…
    await user.click(await screen.findByRole('button', { name: /^Skip$/ }));
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(2);
    });

    // …then leave the practice view (unmounts the panel) and come back.
    await user.click(
      screen.getByRole('button', { name: 'Back to Grammar' }),
    );
    await screen.findByRole('button', { name: 'Practice' });
    await openPractice(user);

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(3);
    });
    // The remount resumed at the persisted cursor (pattern #2) — NOT items[0],
    // which is what produced the endless-N이다 live behaviour.
    expect(drillServices.generateDrill.mock.calls[2][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-008',
    });
  });

  // ── FU-NF-42 B3: practice opens focused on a deep-link target ───────────

  it('drills the deep-linked pattern from router state instead of the rotation', async () => {
    // The list fetch resolves a DIFFERENT pattern than the deep-link target, so
    // we can prove the generate body came from the target, not items[idx].
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);

    renderGrammar({
      patternKey: 'KGIU-INT-099',
      display: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });

    // Opens straight on the practice view (no manual navigation) and
    // generates for the targeted pattern.
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'KGIU-INT-099',
      patternDisplay: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });
    // Nested view chrome: the BackButton is present (F-024).
    expect(
      await screen.findByRole('button', { name: 'Back to Grammar' }),
    ).toBeInTheDocument();
  });

  it('still drills a deep-link target when the pattern list is empty', async () => {
    // No saved patterns at all — the target must carry its own display/meaning.
    services.listPatterns.mockResolvedValue([]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    mocks.loadGrammarMock.mockResolvedValue([]);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);

    renderGrammar({
      patternKey: 'KGIU-INT-099',
      display: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'KGIU-INT-099',
    });
    // The "no cards to practice" empty state must NOT win over the target.
    expect(
      screen.queryByText(/No grammar cards to practice yet/i),
    ).not.toBeInTheDocument();
  });
});

// ── Mastery actions: Learning | Known views + practice-pool exclusion ──────
//
// Marking a pattern known retires it from ACTIVE learning: it moves from the
// Learning view to the Known view, and the practice rotation must never
// serve it. Relearn is the inverse — the pattern returns to Learning
// (server-side its production card resurfaces in /vocab/cards/due with FSRS
// state intact; that half is pinned by the server route tests).

describe('Grammar — Mark known / Relearn (cards view)', () => {
  it('Mark known moves the pattern to the Known view and out of the practice pool', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    // Initial bank: both patterns learning. After the mark-known refetch the
    // server confirms ROW as known.
    services.listBanked
      .mockResolvedValueOnce({
        entries: [BANKED_ROW, BANKED_ROW_2],
      } satisfies BankedGrammarList)
      .mockResolvedValue({
        entries: [
          { ...BANKED_ROW, graduated_at: '2026-07-02T10:00:00Z' },
          BANKED_ROW_2,
        ],
      } satisfies BankedGrammarList);
    services.graduatePattern.mockResolvedValue({
      entry: { ...BANKED_ROW, graduated_at: '2026-07-02T10:00:00Z' },
    });
    drillServices.generateDrill.mockImplementation(
      async (body: { patternKey: string; patternDisplay: string }) => ({
        attemptId: 900,
        item: {
          type: 'transformation' as const,
          patternKey: body.patternKey,
          patternDisplay: body.patternDisplay,
          instruction: `Rewrite using ${body.patternDisplay}.`,
          sourceKr: '비가 와요.',
          sourceEn: "It's raining.",
        },
      }),
    );

    const user = userEvent.setup();
    renderGrammar();

    // Both saved patterns sit in the Learning view with a Mark-known action.
    expect(
      await screen.findByRole('button', { name: 'Mark -더라도 as known' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark -느라고 as known' }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Mark -더라도 as known' }),
    );

    // The service was called with the BANK row id (grammar_entries.id), not
    // the KGIU id.
    await waitFor(() => {
      expect(services.graduatePattern).toHaveBeenCalledWith(501);
    });

    // The pattern leaves the Learning view (optimistic + server settle agree)…
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark -더라도 as known' }),
      ).not.toBeInTheDocument();
    });

    // …and shows up in the Known view with a Relearn action.
    await user.click(screen.getByRole('button', { name: /^Known/ }));
    expect(
      await screen.findByRole('button', { name: 'Relearn -더라도' }),
    ).toBeInTheDocument();

    // Practice pool: the rotation starts from the remaining LEARNING
    // pattern — the known one is never drilled.
    await openPractice(user);
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'GR-kgiu-int-008',
      patternDisplay: '-느라고',
    });
  });

  it('Relearn returns a Known pattern to the Learning view (and the practice pool)', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    // Initial bank: ROW is known, ROW_2 learning. After the relearn refetch
    // both are learning.
    services.listBanked
      .mockResolvedValueOnce({
        entries: [
          { ...BANKED_ROW, graduated_at: '2026-07-01T09:00:00Z' },
          BANKED_ROW_2,
        ],
      } satisfies BankedGrammarList)
      .mockResolvedValue({
        entries: [BANKED_ROW, BANKED_ROW_2],
      } satisfies BankedGrammarList);
    services.readmitPattern.mockResolvedValue({ entry: BANKED_ROW });

    const user = userEvent.setup();
    renderGrammar();

    // The known pattern is NOT in the Learning view…
    expect(
      await screen.findByRole('button', { name: 'Mark -느라고 as known' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark -더라도 as known' }),
    ).not.toBeInTheDocument();

    // …it lives in the Known view.
    await user.click(screen.getByRole('button', { name: /^Known/ }));
    const relearnBtn = await screen.findByRole('button', {
      name: 'Relearn -더라도',
    });
    await user.click(relearnBtn);

    await waitFor(() => {
      expect(services.readmitPattern).toHaveBeenCalledWith(501);
    });

    // The Known view empties; the pattern is back in the Learning view.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Relearn -더라도' }),
      ).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Learning/ }));
    expect(
      await screen.findByRole('button', { name: 'Mark -더라도 as known' }),
    ).toBeInTheDocument();
  });

  it('surfaces an inline error and rewinds the optimistic move when Mark known fails', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue({
      entries: [BANKED_ROW],
    } satisfies BankedGrammarList);
    services.graduatePattern.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server' }),
    );

    const user = userEvent.setup();
    renderGrammar();

    await user.click(
      await screen.findByRole('button', { name: 'Mark -더라도 as known' }),
    );

    // Failure: inline error + the row stays in the Learning view.
    expect(
      await screen.findByText(/Couldn't mark that pattern as known/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark -더라도 as known' }),
    ).toBeInTheDocument();
  });
});
