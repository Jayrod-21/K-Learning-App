/**
 * ReviewGrammar — the library's single grammar browse (P1.2, D3), reworked
 * in Phase 3B (F-054/F-055/F-056/F-024).
 *
 * Ports the old Reference.tsx Grammar-tab tests (full fetch, F-004 detail
 * Sheet, the stale-rows fix) AND the LEARN Grammar screen's list-tab Bank
 * tests (the Bank action moved here with the browse), then adds the 3B
 * surfaces: the F-054 removals are asserted as REGRESSIONS (search box,
 * genre filter, and the Vocabulary/Dictionary strip must stay gone), F-055's
 * difficulty dropdown drives the real query param, F-024's BackButton
 * navigates to the real /review route, and F-056's Uploads view exercises
 * the real listUploads → per-upload listPatterns fan-out (grouping, the
 * zero-row drop, the error+Retry path, and banking from a group row).
 * Services are module-mocked; the component's own state/effects run for
 * real so the filters, optimistic bank flip, and stale-guards participate.
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
import { ApiError } from '../../services/api';
import type {
  BankGrammarBody,
  KgiuEntryDetail,
  KgiuEntrySummary,
} from '../../types/domain';

const grammarSvc = vi.hoisted(() => ({
  listPatterns: vi.fn(),
  listBanked: vi.fn(),
  bankPattern: vi.fn(),
  getPattern: vi.fn(),
}));

// Uploads service — feeds BOTH the U1 sort-by-source filter row (browse
// view) and the F-056 Uploads view. Defaults to empty so browse-focused
// tests see no source row and an empty Uploads view.
const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
}));

vi.mock('../../services/grammar', () => grammarSvc);
vi.mock('../../services/uploads', () => uploadsSvc);

import ReviewGrammar from './ReviewGrammar';
import type { BookUpload } from '../../types/domain';

const ROW: KgiuEntrySummary = {
  id: 100,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-009',
  pattern: '-는 반면에',
  title_en: 'whereas',
  category: 'contrast',
  proficiency: 'L4',
  unit: 'Unit 9',
  source_pages: null,
};

const ROW_2: KgiuEntrySummary = {
  id: 101,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-010',
  pattern: '-느라고',
  title_en: 'because of doing X',
  category: 'causal',
  proficiency: 'L4',
  unit: 'Unit 10',
  source_pages: null,
};

const DETAIL: KgiuEntryDetail = {
  ...ROW,
  explanation: 'Contrasts two clauses — "whereas / while on the other hand".',
  formation_rules: ['Verb stem + 는 반면에'],
  examples: [
    {
      korean: '동생은 활발한 반면에 형은 조용해요.',
      english: 'The younger brother is outgoing, whereas the older one is quiet.',
    },
  ],
  dialogues: [
    {
      context: 'Comparing two apartments.',
      lines: [
        {
          speaker: '지은',
          korean: '이 집은 넓은 반면에 좀 어두워요.',
          english: 'This place is spacious, whereas it is a bit dark.',
        },
      ],
    },
  ],
  vocabulary: null,
  tips: null,
  compare_with: null,
  exercises: null,
  cultural_notes: null,
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/review/grammar']}>
      <Routes>
        <Route path="/review/grammar" element={<ReviewGrammar />} />
        {/* F-024 destination — a stub so the BackButton test asserts a REAL
            navigation, not just a click. */}
        <Route path="/review" element={<div>Review hub stub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const READY_UPLOAD: BookUpload = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'ready',
  byteSize: 4_200_000,
  createdAt: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  for (const fn of Object.values(grammarSvc)) (fn as Mock).mockReset();
  grammarSvc.listPatterns.mockResolvedValue([ROW]);
  grammarSvc.listBanked.mockResolvedValue({ entries: [] });
  grammarSvc.bankPattern.mockResolvedValue({ id: 1 });
  grammarSvc.getPattern.mockResolvedValue(DETAIL);
  uploadsSvc.listUploads.mockReset();
  uploadsSvc.listUploads.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewGrammar — browse (the old Reference Grammar tab)', () => {
  it('lists every pattern from the full (raised-limit) fetch', async () => {
    renderPage();
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 400 }),
        expect.anything(),
      );
    });
  });

  it('F-054 — search box, genre filter, and the Vocabulary/Dictionary strip are gone', async () => {
    renderPage();
    await screen.findByText(/1 pattern/);

    // Search-all-grammar-patterns is removed.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Search all grammar patterns'),
    ).not.toBeInTheDocument();
    // Genre/topic (content_domain) filter is removed — grammar has no
    // genre axis.
    expect(
      screen.queryByRole('group', { name: 'Filter grammar by topic' }),
    ).not.toBeInTheDocument();
    // The library section strip (Vocabulary/Dictionary links) is removed —
    // guard both the current LibrarySubnav landmark name and the pre-F-043
    // one so neither vintage can creep back.
    expect(
      screen.queryByRole('navigation', { name: 'Library sections' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Review library section' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Vocabulary/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Dictionary/ }),
    ).not.toBeInTheDocument();
    // No fetch ever carries the removed params.
    for (const call of grammarSvc.listPatterns.mock.calls) {
      expect(call[0]).not.toHaveProperty('domain');
      expect(call[0]).not.toHaveProperty('q');
    }
  });

  it('F-055 — the difficulty dropdown drives book_level and the placeholder clears it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    // A labelled native select (FilterSelect) — the label IS the accessible
    // name, so AT users hear what the control filters.
    const select = screen.getByRole('combobox', { name: 'Difficulty' });

    grammarSvc.listPatterns.mockClear();
    await user.selectOptions(select, 'advanced');
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ book_level: 'advanced' }),
        expect.anything(),
      );
    });

    // Back to the "All levels" placeholder → the param is omitted again
    // (never sent as 'all' or '').
    grammarSvc.listPatterns.mockClear();
    await user.selectOptions(
      select,
      screen.getByRole('option', { name: 'All levels' }),
    );
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.not.objectContaining({ book_level: expect.anything() }),
        expect.anything(),
      );
    });
  });

  it('a failed filter fetch shows an ErrorCard instead of the stale rows + stale count', async () => {
    grammarSvc.listPatterns
      .mockResolvedValueOnce([ROW]) // mount ('All levels')
      .mockRejectedValueOnce(
        new ApiError('grammar filter failed', { status: 500, code: 'server' }),
      )
      .mockResolvedValue([ROW]); // Retry

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Difficulty' }),
      'advanced',
    );
    expect(
      await screen.findByText('Could not load grammar.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('grammar filter failed')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '-는 반면에 whereas' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/1 pattern/)).not.toBeInTheDocument();

    // Retry re-runs the filtered fetch and restores the list + count.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    ).toBeInTheDocument();
  });

  it('opens the detail Sheet on row tap — fetches getPattern(id) and renders the explanation (F-004/F-018)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );
    expect(grammarSvc.getPattern).toHaveBeenCalledWith(100);

    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(
        'Contrasts two clauses — "whereas / while on the other hand".',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Unit 9/)).toBeInTheDocument();

    // F-018 — the rich sections render through the shared KgiuDetailBody.
    expect(within(dialog).getByText('Formation')).toBeInTheDocument();
    expect(within(dialog).getByText('Verb stem + 는 반면에')).toBeInTheDocument();
    expect(
      within(dialog).getByText('동생은 활발한 반면에 형은 조용해요.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Comparing two apartments.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('지은')).toBeInTheDocument();
    expect(
      within(dialog).getByText('이 집은 넓은 반면에 좀 어두워요.'),
    ).toBeInTheDocument();
  });

  it('a failed detail fetch surfaces fixed copy in the Sheet (row list keeps working)', async () => {
    grammarSvc.getPattern.mockRejectedValueOnce(
      new ApiError('kgiu entry not found', { status: 404, code: 'not_found' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );

    const dialog = await screen.findByRole('dialog');
    // Fixed copy (F-UP-018) — the 404's server prose must not render.
    expect(
      await within(dialog).findByText('Detail unavailable'),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText('kgiu entry not found'),
    ).not.toBeInTheDocument();
  });

  it('drops a late detail settle for a previously opened row (stale-guard)', async () => {
    grammarSvc.listPatterns.mockResolvedValue([ROW, ROW_2]);
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

    // Row A's detail hangs until released; row B's resolves immediately.
    let releaseA!: (d: KgiuEntryDetail) => void;
    grammarSvc.getPattern.mockImplementation(async (id: number) => {
      if (id === ROW.id) {
        return new Promise<KgiuEntryDetail>((resolve) => {
          releaseA = resolve;
        });
      }
      return DETAIL_2;
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/2 patterns/);

    // Open A — its detail fetch stays in flight.
    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );
    await waitFor(() => {
      expect(grammarSvc.getPattern).toHaveBeenCalledWith(100);
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

    // A's stale settle lands late — it must be dropped, not painted under
    // B's header.
    await act(async () => {
      releaseA(DETAIL);
    });
    expect(
      within(dialog).getByText(/Causal — because of doing X/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/Contrasts two clauses/),
    ).not.toBeInTheDocument();
  });
});

describe('ReviewGrammar — Bank action (moved from the LEARN list tab, D3)', () => {
  it('calls bankPattern with the coerced body on Bank tap and flips the chip', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(
      screen.getByRole('button', { name: 'Bank -는 반면에' }),
    );
    await waitFor(() => {
      expect(grammarSvc.bankPattern).toHaveBeenCalledTimes(1);
    });
    const body = grammarSvc.bankPattern.mock.calls[0]![0] as BankGrammarBody;
    // grammarKey() derives the GR-shaped dedup key the server's
    // `^GR-[a-z0-9_-]{1,64}$` regex requires (raw source_id would 400).
    expect(body.pattern_key).toBe('GR-kgiu-int-009');
    expect(body.pattern_display).toBe('-는 반면에');
    expect(body.summary_en).toBe('whereas');
    expect('register' in body).toBe(false);
    // Optimistic chip flip.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Already banked' }),
      ).toBeInTheDocument();
    });
  });

  it('renders already-banked rows as Banked (reconciles with the LEARN bank)', async () => {
    grammarSvc.listBanked.mockResolvedValue({
      entries: [
        {
          id: 501,
          pattern_key: 'GR-kgiu-int-009',
          pattern_display: '-는 반면에',
          summary_en: 'whereas',
          proficiency: 'L4',
          category: 'contrast',
          register: null,
          discovered_via: 'manual',
          created_at: '2026-06-01T00:00:00Z',
          graduated_at: null,
        },
      ],
    });
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'Already banked' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Bank -는 반면에' }),
    ).not.toBeInTheDocument();
  });

  it('treats a 409 (already banked) as success — the flip stays', async () => {
    grammarSvc.bankPattern.mockRejectedValueOnce(
      new ApiError('already banked', { status: 409, code: 'conflict' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(screen.getByRole('button', { name: 'Bank -는 반면에' }));
    expect(
      await screen.findByRole('button', { name: 'Already banked' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Couldn't bank that pattern/),
    ).not.toBeInTheDocument();
  });

  it('rewinds the flip and surfaces fixed copy on a real failure', async () => {
    grammarSvc.bankPattern.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(screen.getByRole('button', { name: 'Bank -는 반면에' }));
    expect(
      await screen.findByText(/Couldn't bank that pattern. Try again./),
    ).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    // The row reverted to bankable.
    expect(
      screen.getByRole('button', { name: 'Bank -는 반면에' }),
    ).toBeInTheDocument();
  });

  it('the detail Sheet carries the Bank action too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: '문형 담기 · Bank pattern' }),
    );
    await waitFor(() => {
      expect(grammarSvc.bankPattern).toHaveBeenCalledTimes(1);
    });
    expect(
      await within(dialog).findByRole('button', { name: '이미 담김 · Already banked' }),
    ).toBeInTheDocument();
  });
});

describe('ReviewGrammar — BackButton (F-024)', () => {
  it('navigates to the /review library index', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    // The label comes from navItem('review') — the tab is "Library" (F-043).
    await user.click(
      screen.getByRole('button', { name: 'Back to Library' }),
    );
    expect(await screen.findByText('Review hub stub')).toBeInTheDocument();
  });
});

describe('ReviewGrammar — Browse/Uploads tabs (shared Tabs, W3C APG contract)', () => {
  it('delivers the full tabs contract: roving tabindex, arrow/Home keys, labelled tabpanel', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    const browseTab = screen.getByRole('tab', { name: /Browse/ });
    const uploadsTab = screen.getByRole('tab', { name: /Uploads/ });

    // Selected tab carries the tab stop; the other is roving (-1).
    expect(browseTab).toHaveAttribute('aria-selected', 'true');
    expect(browseTab).toHaveAttribute('tabindex', '0');
    expect(uploadsTab).toHaveAttribute('aria-selected', 'false');
    expect(uploadsTab).toHaveAttribute('tabindex', '-1');

    // The active panel is a real tabpanel wired to the selected tab.
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', browseTab.id);
    expect(browseTab).toHaveAttribute('aria-controls', panel.id);

    // ArrowRight: focus AND selection move to Uploads (automatic
    // activation) — the roving tab stop follows.
    browseTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(uploadsTab).toHaveFocus();
    expect(uploadsTab).toHaveAttribute('aria-selected', 'true');
    expect(uploadsTab).toHaveAttribute('tabindex', '0');
    expect(browseTab).toHaveAttribute('tabindex', '-1');
    expect(
      await screen.findByText(/No grammar from your uploads yet/),
    ).toBeInTheDocument();

    // Home: back to the first tab, panel follows.
    await user.keyboard('{Home}');
    expect(browseTab).toHaveFocus();
    expect(browseTab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();
  });
});

describe('ReviewGrammar — U1 sort-by-source filter scaffolding', () => {
  it('renders no source row when the user has no ready uploads', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    renderPage();
    await screen.findByText(/1 pattern/);
    expect(
      screen.queryByRole('group', { name: 'Filter grammar by source book' }),
    ).not.toBeInTheDocument();
  });

  it('lists ready uploads as filter chips and sets source_upload_id on select', async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      READY_UPLOAD,
      { ...READY_UPLOAD, id: '10', title: '처리 중인 책', status: 'processing' },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    const group = await screen.findByRole('group', {
      name: 'Filter grammar by source book',
    });
    expect(within(group).getByText('한국어 문법 사전')).toBeInTheDocument();
    expect(within(group).queryByText('처리 중인 책')).not.toBeInTheDocument();

    await user.click(within(group).getByText('한국어 문법 사전'));

    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenLastCalledWith(
        expect.objectContaining({ source_upload_id: '9' }),
        expect.anything(),
      );
    });

    expect(
      screen.getByRole('button', { name: /View PDF/ }),
    ).toBeInTheDocument();
  });
});

describe('ReviewGrammar — Uploads view (F-056)', () => {
  /** Switch from the default Browse view to the Uploads view. */
  async function openUploadsView(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await screen.findByText(/1 pattern/); // browse settled first
    await user.click(screen.getByRole('tab', { name: /Uploads/ }));
  }

  it('shows the empty state (and fetches nothing per-source) when no ready upload exists', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await openUploadsView(user);

    expect(
      await screen.findByText(/No grammar from your uploads yet/),
    ).toBeInTheDocument();
    // No upload → no per-source pattern query was ever issued.
    const sourceScoped = grammarSvc.listPatterns.mock.calls.filter((call) =>
      Object.hasOwn(call[0] as object, 'source_upload_id'),
    );
    expect(sourceScoped).toHaveLength(0);
  });

  it('groups patterns by source upload and drops grammar-free uploads', async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      READY_UPLOAD, // id '9' — carries ROW
      { ...READY_UPLOAD, id: '11', title: '단어만 있는 책', type: 'vocab' },
    ]);
    grammarSvc.listPatterns.mockImplementation(
      async (opts?: { source_upload_id?: string }) => {
        if (opts?.source_upload_id === '9') return [ROW];
        if (opts?.source_upload_id === '11') return []; // grammar-free
        return [ROW]; // the browse view's unscoped fetch
      },
    );
    const user = userEvent.setup();
    renderPage();
    await openUploadsView(user);

    // The grammar-bearing upload renders as a titled group with its rows.
    const heading = await screen.findByRole('heading', {
      name: /한국어 문법 사전/,
    });
    const group = heading.closest('section');
    expect(group).not.toBeNull();
    expect(
      within(group as HTMLElement).getByRole('button', {
        name: '-는 반면에 whereas',
      }),
    ).toBeInTheDocument();

    // The grammar-free upload was QUERIED (it could have carried grammar)
    // but renders no group.
    expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
      expect.objectContaining({ source_upload_id: '11', limit: 400 }),
      expect.anything(),
    );
    expect(screen.queryByText('단어만 있는 책')).not.toBeInTheDocument();
  });

  it('a failed uploads fetch surfaces an ErrorCard whose Retry recovers', async () => {
    uploadsSvc.listUploads.mockRejectedValue(
      new ApiError('uploads down', { status: 500, code: 'server' }),
    );
    const user = userEvent.setup();
    renderPage();
    await openUploadsView(user);

    expect(
      await screen.findByText('Could not load your uploads.'),
    ).toBeInTheDocument();
    // Fixed copy — the server prose must not render.
    expect(screen.queryByText('uploads down')).not.toBeInTheDocument();

    uploadsSvc.listUploads.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText(/No grammar from your uploads yet/),
    ).toBeInTheDocument();
  });

  it('banking works from an upload group row (shared bank state)', async () => {
    uploadsSvc.listUploads.mockResolvedValue([READY_UPLOAD]);
    grammarSvc.listPatterns.mockImplementation(
      async (opts?: { source_upload_id?: string }) => {
        if (opts?.source_upload_id === '9') return [ROW];
        return [ROW];
      },
    );
    const user = userEvent.setup();
    renderPage();
    await openUploadsView(user);
    await screen.findByRole('heading', { name: /한국어 문법 사전/ });

    await user.click(screen.getByRole('button', { name: 'Bank -는 반면에' }));
    await waitFor(() => {
      expect(grammarSvc.bankPattern).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole('button', { name: 'Already banked' }),
    ).toBeInTheDocument();
  });
});
