/**
 * ShowMore — verifies the expand-button contract (F-031/F-051/F-072):
 *   - renders a "Show more" button with the remaining count in the label,
 *   - clicking fires onShowMore,
 *   - renders no button when canShowMore is false, replaced by a visible
 *     stand-in caption (not a disabled button) — see the focus-handoff
 *     tests below,
 *   - custom label + zero/absent remaining render the bare label,
 *   - the final reveal hands keyboard focus to the stand-in node instead of
 *     dropping it to `<body>` (WCAG 2.4.3), and that stand-in is a VISIBLE
 *     node, not the old `.km-sr-only` clipped-off-canvas one (F-121, WCAG
 *     2.4.7 visible focus).
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShowMore } from './ShowMore';

describe('ShowMore', () => {
  it('renders the label with the remaining count', () => {
    render(
      <ShowMore canShowMore onShowMore={() => undefined} remaining={12} />,
    );
    expect(
      screen.getByRole('button', { name: 'Show more (12)' }),
    ).toBeInTheDocument();
  });

  it('renders the bare label without a remaining count', () => {
    render(<ShowMore canShowMore onShowMore={() => undefined} />);
    expect(
      screen.getByRole('button', { name: 'Show more' }),
    ).toBeInTheDocument();
  });

  it('honours a custom label', () => {
    render(
      <ShowMore
        canShowMore
        onShowMore={() => undefined}
        label="더 보기"
        remaining={3}
      />,
    );
    expect(
      screen.getByRole('button', { name: '더 보기 (3)' }),
    ).toBeInTheDocument();
  });

  it('fires onShowMore on click', async () => {
    const user = userEvent.setup();
    const onShowMore = vi.fn();
    render(<ShowMore canShowMore onShowMore={onShowMore} remaining={5} />);
    await user.click(screen.getByRole('button', { name: 'Show more (5)' }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('renders no button when canShowMore is false, but a visible stand-in caption', () => {
    render(<ShowMore canShowMore={false} onShowMore={() => undefined} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // F-121 — a real, VISIBLE (not `.km-sr-only`-clipped) non-tab-stop
    // stand-in remains in the button's place: it exists as a focus target
    // for the transition tested below, and unlike the pre-F-121 version, a
    // sighted keyboard user who lands here can actually see it.
    const standIn = document.querySelector('.km-showmore__done');
    expect(standIn).not.toBeNull();
    expect(standIn).toHaveAttribute('tabindex', '-1');
    expect(standIn).not.toHaveClass('km-sr-only');
    expect(standIn).toHaveTextContent('All items shown');
  });

  it('hands focus to the stand-in node when the final reveal removes the focused button (WCAG 2.4.3)', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [canShowMore, setCanShowMore] = useState(true);
      return (
        <ShowMore
          canShowMore={canShowMore}
          onShowMore={() => {
            setCanShowMore(false);
          }}
          remaining={5}
        />
      );
    }
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Show more (5)' });
    await user.click(button);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Regression guard: without the handoff, the removed button's focus
    // falls through to <body> and this assertion fails.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveClass('km-showmore__done');
  });

  it('the final-reveal focus target is visible, not the old off-screen sr-only stand-in (F-121, WCAG 2.4.7)', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [canShowMore, setCanShowMore] = useState(true);
      return (
        <ShowMore
          canShowMore={canShowMore}
          onShowMore={() => {
            setCanShowMore(false);
          }}
          remaining={5}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Show more (5)' }));

    const focused = document.activeElement;
    // Regression guard for the F-121 fix itself: the focused node must NOT
    // carry the visually-hidden clip utility class — that was precisely the
    // defect (a real focus target that no sighted user could see).
    expect(focused).not.toHaveClass('km-sr-only');
    expect(focused).toHaveClass('km-showmore__done');
    expect(focused?.tagName).toBe('P');
  });

  it('does not steal focus when the list starts already exhausted', () => {
    render(<ShowMore canShowMore={false} onShowMore={() => undefined} />);
    // Nothing was ever focused on this control, so the handoff effect must
    // not yank focus onto the hidden stand-in on first mount.
    expect(document.activeElement).toBe(document.body);
  });
});
