/**
 * WordPopover — vocab vs grammar branch, Esc + backdrop close, Add
 * locks to "Added", drawer toggles.
 *
 * F-186 (migrated onto the shared `Sheet`): the dialog chrome (backdrop,
 * focus trap, Esc, restore-focus, body-scroll lock) is no longer
 * WordPopover's own — it's rendered by `Sheet`. These tests assert that
 * migration didn't change any OBSERVABLE behavior (content, Esc, backdrop
 * dismissal, focus landing on close, scroll-lock lifecycle) even though
 * the DOM is now `Sheet`'s, and that WordPopover no longer double-wires
 * its own copy of the same a11y plumbing alongside Sheet's.
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

  it('closes on Escape exactly once (F-186 — proves no duplicate a11y wiring: WordPopover no longer runs its own useModalA11y alongside Sheet\'s, or Escape would fire onClose twice)', async () => {
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
    // The backdrop is now Sheet's own ("Close sheet") rather than a
    // bespoke WordPopover backdrop — distinct accessible name from the
    // close button so AT can tell them apart. Both paths emit onClose.
    await user.click(screen.getByLabelText('Close sheet'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders its dialog on the shared Sheet, tone="accent" (F-186)', () => {
    const { container } = render(
      <WordPopover data={VOCAB} onClose={() => undefined} />,
    );
    // Sheet's own chrome classes — proves the migration actually happened,
    // not just that *a* dialog exists.
    expect(container.querySelector('.km-sheet')).toBeInTheDocument();
    expect(container.querySelector('.km-sheet__backdrop')).toBeInTheDocument();
    const panel = container.querySelector('.km-sheet__panel');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveClass('km-tone--accent');
    // The bespoke pre-migration wrapper classes are gone.
    expect(container.querySelector('.km-popover__backdrop')).not.toBeInTheDocument();
    // Sheet is the role="dialog" host; WordPopover no longer renders its
    // own separate dialog wrapper.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBe(panel);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', VOCAB.kr);
  });

  it('lands initial focus on the close button on mount (F-186 — Sheet auto-focuses the first focusable descendant, and the close button is deliberately first in DOM order)', () => {
    render(<WordPopover data={VOCAB} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('locks body scroll while open and restores the pre-existing value on close, exactly once (F-186 — no double scroll-lock from WordPopover + Sheet each running useModalA11y)', () => {
    document.body.style.overflow = 'scroll';
    const { unmount } = render(
      <WordPopover data={VOCAB} onClose={() => undefined} />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    // Restored to the true pre-lock baseline ('scroll'), not '' — if
    // WordPopover still ran its own useModalA11y as well as Sheet's, the
    // ref-counted lock's baseline capture/consume pairing would still net
    // out here (both acquire/release on the same mount/unmount edge), so
    // this test is paired with the Escape-fires-once test above to pin
    // down single-wiring from two independent angles.
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
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

  it('hides the "More examples" affordance when there are no extras or usage notes (B-002)', () => {
    const bare: WordPopoverData = {
      kr: '먹다',
      pos: 'v.',
      en: 'to eat',
      ex_kr: '밥을 먹다',
      ex_en: 'to eat a meal',
    };
    render(<WordPopover data={bare} onClose={() => undefined} />);
    // No drawer content → no info toggle. An empty "More examples" panel is
    // worse than none.
    expect(
      screen.queryByRole('button', { name: 'More examples' }),
    ).not.toBeInTheDocument();
    // The primary body still renders in full.
    expect(screen.getByText('to eat')).toBeInTheDocument();
    expect(screen.getByText('밥을 먹다')).toBeInTheDocument();
  });

  it('shows the drawer with only usage notes (no extra examples) without an empty examples heading', async () => {
    const user = userEvent.setup();
    const usageOnly: WordPopoverData = {
      kr: '먹다',
      pos: 'v.',
      en: 'to eat',
      ex_kr: '밥을 먹다',
      ex_en: 'to eat a meal',
      notes: 'Everyday register; 드시다 is the honorific.',
    };
    render(<WordPopover data={usageOnly} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'More examples' }));
    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(
      screen.getByText('Everyday register; 드시다 is the honorific.'),
    ).toBeInTheDocument();
    // No extras → the "More examples" heading is suppressed inside the drawer.
    expect(screen.queryByText('More examples')).not.toBeInTheDocument();
  });

  it('renders the full KRDICT body with a subtle inline affordance while enriching — never the blocking spinner (F-209)', () => {
    render(
      <WordPopover data={VOCAB} onClose={() => undefined} isEnriching />,
    );
    // The body is fully painted and usable.
    expect(screen.getByText('remote work')).toBeInTheDocument();
    expect(screen.getByText('저는 재택근무를 합니다.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add to vocab/i }),
    ).toBeInTheDocument();
    // The subtle affordance is present; the full-screen blocker is not.
    expect(screen.getByTestId('word-popover-enriching')).toBeInTheDocument();
    expect(screen.getByText('adding nuance…')).toBeInTheDocument();
    expect(
      screen.queryByTestId('word-popover-loading'),
    ).not.toBeInTheDocument();
  });

  it('drops the enriching affordance once enrichment has landed (F-209)', () => {
    const { rerender } = render(
      <WordPopover data={VOCAB} onClose={() => undefined} isEnriching />,
    );
    expect(screen.getByTestId('word-popover-enriching')).toBeInTheDocument();
    rerender(
      <WordPopover data={VOCAB} onClose={() => undefined} isEnriching={false} />,
    );
    expect(
      screen.queryByTestId('word-popover-enriching'),
    ).not.toBeInTheDocument();
  });

  it('echoes enrichment-pending inside the open drawer, and the echo clears when loaded (F-209)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WordPopover data={VOCAB} onClose={() => undefined} isEnriching />,
    );
    await user.click(screen.getByRole('button', { name: 'More examples' }));
    expect(
      screen.getByTestId('word-popover-drawer-enriching'),
    ).toBeInTheDocument();
    rerender(
      <WordPopover data={VOCAB} onClose={() => undefined} isEnriching={false} />,
    );
    expect(
      screen.queryByTestId('word-popover-drawer-enriching'),
    ).not.toBeInTheDocument();
    // The drawer content itself remains.
    expect(screen.getByText('재택근무 중')).toBeInTheDocument();
  });

  it('suppresses the enriching affordance while the base body is still loading (F-209)', () => {
    render(
      <WordPopover
        data={{ kr: '먹다', en: '', ex_kr: '', ex_en: '' }}
        onClose={() => undefined}
        isLoading
        isEnriching
      />,
    );
    // The blocking state wins pre-define; no double affordance.
    expect(screen.getByTestId('word-popover-loading')).toBeInTheDocument();
    expect(
      screen.queryByTestId('word-popover-enriching'),
    ).not.toBeInTheDocument();
  });

  it('omits the Example section entirely when the entry has no example', () => {
    // ~4% of KRDICT entries (plus any enrichment miss) have no example. A bare
    // "Example" heading with nothing under it reads as broken — suppress it.
    const noExample: WordPopoverData = {
      kr: '먹다',
      pos: 'v.',
      en: 'to eat',
      ex_kr: '',
      ex_en: '',
    };
    render(<WordPopover data={noExample} onClose={() => undefined} />);
    expect(screen.queryByText('Example')).not.toBeInTheDocument();
    // The gloss still renders in full.
    expect(screen.getByText('to eat')).toBeInTheDocument();
  });
});
