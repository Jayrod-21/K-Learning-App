/**
 * Reference — Pass-3 search + filter + popover wiring tests.
 *
 * Services are mocked at module level; `useEndpointOrMock` runs for
 * real so the debounce + key-driven refetch + abort paths participate
 * in the assertion. The mock fixture loader is mocked too so the
 * ErrorCard branch (both real + mock fail) is reachable.
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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DefineResult,
  KgiuEntrySummary,
  ReferenceEntry,
  VocabEntry,
} from '../types/domain';

// Hoisted service mocks — referenced inside vi.mock factories.
const vocabSvc = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getDueCards: vi.fn(),
  submitReview: vi.fn(),
  initCards: vi.fn(),
  listLists: vi.fn(),
  createList: vi.fn(),
  getList: vi.fn(),
  patchList: vi.fn(),
  deleteList: vi.fn(),
  addListEntries: vi.fn(),
  removeListEntry: vi.fn(),
}));

const grammarSvc = vi.hoisted(() => ({
  listPatterns: vi.fn(),
  getPattern: vi.fn(),
  bankPattern: vi.fn(),
  listBanked: vi.fn(),
  identifyPattern: vi.fn(),
}));

const defineSvc = vi.hoisted(() => ({
  defineEntry: vi.fn(),
}));

const refMock = vi.hoisted(() => ({
  loadReferenceMock: vi.fn(),
}));

vi.mock('../services/vocab', () => vocabSvc);
vi.mock('../services/grammar', () => grammarSvc);
vi.mock('../services/define', () => defineSvc);
vi.mock('../data/mocks/reference', () => refMock);

import Reference from './Reference';

const VOCAB_ROW: VocabEntry = {
  id: 1,
  corpus: 'vocab_2000_intermediate',
  korean: '영향',
  english: 'influence',
  proficiency: 'L3',
  theme: null,
};

const VOCAB_ROW_2: VocabEntry = {
  id: 2,
  corpus: 'vocab_2000_intermediate',
  korean: '환경',
  english: 'environment',
  proficiency: 'L3',
  theme: null,
};

const GRAMMAR_ROW: KgiuEntrySummary = {
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

const DEFINE_HIT: DefineResult = {
  word: '영향',
  entries: [
    {
      id: 1,
      headword: '영향',
      part_of_speech: 'n.',
      senses: [],
      examples: [],
    },
  ],
};

const REF_FIXTURE: ReferenceEntry[] = [
  { kind: 'vocab', kr: '영향', en: 'influence', level: 'L3' },
  { kind: 'grammar', kr: '-는 반면에', en: 'whereas', level: 'L4' },
];

function resetAll(): void {
  for (const fn of Object.values(vocabSvc)) (fn as Mock).mockReset();
  for (const fn of Object.values(grammarSvc)) (fn as Mock).mockReset();
  for (const fn of Object.values(defineSvc)) (fn as Mock).mockReset();
  (refMock.loadReferenceMock as Mock).mockReset();
  refMock.loadReferenceMock.mockResolvedValue(REF_FIXTURE);
}

beforeEach(() => {
  resetAll();
  vocabSvc.searchEntries.mockResolvedValue([VOCAB_ROW, VOCAB_ROW_2]);
  grammarSvc.listPatterns.mockResolvedValue([GRAMMAR_ROW]);
  defineSvc.defineEntry.mockResolvedValue(DEFINE_HIT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reference — happy path', () => {
  it('renders the union of vocab + grammar under the All filter', async () => {
    render(<Reference />);
    expect(await screen.findByText('영향')).toBeInTheDocument();
    expect(screen.getByText('환경')).toBeInTheDocument();
    expect(screen.getByText('-는 반면에')).toBeInTheDocument();
    // 3 rows: 2 vocab + 1 grammar (hanja mock fixture has zero hanja rows).
    expect(screen.getByText(/3 results/)).toBeInTheDocument();
  });
});

describe('Reference — filter chips', () => {
  it('switches source when the Grammar chip is selected', async () => {
    const user = userEvent.setup();
    render(<Reference />);
    await screen.findByText('영향');

    await user.click(screen.getByRole('button', { name: 'Grammar' }));

    expect(await screen.findByText(/1 result/)).toBeInTheDocument();
    expect(screen.getByText('-는 반면에')).toBeInTheDocument();
    expect(screen.queryByText('영향')).not.toBeInTheDocument();
  });
});

describe('Reference — search debounce', () => {
  it('calls the services after debounce and passes q through', async () => {
    const user = userEvent.setup();
    render(<Reference />);
    await screen.findByText('영향');

    vocabSvc.searchEntries.mockClear();
    grammarSvc.listPatterns.mockClear();

    const box = screen.getByRole('searchbox', { name: 'Search reference' });
    await user.type(box, '영향');

    // Past the 200 ms debounce, both services should have been called
    // with the q payload.
    await waitFor(() => {
      expect(vocabSvc.searchEntries).toHaveBeenCalledWith({ q: '영향' });
    });
    expect(grammarSvc.listPatterns).toHaveBeenCalledWith({ q: '영향' });
  });
});

describe('Reference — vocab row tap', () => {
  it('opens WordPopover and calls defineEntry with the row lemma', async () => {
    const user = userEvent.setup();
    render(<Reference />);

    const row = await screen.findByRole('button', { name: '영향 influence' });
    await user.click(row);

    await waitFor(() => {
      expect(defineSvc.defineEntry).toHaveBeenCalledWith('영향');
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Reference — MockBadge gating (E-SF-3)', () => {
  it('does NOT fire under the All filter when realFn-backed sources are real (hanja being mock-only is excluded)', async () => {
    // Vocab returns real data + grammar returns real data → both realFn-
    // backed states report `isMock: false`. Hanja is mock-only (no realFn
    // in Reference.tsx) so its hook always reports `isMock: true`, but
    // the new rule excludes mock-only sources from the AND. Pre-fix the
    // badge fired permanently here because `.some(s => s.isMock)` keyed
    // off hanja's permanent true.
    render(<Reference />);

    // Wait for the realFn-backed rows to land. Until then `isMock` may
    // legitimately read true on the loading state.
    await screen.findByText('영향');
    await screen.findByText('-는 반면에');

    // Under 'all' the badge must be absent.
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });

  it('DOES fire when both realFn-backed sources fall back to mock', async () => {
    // Vocab + grammar fail → both hooks fall back to the fixture mock
    // loader. AND across realFn-backed sources is now true, so the
    // badge fires (matching the cross-screen rule documented in
    // MockBadge.tsx JSDoc).
    vocabSvc.searchEntries.mockReset();
    vocabSvc.searchEntries.mockRejectedValue(new Error('boom'));
    grammarSvc.listPatterns.mockReset();
    grammarSvc.listPatterns.mockRejectedValue(new Error('boom'));

    render(<Reference />);

    // The mock fixture has '영향' as a vocab row, which will surface
    // when the hook falls back to mock data.
    await screen.findByText('영향');

    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();
  });
});

describe('Reference — error state', () => {
  it('shows ErrorCard with Retry when every active source AND the mock fail', async () => {
    // Both real services reject AND the mock loader rejects. Under the
    // Vocab filter only one active source applies, so the page must
    // surface the ErrorCard.
    vocabSvc.searchEntries.mockReset();
    vocabSvc.searchEntries.mockRejectedValue(new Error('boom'));
    refMock.loadReferenceMock.mockReset();
    refMock.loadReferenceMock.mockRejectedValue(new Error('mock boom'));

    const user = userEvent.setup();
    render(<Reference />);

    await user.click(screen.getByRole('button', { name: 'Vocab' }));

    expect(
      await screen.findByText(/The lookup couldn't be loaded/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Retry$/i }),
    ).toBeInTheDocument();
  });
});
