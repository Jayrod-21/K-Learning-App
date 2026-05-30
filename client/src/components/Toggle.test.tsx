/**
 * Toggle — switch-role + click + keyboard + disabled.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('exposes switch role with aria-checked', () => {
    render(
      <Toggle checked={false} onChange={() => undefined} ariaLabel="Email" />,
    );
    const el = screen.getByRole('switch', { name: 'Email' });
    expect(el).toHaveAttribute('aria-checked', 'false');
  });

  it('flips aria-checked when checked is true', () => {
    render(<Toggle checked onChange={() => undefined} ariaLabel="Email" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange with next state on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} ariaLabel="Email" />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles on Space and Enter (native button)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} ariaLabel="Email" />);
    const el = screen.getByRole('switch');
    el.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(false);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Toggle
        checked={false}
        onChange={onChange}
        ariaLabel="Email"
        disabled
      />,
    );
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
