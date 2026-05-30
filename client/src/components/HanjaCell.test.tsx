/**
 * HanjaCell — verifies the state-coded top border class + click handler
 * fire correctly, plus keyboard activation comes free with native button.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HanjaCell } from './HanjaCell';

describe('HanjaCell', () => {
  it.each([
    ['new', 'km-hanjacell--new'],
    ['practicing', 'km-hanjacell--practicing'],
    ['banked', 'km-hanjacell--banked'],
  ] as const)('paints the %s state border', (state, cls) => {
    render(<HanjaCell char="韓" sound="한" state={state} />);
    expect(screen.getByRole('button').className).toContain(cls);
  });

  it('exposes the state via data attribute for prototype-style selectors', () => {
    render(<HanjaCell char="學" sound="학" state="practicing" />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'data-state',
      'practicing',
    );
  });

  it('fires onClick when the tile is pressed', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <HanjaCell char="生" sound="생" state="new" onClick={onClick} />,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Enter via the native button keyboard handling', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <HanjaCell char="生" sound="생" state="new" onClick={onClick} />,
    );
    screen.getByRole('button').focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('includes the gloss in the accessible name when provided', () => {
    render(
      <HanjaCell char="韓" gloss="나라" sound="한" state="banked" />,
    );
    expect(
      screen.getByRole('button', { name: /韓 나라 한/ }),
    ).toBeInTheDocument();
  });
});
