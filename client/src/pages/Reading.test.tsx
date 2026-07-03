/**
 * Reading — Pass 3 wiring tests.
 *
 * Pass 2 covered the mock-only render. Pass 3 wires the screen against
 * real services (units → sentences) plus the per-tap chain (lemmatize
 * → define → enrich) and grammar identify + vocab init on Add-to-bank.
 *
 * Strategy:
 *   - Mock `useEndpointOrMock` to take the `realFn`'s resolved value (or
 *     surface a loading / error state on demand) so we don't pull the
 *     full axios stack into the test.
 *   - Mock each service module so taps fire observable spies. The mocks
 *     resolve synchronously via Promise.resolve so userEvent can await
 *     them without fake timers.
 *
 * Why no rendering of the mock-fallback path explicitly: the hook owns
 * the mock-vs-real branching and is covered by its own suite. Here we
 * trust the hook contract and exercise the consumer (Reading) directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../services/api';
import type { ReadingPassage } from '../types/domain';

// ── Hook stub ───────────────────────────────────────────────────────
//
// The hook is the integration boundary; tests pin its output and let
// Reading render against fixed states.
type HookState =
  | { kind: 'loading' }
  | { kind: 'data'; data: ReadingPassage; isMock?: boolean }
  | { kind: 'error' };

const hoisted = vi.hoisted(() => ({
  hookState: { current: { kind: 'loading' } as HookState },
  refetchSpy: vi.fn(),
  // The realFn Reading hands the hook — captured so tests can drive the
  // real loader chain (default-corpus behaviour, B-001) without unmocking
  // the hook's state machine.
  lastRealFn: { current: null as (() => Promise<unknown>) | null },
}));

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (
    _key: string,
    _mockFn: unknown,
    opts?: { realFn?: () => Promise<unknown> },
  ) => {
    hoisted.lastRealFn.current = opts?.realFn ?? null;
    const s = hoisted.hookState.current;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: hoisted.refetchSpy,
      };
    }
    if (s.kind === 'error') {
      return {
        data: null,
        loading: false,
        error: null,
        isMock: false,
        refetch: hoisted.refetchSpy,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: s.isMock ?? false,
      refetch: hoisted.refetchSpy,
    };
  },
}));

// ── Service mocks ───────────────────────────────────────────────────
//
// Each service is mocked at the module boundary so taps observably
// hit the right call. The fixtures keep the wire shapes honest so a
// shape drift on the service side would surface here.

vi.mock('../services/reading', () => ({
  fetchUnits: vi.fn(),
  fetchUnitsPage: vi.fn(),
  fetchSentences: vi.fn(),
}));

vi.mock('../services/lemmatize', () => ({
  lemmatize: vi.fn(),
}));

vi.mock('../services/define', () => ({
  defineEntry: vi.fn(),
}));

vi.mock('../services/enrich', () => ({
  enrich: vi.fn(),
}));

vi.mock('../services/grammar', () => ({
  identifyPattern: vi.fn(),
}));

vi.mock('../services/vocab', () => ({
  mineWord: vi.fn(),
}));

import { Reading } from './Reading';
import { fetchSentences, fetchUnits, fetchUnitsPage } from '../services/reading';
import { READING_SELECTION_STORAGE_KEY } from '../lib/readingSelection';
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import { identifyPattern } from '../services/grammar';
import { mineWord } from '../services/vocab';
import { ToastProvider } from '../components/ToastProvider';

/**
 * Reading consumes `useToast` (FU-NF-33 bank-failure surface), so every
 * render needs a `<ToastProvider/>` in the tree. Wrap in the same provider
 * App.tsx uses for the toast region.
 */
function renderReading(): ReturnType<typeof render> {
  return render((<Reading />) as ReactElement, {
    wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider>,
  });
}

// ── Fixtures ────────────────────────────────────────────────────────

/** A fixture-shape passage — pre-glossed token triggers the fast path. */
const PASSAGE_WITH_GLOSS: ReadingPassage = {
  title: '재택근무',
  level: 'TOPIK II · Intermediate',
  meta: 'Reading · 1 min',
  sentences: [
    {
      en: 'I work from home.',
      tokens: [
        {
          w: '재택근무',
          gloss: {
            kr: '재택근무',
            pos: 'n.',
            en: 'working from home',
            ex_kr: '재택근무를 한다.',
            ex_en: 'I work from home.',
          },
        },
        { w: '.' },
      ],
    },
  ],
};

/** A wire-style passage — placeholder gloss triggers the slow path. */
const PASSAGE_PLACEHOLDER: ReadingPassage = {
  title: '재택근무',
  level: 'TOPIK II · Intermediate',
  meta: 'Reading · ttmik',
  sentences: [
    {
      en: 'I work from home.',
      tokens: [
        {
          w: '재택근무',
          vid: null,
          gloss: {
            kr: '재택근무',
            pos: 'n.',
            en: '',
            ex_kr: '',
            ex_en: '',
          },
        },
        { w: ' ' },
        {
          w: '합니다',
          vid: null,
          gloss: {
            kr: '합니다',
            pos: 'n.',
            en: '',
            ex_kr: '',
            ex_en: '',
          },
        },
        { w: '.' },
      ],
    },
  ],
};

/** A passage with a grammar span — tests the grammar tap. */
const PASSAGE_GRAMMAR: ReadingPassage = {
  title: '문법 예문',
  level: 'TOPIK II · Intermediate',
  meta: 'Reading · 1 min',
  sentences: [
    {
      en: 'Whereas this is true.',
      tokens: [
        { w: '주는', span: 'g4-start' },
        { w: ' ' },
        { w: '반면', span: 'g4-mid' },
        { w: ',', span: 'g4-end' },
      ],
    },
  ],
};

// ── Tests ───────────────────────────────────────────────────────────

describe('Reading', () => {
  beforeEach(() => {
    // Each test starts from a clean persisted-selection slate so the picker
    // tests don't leak a stored pick into one another.
    window.localStorage.clear();
    vi.mocked(fetchUnits).mockReset();
    vi.mocked(fetchUnitsPage).mockReset();
    vi.mocked(fetchSentences).mockReset();
    vi.mocked(lemmatize).mockReset();
    vi.mocked(defineEntry).mockReset();
    vi.mocked(enrich).mockReset();
    vi.mocked(identifyPattern).mockReset();
    vi.mocked(mineWord).mockReset();
    vi.mocked(mineWord).mockResolvedValue({
      entryId: 1,
      card: { id: 10, version: 1 },
    });
    hoisted.refetchSpy.mockReset();
  });

  it('renders the skeleton while loading', () => {
    hoisted.hookState.current = { kind: 'loading' };
    renderReading();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the passage and audio block when loaded', () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_WITH_GLOSS,
      isMock: true,
    };
    renderReading();
    expect(screen.getByText('읽기 · Read')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '재택근무' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Audio ·/)).toBeInTheDocument();
  });

  it('shows ErrorCard with Retry when the hook surfaces no data', async () => {
    hoisted.hookState.current = { kind: 'error' };
    const user = userEvent.setup();
    renderReading();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    await user.click(retry);
    expect(hoisted.refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fast-path: tapword with a pre-attached gloss opens popover without network', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_WITH_GLOSS,
      isMock: true,
    };
    const user = userEvent.setup();
    renderReading();

    const tap = screen.getByRole('button', { name: '재택근무' });
    await user.click(tap);

    expect(screen.getByText('working from home')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add to vocab/i }),
    ).toBeInTheDocument();
    expect(vi.mocked(lemmatize)).not.toHaveBeenCalled();
    expect(vi.mocked(defineEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(enrich)).not.toHaveBeenCalled();
  });

  it('slow-path: tapword with placeholder gloss calls lemmatize + define + enrich', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '재택근무',
      entries: [
        {
          id: 1,
          headword: '재택근무',
          part_of_speech: 'n.',
          definition_korean: null,
          definition_english: null,
          examples: [],
        },
      ],
    });
    // Real EnrichmentResult shape (server services/claude/models.ts) — the
    // fields the popover mapping reads (B-002).
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: 'working from home',
        usageNote: 'Common in HR contexts.',
        examples: [
          { korean: '재택근무를 해요.', english: 'I work from home.' },
        ],
        dontConfuseWith: [],
        proficiency: 'L4',
      },
    });

    const user = userEvent.setup();
    renderReading();

    const tap = screen.getByRole('button', { name: '재택근무' });
    await user.click(tap);

    await waitFor(() => {
      expect(vi.mocked(lemmatize)).toHaveBeenCalledWith('재택근무');
    });
    await waitFor(() => {
      expect(vi.mocked(defineEntry)).toHaveBeenCalledWith('재택근무');
    });
    await waitFor(() => {
      expect(vi.mocked(enrich)).toHaveBeenCalledWith({
        lemma: '재택근무',
        sourceSentence: '재택근무 합니다.',
      });
    });
    // Popover surfaces the enrichment nuance as the gloss line (the entry
    // carried no English definition).
    await waitFor(() => {
      expect(screen.getByText('working from home')).toBeInTheDocument();
    });
  });

  it('slow-path graceful degradation: enrich failure still opens popover on define result', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '재택근무',
      entries: [
        {
          id: 1,
          headword: '재택근무',
          part_of_speech: 'n.',
          definition_korean: '집에서 일함',
          definition_english: 'remote work',
          examples: [],
        },
      ],
    });
    vi.mocked(enrich).mockRejectedValue(new Error('claude timeout'));

    const user = userEvent.setup();
    renderReading();

    const tap = screen.getByRole('button', { name: '재택근무' });
    await user.click(tap);

    // Define succeeded → popover opens on the dictionary entry alone, with
    // the KRDICT English definition as the gloss line (B-002: previously the
    // gloss ignored `definition_english` entirely).
    await waitFor(() => {
      const popover = screen.getByRole('dialog');
      expect(popover).toBeInTheDocument();
    });
    expect(screen.getByText('remote work')).toBeInTheDocument();
  });

  it('default load (no persisted pick) reads the iyagi prose corpus, not ttmik (B-001)', async () => {
    // The realFn is captured from the hook boundary and driven directly:
    // this is the exact loader a fresh visit runs.
    hoisted.hookState.current = { kind: 'loading' };
    vi.mocked(fetchUnits).mockResolvedValue([
      { id: 45, title: '이야기 #1', episode_number: 1 },
    ]);
    vi.mocked(fetchSentences).mockResolvedValue({
      corpus: 'iyagi',
      unit_id: 45,
      sentences: [
        {
          id: 1,
          ordinal: 1,
          korean: '오늘은 노약자석에 대해서 이야기해 봐요.',
          english: "Let's talk about priority seats today.",
          romanization: null,
          speaker: '진석진',
          is_dialog: true,
        },
      ],
    });
    renderReading();

    expect(hoisted.lastRealFn.current).not.toBeNull();
    const passage = (await hoisted.lastRealFn.current?.()) as ReadingPassage;

    // The default is the Iyagi transcripts — real multi-word prose — not the
    // TTMIK word-family lessons that rendered as one-word-per-line lists.
    expect(vi.mocked(fetchUnits)).toHaveBeenCalledWith({
      corpus: 'iyagi',
      limit: 1,
    });
    expect(vi.mocked(fetchSentences)).toHaveBeenCalledWith('iyagi', 45);
    expect(passage.title).toBe('이야기 #1');
    // The prose sentence tokenises into multiple tapwords (B-003: no more
    // single-token "sentences").
    const words = passage.sentences[0].tokens.filter((t) => t.gloss);
    expect(words.length).toBeGreaterThan(1);
  });

  it('popover maps KRDICT definition + examples and enrichment drawer fields (B-002)', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '재택근무',
      entries: [
        {
          id: 7,
          headword: '재택근무',
          part_of_speech: 'n.',
          definition_korean: '집에서 일함',
          definition_english: 'remote work',
          examples: [
            { korean: '재택근무를 시작했다.', english: 'I started working from home.' },
            { korean: '재택근무 제도', english: null },
          ],
        },
      ],
    });
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: 'working from home as an arrangement',
        usageNote: 'Common in HR contexts.',
        examples: [
          { korean: '재택근무 중이에요.', english: 'I am working from home.' },
        ],
        dontConfuseWith: [
          { lemma: '원격근무', distinction: 'broader: any remote location' },
        ],
        proficiency: 'L4',
      },
    });

    const user = userEvent.setup();
    renderReading();
    await user.click(screen.getByRole('button', { name: '재택근무' }));

    // Gloss line = the KRDICT English definition.
    expect(await screen.findByText('remote work')).toBeInTheDocument();
    // Primary example = the FIRST krdict example (no longer hardcoded '').
    expect(
      screen.getByText('재택근무를 시작했다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('I started working from home.')).toBeInTheDocument();

    // Drawer: remaining krdict example + enrichment example + usage + contrast.
    await user.click(screen.getByRole('button', { name: 'More examples' }));
    expect(screen.getByText('재택근무 제도')).toBeInTheDocument();
    expect(screen.getByText('재택근무 중이에요.')).toBeInTheDocument();
    expect(screen.getByText('Common in HR contexts.')).toBeInTheDocument();
    expect(
      screen.getByText(/원격근무 — broader: any remote location/),
    ).toBeInTheDocument();
  });

  it('define failure still yields an enrichment-backed popover, not "Definition unavailable" (B-002/B-011)', async () => {
    // KRDICT tables unloaded → /define 503s. The enrichment alone must
    // still produce a real popover (this is the state on a box where the
    // KRDICT corpus hasn't been ingested).
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockRejectedValue(
      new ApiError('krdict unavailable', {
        status: 503,
        code: 'krdict_unavailable',
      }),
    );
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: 'working from home',
        usageNote: 'Common in HR contexts.',
        examples: [
          { korean: '재택근무를 해요.', english: 'I work from home.' },
        ],
        dontConfuseWith: [],
        proficiency: 'L4',
      },
    });

    const user = userEvent.setup();
    renderReading();
    await user.click(screen.getByRole('button', { name: '재택근무' }));

    // Nuance is the gloss; the enrichment example is the primary example.
    expect(await screen.findByText('working from home')).toBeInTheDocument();
    expect(screen.getByText('재택근무를 해요.')).toBeInTheDocument();
    expect(
      screen.queryByText('Definition unavailable'),
    ).not.toBeInTheDocument();
  });

  it('falls back to "Definition unavailable" only when define AND enrich both fail', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockRejectedValue(
      new ApiError('krdict unavailable', {
        status: 503,
        code: 'krdict_unavailable',
      }),
    );
    vi.mocked(enrich).mockRejectedValue(new Error('claude timeout'));

    const user = userEvent.setup();
    renderReading();
    await user.click(screen.getByRole('button', { name: '재택근무' }));

    expect(
      await screen.findByText('Definition unavailable'),
    ).toBeInTheDocument();
    // No drawer affordance for an empty popover.
    expect(
      screen.queryByRole('button', { name: 'More examples' }),
    ).not.toBeInTheDocument();
  });

  /**
   * Drive the slow path to a resolved popover so the Add gesture carries the
   * KRDICT entry id (`/define` entries[0].id) the way the real chain does.
   * Returns the userEvent handle so callers can keep interacting.
   */
  async function openSlowPathPopover(): Promise<ReturnType<typeof userEvent.setup>> {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    vi.mocked(lemmatize).mockResolvedValue([
      { form: '재택근무', lemma: '재택근무', tag: 'NNG', start: 0, length: 4 },
    ]);
    vi.mocked(defineEntry).mockResolvedValue({
      word: '재택근무',
      entries: [
        {
          id: 4242,
          headword: '재택근무',
          part_of_speech: 'n.',
          definition_korean: null,
          definition_english: 'working from home',
          examples: [],
        },
      ],
    });
    vi.mocked(enrich).mockResolvedValue({
      result: {
        nuance: 'doing one’s job from home rather than the office',
        usageNote: 'Common in HR contexts.',
        examples: [
          { korean: '재택근무를 해요.', english: 'I work from home.' },
        ],
        dontConfuseWith: [],
        proficiency: 'L4',
      },
    });

    const user = userEvent.setup();
    renderReading();
    await user.click(screen.getByRole('button', { name: '재택근무' }));
    // Wait for the chain to resolve so the Add action (suppressed while
    // loading) appears.
    await screen.findByRole('button', { name: /Add to vocab/i });
    return user;
  }

  it('add-to-bank fires mineWord with the resolved KRDICT entry id + optimistic flip (FU-NF-33)', async () => {
    const user = await openSlowPathPopover();

    await user.click(screen.getByRole('button', { name: /Add to vocab/i }));

    // The bank fires with the lemma + resolved KRDICT entry id + gloss.
    await waitFor(() => {
      expect(vi.mocked(mineWord)).toHaveBeenCalledTimes(1);
    });
    const [body, signal] = vi.mocked(mineWord).mock.calls[0] ?? [];
    expect(body).toMatchObject({
      lemma: '재택근무',
      krdictEntryId: 4242,
      english: 'working from home',
    });
    // The popover-scoped abort signal is threaded through.
    expect(signal).toBeInstanceOf(AbortSignal);

    // The Add button locks to "Added" (optimistic flip).
    expect(
      screen.getByRole('button', { name: /Added to vocab/i }),
    ).toBeInTheDocument();
  });

  it('rolls the optimistic flip back + toasts when the bank fails (FU-NF-33)', async () => {
    vi.mocked(mineWord).mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = await openSlowPathPopover();

    await user.click(screen.getByRole('button', { name: /Add to vocab/i }));

    // The non-blocking failure toast surfaces fixed copy (never server text).
    expect(await screen.findByText(/Couldn't bank — try again/i)).toBeInTheDocument();
    // The tap UX is intact — the popover is still open and usable.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('swallows a canceled bank (popover close) without toasting (FU-NF-33)', async () => {
    vi.mocked(mineWord).mockRejectedValue(
      new ApiError('request canceled', { status: 0, code: 'canceled' }),
    );
    const user = await openSlowPathPopover();

    await user.click(screen.getByRole('button', { name: /Add to vocab/i }));

    await waitFor(() => {
      expect(vi.mocked(mineWord)).toHaveBeenCalledTimes(1);
    });
    // No failure toast for an aborted request.
    expect(screen.queryByText(/Couldn't bank/i)).not.toBeInTheDocument();
  });

  it('slow-path opens the popover IMMEDIATELY with a loading affordance (C-SF-1)', async () => {
    // Lemmatize hangs forever — the popover MUST still appear right after
    // the tap, with the spinner showing while the chain settles. This is
    // the contract the Pass 3 tightening cycle introduced: no more "tap
    // a word and stare at nothing for 500ms" UX.
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_PLACEHOLDER,
      isMock: false,
    };
    // Pending promise — never resolves during the test window.
    vi.mocked(lemmatize).mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.mocked(defineEntry).mockImplementation(
      () => new Promise(() => undefined),
    );

    const user = userEvent.setup();
    renderReading();

    await user.click(screen.getByRole('button', { name: '재택근무' }));

    // The popover dialog is visible — the user's tap got a visible
    // response even though the chain hasn't resolved a single step.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The loading affordance is rendered (spinner placeholder).
    expect(
      screen.getByTestId('word-popover-loading'),
    ).toBeInTheDocument();
    // The Add-to-bank action is suppressed while loading — the user
    // shouldn't be able to bank data that hasn't resolved yet.
    expect(
      screen.queryByRole('button', { name: /Add to vocab/i }),
    ).not.toBeInTheDocument();
  });

  it('grammar span tap calls identifyPattern with span + sentence', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_GRAMMAR,
      isMock: true,
    };
    vi.mocked(identifyPattern).mockResolvedValue({
      result: { pattern: '-는 반면', summary: 'whereas / on the other hand' },
    });

    const user = userEvent.setup();
    renderReading();

    // The grammar span renders as a single role=button covering the run.
    const span = screen.getByRole('button', {
      name: /Grammar pattern g4 — open/i,
    });
    await user.click(span);

    await waitFor(() => {
      expect(vi.mocked(identifyPattern)).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(identifyPattern).mock.calls[0]?.[0];
    expect(call?.highlightSpan).toContain('반면');
    expect(call?.fullSentence).toContain('반면');

    // Popover opens in grammar mode — shows the returned pattern.
    await waitFor(() => {
      expect(screen.getByText('-는 반면')).toBeInTheDocument();
    });
  });

  it('opens the passage picker and lists the default (iyagi) corpus units', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_WITH_GLOSS,
      isMock: true,
    };
    vi.mocked(fetchUnitsPage).mockResolvedValue({
      corpus: 'iyagi',
      total: 2,
      units: [
        { id: 45, title: '이야기 #1', episode_number: 1 },
        { id: 46, title: '이야기 #2', episode_number: 2 },
      ],
    });

    const user = userEvent.setup();
    renderReading();

    await user.click(
      screen.getByRole('button', { name: /Choose a different passage/i }),
    );

    // The picker sheet opens on the default corpus tab (B-001: iyagi).
    expect(
      await screen.findByRole('dialog', { name: /Choose a reading passage/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText('이야기 #2')).toBeInTheDocument();
    expect(vi.mocked(fetchUnitsPage)).toHaveBeenCalledWith({
      corpus: 'iyagi',
      limit: 20,
      offset: 0,
    });
  });

  it('selecting a unit persists the pick to localStorage', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_WITH_GLOSS,
      isMock: true,
    };
    vi.mocked(fetchUnitsPage).mockResolvedValue({
      corpus: 'iyagi',
      total: 2,
      units: [
        { id: 45, title: '이야기 #1', episode_number: 1 },
        { id: 46, title: '이야기 #2', episode_number: 2 },
      ],
    });

    const user = userEvent.setup();
    renderReading();

    await user.click(
      screen.getByRole('button', { name: /Choose a different passage/i }),
    );
    const row = await screen.findByRole('button', {
      name: /이야기 #2 — Episode 2/i,
    });
    await user.click(row);

    // The pick is persisted so a return visit reopens this passage.
    await waitFor(() => {
      const raw = window.localStorage.getItem(READING_SELECTION_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual({
        corpus: 'iyagi',
        unitId: 46,
        title: '이야기 #2',
      });
    });
  });

  it('switches the corpus tab to load ttmik lessons', async () => {
    hoisted.hookState.current = {
      kind: 'data',
      data: PASSAGE_WITH_GLOSS,
      isMock: true,
    };
    vi.mocked(fetchUnitsPage).mockImplementation((opts) =>
      Promise.resolve(
        opts.corpus === 'ttmik'
          ? {
              corpus: 'ttmik',
              total: 1,
              units: [
                { id: 11, title: '안녕하세요', lesson_level: 1, lesson_number: 1 },
              ],
            }
          : {
              corpus: 'iyagi',
              total: 1,
              units: [{ id: 30, title: '이야기 에피소드', episode_number: 5 }],
            },
      ),
    );

    const user = userEvent.setup();
    renderReading();

    await user.click(
      screen.getByRole('button', { name: /Choose a different passage/i }),
    );
    await screen.findByText('이야기 에피소드');
    await user.click(screen.getByRole('radio', { name: 'TTMIK' }));

    expect(await screen.findByText('안녕하세요')).toBeInTheDocument();
    expect(vi.mocked(fetchUnitsPage)).toHaveBeenCalledWith({
      corpus: 'ttmik',
      limit: 20,
      offset: 0,
    });
  });
});
