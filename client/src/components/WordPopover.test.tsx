/**
 * WordPopover — vocab vs grammar branch, Esc + backdrop close, Add
 * locks to "Added", drawer toggles.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WordPopover, type WordPopoverData } from './WordPopover';

const VOCAB: WordPopoverData = {
  kr: '재택근무',
  pos: 'n.',
  en: 'remote work',
  ex_kr: '저는 재택근무를 합니다.',
  ex_en: 'I work remotely.',
  extra: [{ kr: '재택근무 중', en: 'while working from home' }],
  notes: 'Common in HR contexts.',
};

const GRAMMAR: WordPopoverData = {
  kind: 'grammar',
  kr: '-(으)면서',
  en: 'while doing X',
  title: '동시 동작 — simultaneous actions',
  desc: 'Links two verbs in the same agent at the same time.',
  ex_kr: '음악을 들으면서 공부해요.',
  ex_en: 'I study while listening to music.',
};

afterEach(() => {
  document.body.style.overflow = '';
});

describe('WordPopover', () => {
  it('renders vocab data with POS pill and gloss', () => {
    render(<WordPopover data={VOCAB} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('재택근무')).toBeInTheDocument();
    expect(screen.getByText('n.')).toBeInTheDocument();
    expect(screen.getByText('remote work')).toBeInTheDocument();
    expect(screen.getByText('저는 재택근무를 합니다.')).toBeInTheDocument();
  });

  it('renders grammar branch with pattern pill + title', () => {
    render(<WordPopover data={GRAMMAR} onClose={() => undefined} />);
    expect(screen.getByText('Grammar pattern')).toBeInTheDocument();
    expect(screen.getByText('-(으)면서')).toBeInTheDocument();
    expect(
      screen.getByText('동시 동작 — simultaneous actions'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add to grammar bank/i }),
    ).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WordPopover data={VOCAB} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click and on the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WordPopover data={VOCAB} onClose={onClose} />);
    // Backdrop and close button are deliberately distinct accessible names
    // so AT can tell them apart. Both paths emit onClose.
    await user.click(screen.getByLabelText('Close popover'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('locks Add button into "Added" state after one click', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <WordPopover data={VOCAB} onClose={() => undefined} onAdd={onAdd} />,
    );
    const add = screen.getByRole('button', { name: /add to vocab/i });
    await user.click(add);
    expect(onAdd).toHaveBeenCalledWith(VOCAB);
    expect(
      screen.getByRole('button', { name: /added to vocab/i }),
    ).toBeInTheDocument();
    // Clicking again is a no-op (idempotent).
    await user.click(screen.getByRole('button', { name: /added to vocab/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('toggles the "More examples" drawer', async () => {
    const user = userEvent.setup();
    render(<WordPopover data={VOCAB} onClose={() => undefined} />);
    expect(screen.queryByText('More examples')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More examples' }));
    expect(screen.getByText('More examples')).toBeInTheDocument();
    expect(screen.getByText('재택근무 중')).toBeInTheDocument();
    expect(screen.getByText('Common in HR contexts.')).toBeInTheDocument();
  });
});
