/**
 * KoreanPassage — token-walk + gram-span batching + EN toggle + malformed
 * fixture tolerance + tapword → onOpenWord callback contract.
 *
 * The component is the heart of the Reading screen; every gesture has to
 * survive a fixture that the Pass-3 server might mis-shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KoreanPassage } from './KoreanPassage';
import type {
  PassageGloss,
  ReadingPassage,
} from '../types/domain';

const GLOSS: PassageGloss = {
  kr: '재택근무',
  pos: 'n.',
  en: 'remote work',
  ex_kr: '재택근무가 늘었다.',
  ex_en: 'Remote work has increased.',
};

const SIMPLE_PASSAGE: ReadingPassage = {
  title: '재택근무',
  level: 'L4',
  meta: '4 min',
  sentences: [
    {
      en: 'I do remote work.',
      tokens: [
        { w: '저는 ' },
        { w: '재택근무', gloss: GLOSS },
        { w: '를 해요.' },
      ],
    },
    {
      en: 'It is convenient but lonely.',
      tokens: [
        { w: '편리', span: 'g4-start' },
        { w: '하지만 외롭', span: 'g4-end' },
        { w: '습니다.' },
      ],
    },
  ],
};

/** Fixture with an unterminated grammar span — the defensive flushSpan
 *  must still render every token. */
const MALFORMED_PASSAGE: ReadingPassage = {
  title: '깨진 단락',
  level: 'L3',
  meta: '1 min',
  sentences: [
    {
      en: 'broken span',
      tokens: [
        { w: '첫번째', span: 'g7-start' },
        // No matching `-end` token — the run must still render.
        { w: '두번째' },
        { w: '세번째' },
      ],
    },
  ],
};

const EMPTY_MINED: ReadonlySet<string> = new Set<string>();

describe('KoreanPassage', () => {
  it('renders every visible token, including grammar runs', () => {
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={vi.fn()}
        minedIds={EMPTY_MINED}
      />,
    );
    // Plain text fragments — each token is its own <span>, so we use
    // regex matchers that don't care about whitespace folding.
    expect(screen.getByText(/저는/)).toBeInTheDocument();
    expect(screen.getByText(/를 해요/)).toBeInTheDocument();
    // Tapword for `재택근무`
    expect(screen.getByRole('button', { name: '재택근무' })).toBeInTheDocument();
    // Grammar span batches `편리` + `하지만 외롭` into one role=button
    const grammarSpans = screen.getAllByRole('button', {
      name: /grammar pattern g4/i,
    });
    expect(grammarSpans).toHaveLength(1);
    expect(grammarSpans[0]).toHaveTextContent('편리');
    expect(grammarSpans[0]).toHaveTextContent('하지만 외롭');
  });

  it('fires onOpenWord with the gloss when a tapword is tapped', async () => {
    const user = userEvent.setup();
    const onOpenWord = vi.fn();
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={onOpenWord}
        onOpenGrammar={vi.fn()}
        minedIds={EMPTY_MINED}
      />,
    );
    await user.click(screen.getByRole('button', { name: '재택근무' }));
    expect(onOpenWord).toHaveBeenCalledTimes(1);
    expect(onOpenWord).toHaveBeenCalledWith(GLOSS);
  });

  it('fires onOpenGrammar with the gid when the gram-span is tapped', async () => {
    const user = userEvent.setup();
    const onOpenGrammar = vi.fn();
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={onOpenGrammar}
        minedIds={EMPTY_MINED}
      />,
    );
    const span = screen.getByRole('button', { name: /grammar pattern g4/i });
    await user.click(span);
    expect(onOpenGrammar).toHaveBeenCalledWith('g4');
  });

  it('gram-span is keyboard-activatable (Enter and Space)', async () => {
    const user = userEvent.setup();
    const onOpenGrammar = vi.fn();
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={onOpenGrammar}
        minedIds={EMPTY_MINED}
      />,
    );
    const span = screen.getByRole('button', { name: /grammar pattern g4/i });
    span.focus();
    await user.keyboard('{Enter}');
    expect(onOpenGrammar).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onOpenGrammar).toHaveBeenCalledTimes(2);
  });

  it('hides EN translation by default; EN button reveals + collapses it', async () => {
    const user = userEvent.setup();
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={vi.fn()}
        minedIds={EMPTY_MINED}
      />,
    );
    expect(screen.queryByText('I do remote work.')).not.toBeInTheDocument();
    const enButtons = screen.getAllByRole('button', { name: 'EN' });
    // One EN button per sentence.
    expect(enButtons).toHaveLength(2);
    await user.click(enButtons[0]);
    expect(screen.getByText('I do remote work.')).toBeInTheDocument();
    // aria-expanded reflects state.
    expect(enButtons[0]).toHaveAttribute('aria-expanded', 'true');
    await user.click(enButtons[0]);
    expect(screen.queryByText('I do remote work.')).not.toBeInTheDocument();
  });

  it('pre-reveals every sentence when showTranslation is true', () => {
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={vi.fn()}
        minedIds={EMPTY_MINED}
        showTranslation
      />,
    );
    expect(screen.getByText('I do remote work.')).toBeInTheDocument();
    expect(
      screen.getByText('It is convenient but lonely.'),
    ).toBeInTheDocument();
  });

  it('paints mined tapwords with the .km-tapword--mined modifier', () => {
    render(
      <KoreanPassage
        passage={SIMPLE_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={vi.fn()}
        minedIds={new Set([GLOSS.kr])}
      />,
    );
    expect(
      screen.getByRole('button', { name: '재택근무' }),
    ).toHaveClass('km-tapword--mined');
  });

  it('renders every token in a malformed (unterminated) gram-span', () => {
    const { container } = render(
      <KoreanPassage
        passage={MALFORMED_PASSAGE}
        onOpenWord={vi.fn()}
        onOpenGrammar={vi.fn()}
        minedIds={EMPTY_MINED}
      />,
    );
    // Defensive flushSpan must batch every token in the broken run into
    // one .gram-span so none of the text disappears.
    const span = container.querySelector('.gram-span');
    expect(span).toBeTruthy();
    expect(span?.textContent).toContain('첫번째');
    expect(span?.textContent).toContain('두번째');
    expect(span?.textContent).toContain('세번째');
    // And the EN button is still present so the sentence is recoverable.
    expect(
      within(container as HTMLElement).getByRole('button', { name: 'EN' }),
    ).toBeInTheDocument();
  });
});
