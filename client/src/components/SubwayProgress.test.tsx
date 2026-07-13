/**
 * SubwayProgress — clamping of `steps`/`current` (including NaN/Infinity
 * guards), the derived `fillPct` math, per-station done/current/ahead
 * state, and the single-progressbar ARIA contract (generated vs.
 * caller-supplied `aria-valuetext`, decorative dots `aria-hidden`).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubwayProgress } from './SubwayProgress';

function stations(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.km-subway__station'));
}

function fill(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.km-subway__fill');
  if (!(el instanceof HTMLElement)) {
    throw new Error('expected a .km-subway__fill element');
  }
  return el;
}

describe('SubwayProgress', () => {
  it('renders one role="progressbar" with the correct aria-value* triple', () => {
    render(<SubwayProgress steps={5} current={2} label="Daily progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Daily progress' });
    expect(bar).toHaveAttribute('aria-valuemin', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '5');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
  });

  it('falls back to a generated "Step N of M" aria-valuetext when none is supplied', () => {
    render(<SubwayProgress steps={5} current={2} label="Daily progress" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Step 3 of 5',
    );
  });

  it('uses the caller-supplied aria-valuetext when given', () => {
    render(
      <SubwayProgress
        steps={8}
        current={2}
        label="Daily progress"
        valueText="Station 3 of 8"
      />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Station 3 of 8',
    );
  });

  it('renders the station dots as decorative (aria-hidden), one per step', () => {
    const { container } = render(
      <SubwayProgress steps={4} current={1} label="Daily progress" />,
    );
    const track = container.querySelector('.km-subway__track');
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(stations(container)).toHaveLength(4);
  });

  it('derives done/current/ahead station state relative to `current`', () => {
    const { container } = render(
      <SubwayProgress steps={5} current={2} label="Daily progress" />,
    );
    const dots = stations(container);
    expect(dots.map((d) => d.className)).toEqual([
      expect.stringContaining('km-subway__station--done'),
      expect.stringContaining('km-subway__station--done'),
      expect.stringContaining('km-subway__station--current'),
      expect.stringContaining('km-subway__station--ahead'),
      expect.stringContaining('km-subway__station--ahead'),
    ]);
  });

  it('clamps `current` below 0 to the first station', () => {
    render(<SubwayProgress steps={5} current={-3} label="Daily progress" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
  });

  it('clamps `current` above steps-1 to the last station', () => {
    render(<SubwayProgress steps={5} current={99} label="Daily progress" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
  });

  it('floors non-integer `steps`/`current`', () => {
    render(<SubwayProgress steps={5.9} current={2.9} label="Daily progress" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '5');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
  });

  it('treats `steps` < 1 as a single station (fillPct 100%, no crash)', () => {
    const { container } = render(
      <SubwayProgress steps={0} current={0} label="Daily progress" />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '1');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(fill(container).style.width).toBe('100%');
    expect(stations(container)).toHaveLength(1);
  });

  it('computes fillPct as a fraction of the total station count', () => {
    const { container } = render(
      <SubwayProgress steps={5} current={2} label="Daily progress" />,
    );
    // active = 2, total = 5 -> 2 / (5 - 1) * 100 = 50%.
    expect(fill(container).style.width).toBe('50%');
  });

  it('SF-C: never renders a NaN aria-valuenow for a NaN/Infinity `current`', () => {
    render(<SubwayProgress steps={5} current={0 / 0} label="Daily progress" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).not.toBe('NaN');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
  });

  it('SF-C: never renders a NaN aria-valuemax for a NaN/Infinity `steps`', () => {
    render(<SubwayProgress steps={Infinity} current={0} label="Daily progress" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).not.toBe('NaN');
    expect(bar.getAttribute('aria-valuemax')).not.toBe('Infinity');
  });

  it('resolves the tone prop to a km-tone--* class (default "accent")', () => {
    const { container } = render(
      <SubwayProgress steps={3} current={1} label="Daily progress" />,
    );
    expect(container.firstElementChild?.className).toContain('km-tone--accent');
  });

  it('resolves an explicit tone prop to its km-tone--* class', () => {
    const { container } = render(
      <SubwayProgress steps={3} current={1} label="Daily progress" tone="mint" />,
    );
    expect(container.firstElementChild?.className).toContain('km-tone--mint');
  });

  it('forwards className onto the root element', () => {
    const { container } = render(
      <SubwayProgress
        steps={3}
        current={1}
        label="Daily progress"
        className="my-extra"
      />,
    );
    expect(container.firstElementChild?.className).toContain('my-extra');
  });
});
