/**
 * DancheongRail — purely decorative (`aria-hidden`), and its `tone`/`feat`
 * props resolve to the expected classes.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DancheongRail } from './DancheongRail';

describe('DancheongRail', () => {
  it('is aria-hidden (decorative, carries no information of its own)', () => {
    const { container } = render(<DancheongRail />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('defaults tone to accent', () => {
    const { container } = render(<DancheongRail />);
    expect(container.firstElementChild?.className).toContain('km-tone--accent');
  });

  it('resolves an explicit tone to its km-tone--* class', () => {
    const { container } = render(<DancheongRail tone="blue" />);
    expect(container.firstElementChild?.className).toContain('km-tone--blue');
  });

  it('applies km-dancheong-rail--feat when feat is set', () => {
    const { container } = render(<DancheongRail feat />);
    expect(container.firstElementChild?.className).toContain(
      'km-dancheong-rail--feat',
    );
  });

  it('omits the feat class by default', () => {
    const { container } = render(<DancheongRail />);
    expect(container.firstElementChild?.className).not.toContain(
      'km-dancheong-rail--feat',
    );
  });

  it('forwards className onto the root element', () => {
    const { container } = render(<DancheongRail className="my-extra" />);
    expect(container.firstElementChild?.className).toContain('my-extra');
  });
});
