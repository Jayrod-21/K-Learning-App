/**
 * ReviewGrammar — the library's single grammar browse (P1.2, D3).
 *
 * Ports the old Reference.tsx Grammar-tab tests (full fetch, F-004 detail
 * Sheet, F-005 filters, the stale-rows fix) AND the LEARN Grammar screen's
 * list-tab Bank tests (the Bank action moved here with the browse). Services
 * are module-mocked; the component's own state/effects run for real so the
 * debounce, filters, optimistic bank flip, and stale-guards participate.
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

vi.mock('../../services/grammar', () => grammarSvc);

import ReviewGrammar from './ReviewGrammar';

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
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(grammarSvc)) (fn as Mock).mockReset();
  grammarSvc.listPatterns.mockResolvedValue([ROW]);
  grammarSvc.listBanked.mockResolvedValue({ entries: [] });
  grammarSvc.bankPattern.mockResolvedValue({ id: 1 });
  grammarSvc.getPattern.mockResolvedValue(DETAIL);
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

  it('domain + level filters refetch with the matching query params (F-005)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/1 pattern/);

    grammarSvc.listPatterns.mockClear();
    const topicGroup = screen.getByRole('group', { name: 'Filter grammar by topic' });
    await user.click(within(topicGroup).getByRole('button', { name: 'Research' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'research' }),
        expect.anything(),
      );
    });

    grammarSvc.listPatterns.mockClear();
    const levelGroup = screen.getByRole('group', { name: 'Filter grammar by level' });
    await user.click(within(levelGroup).getByRole('button', { name: 'Advanced' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'research', book_level: 'advanced' }),
        expect.anything(),
      );
    });

    // Back to All → the param is omitted again (never sent as 'all').
    grammarSvc.listPatterns.mockClear();
    await user.click(within(topicGroup).getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.not.objectContaining({ domain: expect.anything() }),
        expect.anything(),
      );
    });
  });

  it('a failed filter fetch shows an ErrorCard instead of the stale rows + stale count', async () => {
    grammarSvc.listPatterns
      .mockResolvedValueOnce([ROW]) // mount ('All')
      .mockRejectedValueOnce(
        new ApiError('grammar filter failed', { status: 500, code: 'server' }),
      )
      .mockResolvedValue([ROW]); // Retry

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();

    const levelGroup = screen.getByRole('group', {
      name: 'Filter grammar by level',
    });
    await user.click(
      within(levelGroup).getByRole('button', { name: 'Advanced' }),
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
