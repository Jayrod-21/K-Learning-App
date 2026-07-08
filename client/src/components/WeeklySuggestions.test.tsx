/**
 * WeeklySuggestions — P3b bilingual-chrome coverage for the "This Week"
 * strip. The full behavioural surface (409-idempotent Add flips, GR-shaped
 * bank keys, allSettled degradation) is exercised through the page tests in
 * pages/review/ReviewVocab.test.tsx; here we pin the component's OWN chrome:
 *
 *   - the eyebrow / hint / column titles render through `<Bilingual/>` so
 *     the language-display setting applies (both-mode shows both languages,
 *     'en' mode hides the Korean visually while the sr reading keeps it);
 *   - the trimmed one-line hint (P3b verbage trim) replaced the old
 *     two-sentence copy;
 *   - the Add button chrome is bilingual-compact (Korean-first 'both'
 *     shows 추가; the accessible flow keeps the English states).
 *
 * Services are module-mocked; the component's fetch effect runs for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KgiuEntrySummary, VocabEntry } from '../types/domain';

const vocabSvc = vi.hoisted(() => ({
  bankEntry: vi.fn(),
}));
const grammarSvc = vi.hoisted(() => ({
  bankPattern: vi.fn(),
}));
const suggestSvc = vi.hoisted(() => ({
  fetchWeeklyVocabSuggestions: vi.fn(),
  fetchWeeklyGrammarSuggestions: vi.fn(),
}));

vi.mock('../services/vocab', () => vocabSvc);
vi.mock('../services/grammar', () => grammarSvc);
vi.mock('../services/suggestions', () => suggestSvc);

import { WeeklySuggestions } from './WeeklySuggestions';

const VOCAB: VocabEntry[] = [
  {
    id: 11,
    corpus: 'topik',
    korean: '결과',
    english: 'result',
    proficiency: '중급',
    theme: null,
  },
];

const GRAMMAR: KgiuEntrySummary[] = [
  {
    id: 9,
    corpus: 'kgiu',
    source_id: 'KGIU-INT-009',
    pattern: '-는 반면에',
    title_en: 'while / whereas',
    category: 'contrast',
    proficiency: '중급',
    unit: null,
    source_pages: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  suggestSvc.fetchWeeklyVocabSuggestions.mockResolvedValue(VOCAB);
  suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue(GRAMMAR);
  vocabSvc.bankEntry.mockResolvedValue(undefined);
  grammarSvc.bankPattern.mockResolvedValue(undefined);
});

describe('WeeklySuggestions — bilingual chrome (P3b)', () => {
  it('renders the eyebrow, hint, and column titles bilingually in default both-mode', async () => {
    render(<WeeklySuggestions />);

    // Eyebrow through <Bilingual/> — both segments present, no hand-composed
    // "이번 주 · This Week" string.
    expect(await screen.findByText('이번 주')).toBeInTheDocument();
    expect(screen.getByText('This Week')).toBeInTheDocument();

    // Trimmed one-line hint (P3b verbage trim), en + kr.
    expect(
      screen.getByText('New picks each week — nothing is added automatically.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('매주 새로운 추천 — 자동으로 추가되지 않아요.'),
    ).toBeInTheDocument();

    // Column titles.
    expect(screen.getByText('어휘')).toBeInTheDocument();
    expect(screen.getByText('Vocabulary')).toBeInTheDocument();
    expect(screen.getByText('문법')).toBeInTheDocument();
    expect(screen.getByText('Grammar')).toBeInTheDocument();
  });

  it('renders the Add button bilingually and flips to the bilingual Added state', async () => {
    const user = userEvent.setup();
    render(<WeeklySuggestions />);

    // The aria-label contract is unchanged ("Add 결과") — the visible label
    // is now bilingual-compact (Korean-first default shows 추가).
    const addBtn = await screen.findByRole('button', { name: 'Add 결과' });
    expect(addBtn.textContent).toContain('추가');
    expect(addBtn.querySelector('.km-sr-only')?.textContent).toContain('Add');

    await user.click(addBtn);
    expect(vocabSvc.bankEntry).toHaveBeenCalledWith(11);
    // Flip is bilingual too: ✓ 추가됨 visually (Korean-first), ✓ Added in
    // the sr reading (compact renders the Korean in BOTH the visible and
    // sr-only spans, hence the button-scoped assertions).
    expect(await screen.findByText('✓ Added')).toBeInTheDocument();
    const flipped = screen.getByRole('button', { name: '결과 added' });
    expect(flipped.textContent).toContain('✓ 추가됨');
    expect(flipped).toBeDisabled();
  });

  it('shows the bilingual loading state while picks are in flight', () => {
    // Never-resolving fetches → the strip stays in its loading state.
    suggestSvc.fetchWeeklyVocabSuggestions.mockReturnValue(
      new Promise(() => undefined),
    );
    suggestSvc.fetchWeeklyGrammarSuggestions.mockReturnValue(
      new Promise(() => undefined),
    );
    render(<WeeklySuggestions />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('불러오는 중…');
    expect(status.textContent).toContain('Loading this week’s picks…');
  });
});
