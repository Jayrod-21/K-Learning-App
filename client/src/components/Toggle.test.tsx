/**
 * Toggle — switch-role + click + keyboard + disabled.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
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

describe('Toggle — touch-target floor (Settings S-1 fix-pass, REVIEW_batch4-cst.md)', () => {
  // jsdom does no layout, so the expanded hit-region can't be measured by
  // rendering — pin the CSS source instead (same technique as
  // ChatFab.test.tsx's stylesheet-contract test). The visible 38x22 pill
  // must NOT grow (that would be a real design regression); only the
  // invisible ::before hit-region should reach the 44px WCAG 2.5.8 floor.
  it('keeps the 38x22 visual pill but declares a 44x44 ::before hit-region', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'styles', 'index.css'),
      'utf8',
    );
    const trackRule = /\.km-toggle\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(trackRule).toContain('width: 38px;');
    expect(trackRule).toContain('height: 22px;');

    const hitRegionRule = /\.km-toggle::before\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(hitRegionRule).not.toBe('');
    expect(hitRegionRule).toContain('width: 44px;');
    expect(hitRegionRule).toContain('height: 44px;');
  });
});
