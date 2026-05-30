/**
 * Tapword — keyboard + click + a11y. The component is the cohesion
 * gesture for the whole app, so every input path must call `onTap`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tapword } from './Tapword';

describe('Tapword', () => {
  it('renders children and exposes a button role', () => {
    render(<Tapword onTap={() => undefined}>재택근무</Tapword>);
    const el = screen.getByRole('button', { name: '재택근무' });
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('tabindex', '0');
    expect(el).toHaveClass('km-tapword');
  });

  it('calls onTap on click', async () => {
    const user = userEvent.setup();
    const onTap = vi.fn();
    render(<Tapword onTap={onTap}>가다</Tapword>);
    await user.click(screen.getByRole('button', { name: '가다' }));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('calls onTap on Enter and Space', async () => {
    const user = userEvent.setup();
    const onTap = vi.fn();
    render(<Tapword onTap={onTap}>가다</Tapword>);
    const el = screen.getByRole('button', { name: '가다' });
    el.focus();
    await user.keyboard('{Enter}');
    expect(onTap).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it('applies mined and active modifier classes', () => {
    render(
      <Tapword onTap={() => undefined} mined active>
        영향
      </Tapword>,
    );
    const el = screen.getByRole('button', { name: '영향' });
    expect(el).toHaveClass('km-tapword--mined');
    expect(el).toHaveClass('km-tapword--active');
  });

  it('uses ariaLabel override when provided', () => {
    render(
      <Tapword onTap={() => undefined} ariaLabel="tap to open gloss">
        영향
      </Tapword>,
    );
    expect(
      screen.getByRole('button', { name: 'tap to open gloss' }),
    ).toBeInTheDocument();
  });
});
