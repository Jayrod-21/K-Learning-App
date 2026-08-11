/**
 * ClozeCard (F-208) — the typed cloze face of a review card.
 *
 * Coverage:
 *   - Presentation: the blanked sentence renders (with the blank styled as a
 *     visible slot) + the English translation — and the answer is NOWHERE in
 *     the DOM (the component never even receives it; only the grade route's
 *     committing responses carry it).
 *   - Correct on attempt 1 → ✓ reveal (answerSurface + fullSentence) and
 *     Continue hands the committed result to the parent.
 *   - Wrong on attempt 1 → the server's partial hint renders (first char +
 *     length−1 boxes + letter count), the answer stays hidden, the typed text
 *     survives for the retry, and the next submit goes out as attempt 2.
 *   - Wrong on attempt 2 → reveal (rating 'again') + Continue advances.
 *   - Give-up ("Show answer") → grades with `giveUp: true` and NO answer
 *     field, then reveals + advances.
 *   - 404 (no cloze prompt / card gone) → `onFallback` (re-present as a
 *     flashcard), never a crash.
 *   - 502 (Kiwi outage) → soft inline error, the attempt is retryable, and a
 *     bail-out to the flashcard face is offered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ClozeGradeCommittedResponse,
  ClozeGradeHintResponse,
  DueCardCloze,
} from '../types/domain';
import { ApiError } from '../services/api';

vi.mock('../services/vocab', () => ({ gradeCloze: vi.fn() }));

import { ClozeCard } from './ClozeCard';
import { gradeCloze } from '../services/vocab';

const CLOZE: DueCardCloze = {
  blanked: '그 정책은 경제에 큰 ______을 미쳤다.',
  english: 'That policy had a big effect on the economy.',
  blankStart: 11,
  blankEnd: 13,
};

const COMMITTED_GOOD: ClozeGradeCommittedResponse = {
  correct: true,
  answerSurface: '영향',
  fullSentence: '그 정책은 경제에 큰 영향을 미쳤다.',
  rating: 'good',
  version: 4,
  due_at: '2026-08-12T00:00:00Z',
  scheduled_days: 1,
};

const COMMITTED_AGAIN: ClozeGradeCommittedResponse = {
  ...COMMITTED_GOOD,
  correct: false,
  rating: 'again',
  scheduled_days: 0,
};

const HINT: ClozeGradeHintResponse = {
  correct: false,
  hint: { firstChar: '영', length: 2 },
};

function renderCard(overrides?: {
  onCommitted?: (r: ClozeGradeCommittedResponse) => void;
  onFallback?: () => void;
}): {
  onCommitted: ReturnType<typeof vi.fn>;
  onFallback: ReturnType<typeof vi.fn>;
} {
  const onCommitted = vi.fn();
  const onFallback = vi.fn();
  render(
    <ClozeCard
      cardId={101}
      expectedVersion={3}
      cloze={CLOZE}
      onCommitted={overrides?.onCommitted ?? onCommitted}
      onFallback={overrides?.onFallback ?? onFallback}
    />,
  );
  return { onCommitted, onFallback };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClozeCard — presentation (no answer leak)', () => {
  it('renders the blanked sentence with a visible blank slot + the translation', () => {
    renderCard();

    // The sentence renders around a styled blank span (split on the fixed
    // 6-underscore marker), never the answer.
    expect(screen.getByText(/그 정책은 경제에 큰/)).toBeInTheDocument();
    expect(document.querySelector('.km-cloze__blank')).not.toBeNull();
    expect(
      screen.getByText('That policy had a big effect on the economy.'),
    ).toBeInTheDocument();
    // The answer surface is nowhere in the DOM — the component never even
    // receives it before a committing grade response.
    expect(document.body.textContent).not.toContain('영향');
    // Interaction affordances: typed input + Submit + give-up.
    expect(
      screen.getByRole('textbox', { name: 'Your answer' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Show answer/ }),
    ).toBeInTheDocument();
  });

  it('disables Submit while the answer box is empty (the schema requires 1..200 chars)', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /Submit/ })).toBeDisabled();
  });
});

describe('ClozeCard — grading flow', () => {
  it('correct on attempt 1: grades once, reveals with ✓, and Continue hands the committed result up', async () => {
    vi.mocked(gradeCloze).mockResolvedValue(COMMITTED_GOOD);
    const user = userEvent.setup();
    const { onCommitted } = renderCard();

    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), '영향');
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    // Exactly the server contract: attempt 1, trimmed answer, version echo.
    expect(gradeCloze).toHaveBeenCalledExactlyOnceWith(101, {
      answer: '영향',
      expected_version: 3,
      attempt: 1,
    });
    // Reveal: verdict + answer surface + full sentence.
    expect(await screen.findByText(/Correct/)).toBeInTheDocument();
    expect(screen.getByText('영향')).toBeInTheDocument();
    expect(screen.getByText('그 정책은 경제에 큰 영향을 미쳤다.')).toBeInTheDocument();
    // The input phase is over — no resubmission affordance remains.
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(COMMITTED_GOOD);
  });

  it('wrong on attempt 1: shows the partial hint, does NOT reveal, and keeps the typed text for attempt 2', async () => {
    vi.mocked(gradeCloze).mockResolvedValue(HINT);
    const user = userEvent.setup();
    const { onCommitted } = renderCard();

    const input = screen.getByRole('textbox', { name: 'Your answer' });
    await user.type(input, '결과');
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    // Hint = first char + (length − 1) blank boxes, plus the letter count.
    expect(await screen.findByText('영 ▢')).toBeInTheDocument();
    expect(screen.getByText('2 letters')).toBeInTheDocument();
    // NON-committing: nothing revealed, nothing advanced.
    expect(document.body.textContent).not.toContain('영향');
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    expect(onCommitted).not.toHaveBeenCalled();
    // The typed text survives for editing against the hint.
    expect(input).toHaveValue('결과');

    // The next submit goes out as attempt 2.
    vi.mocked(gradeCloze).mockResolvedValue(COMMITTED_GOOD);
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    await waitFor(() => {
      expect(gradeCloze).toHaveBeenLastCalledWith(101, {
        answer: '결과',
        expected_version: 3,
        attempt: 2,
      });
    });
  });

  it('wrong on attempt 2: reveals the answer (rating again) and Continue advances', async () => {
    vi.mocked(gradeCloze)
      .mockResolvedValueOnce(HINT)
      .mockResolvedValueOnce(COMMITTED_AGAIN);
    const user = userEvent.setup();
    const { onCommitted } = renderCard();

    const input = screen.getByRole('textbox', { name: 'Your answer' });
    await user.type(input, '결과');
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    await screen.findByText('영 ▢');
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    expect(await screen.findByText(/Not quite/)).toBeInTheDocument();
    expect(screen.getByText('영향')).toBeInTheDocument();
    expect(screen.getByText('그 정책은 경제에 큰 영향을 미쳤다.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(COMMITTED_AGAIN);
  });

  it('give-up ("Show answer"): grades with giveUp and no answer field, then reveals + advances', async () => {
    vi.mocked(gradeCloze).mockResolvedValue(COMMITTED_AGAIN);
    const user = userEvent.setup();
    const { onCommitted } = renderCard();

    await user.click(screen.getByRole('button', { name: /Show answer/ }));

    // No `answer` key at all — the schema only allows its absence with giveUp.
    expect(gradeCloze).toHaveBeenCalledExactlyOnceWith(101, {
      giveUp: true,
      expected_version: 3,
      attempt: 1,
    });
    expect(await screen.findByText('영향')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(COMMITTED_AGAIN);
  });
});

describe('ClozeCard — errors', () => {
  it('404 (no cloze prompt) falls back to the flashcard presentation', async () => {
    vi.mocked(gradeCloze).mockRejectedValue(
      new ApiError('vocab card not found', { status: 404, code: 'not_found' }),
    );
    const user = userEvent.setup();
    const { onCommitted, onFallback } = renderCard();

    await user.click(screen.getByRole('button', { name: /Show answer/ }));

    await waitFor(() => {
      expect(onFallback).toHaveBeenCalledOnce();
    });
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('409 (stale version) falls back like existing review conflicts', async () => {
    vi.mocked(gradeCloze).mockRejectedValue(
      new ApiError('version conflict', { status: 409, code: 'conflict' }),
    );
    const user = userEvent.setup();
    const { onFallback } = renderCard();

    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), '영향');
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    await waitFor(() => {
      expect(onFallback).toHaveBeenCalledOnce();
    });
  });

  it('502 (Kiwi outage) shows a soft retryable error and offers the flashcard bail-out', async () => {
    vi.mocked(gradeCloze).mockRejectedValueOnce(
      new ApiError('lemmatizer unavailable', {
        status: 502,
        code: 'upstream_error',
      }),
    );
    const user = userEvent.setup();
    const { onCommitted, onFallback } = renderCard();

    const input = screen.getByRole('textbox', { name: 'Your answer' });
    await user.type(input, '영향');
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    // Soft error: fixed copy (never server prose), input + attempt retained.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('lemmatizer unavailable');
    expect(input).toHaveValue('영향');
    expect(onFallback).not.toHaveBeenCalled();

    // The bail-out is offered…
    expect(
      screen.getByRole('button', { name: /Use flashcard instead/ }),
    ).toBeInTheDocument();

    // …and a straight retry still works (same attempt — nothing committed).
    vi.mocked(gradeCloze).mockResolvedValue(COMMITTED_GOOD);
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    expect(await screen.findByText(/Correct/)).toBeInTheDocument();
    expect(gradeCloze).toHaveBeenLastCalledWith(101, {
      answer: '영향',
      expected_version: 3,
      attempt: 1,
    });
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(COMMITTED_GOOD);
  });
});
