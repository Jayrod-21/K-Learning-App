/**
 * ShowMore — verifies the expand-button contract (F-031/F-051/F-072):
 *   - renders a "Show more" button with the remaining count in the label,
 *   - clicking fires onShowMore,
 *   - renders NOTHING when canShowMore is false (hidden, not disabled),
 *   - custom label + zero/absent remaining render the bare label.
 */
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

  it('renders nothing when canShowMore is false', () => {
    const { container } = render(
      <ShowMore canShowMore={false} onShowMore={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
