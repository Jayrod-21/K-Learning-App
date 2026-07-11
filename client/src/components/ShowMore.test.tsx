/**
 * ShowMore — verifies the expand-button contract (F-031/F-051/F-072):
 *   - renders a "Show more" button with the remaining count in the label,
 *   - clicking fires onShowMore,
 *   - renders no VISIBLE control when canShowMore is false (hidden, not
 *     disabled) — but see the focus-handoff test below,
 *   - custom label + zero/absent remaining render the bare label,
 *   - the final reveal hands keyboard focus to a stand-in node instead of
 *     dropping it to `<body>` (WCAG 2.4.3).
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

  it('renders no visible control when canShowMore is false', () => {
    render(<ShowMore canShowMore={false} onShowMore={() => undefined} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // A visually-hidden, non-tab-stop stand-in remains in the button's
    // place — it exists solely as a focus target for the transition
    // tested below, not as visible UI.
    const standIn = document.querySelector('.km-sr-only');
    expect(standIn).not.toBeNull();
    expect(standIn).toHaveAttribute('tabindex', '-1');
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
    expect(document.activeElement).toHaveClass('km-sr-only');
  });

  it('does not steal focus when the list starts already exhausted', () => {
    render(<ShowMore canShowMore={false} onShowMore={() => undefined} />);
    // Nothing was ever focused on this control, so the handoff effect must
    // not yank focus onto the hidden stand-in on first mount.
    expect(document.activeElement).toBe(document.body);
  });
});
