/**
 * SealStamp — proves the pre-existing `char`/`size`-only call sites
 * (Login/Diagnostic/Hanja/Images/Review) still render a bare aria-hidden
 * badge with no `km-seal-group` wrapper (backward-compat, see
 * REVIEW_components.md's SealStamp table), then covers the new
 * `milestone`/`label`/`tone` paths and the SF-B className fix.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SealStamp } from './SealStamp';

describe('SealStamp — backward compat (pre-existing char/size-only callers)', () => {
  it('renders a bare aria-hidden badge with the glyph, no km-seal-group wrapper', () => {
    const { container } = render(<SealStamp char="韓" size="lg" />);
    expect(container.querySelector('.km-seal-group')).not.toBeInTheDocument();

    const badge = container.firstElementChild;
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveTextContent('韓');
    expect(badge?.className).toContain('km-seal');
    expect(badge?.className).toContain('km-seal--lg');
    expect(badge?.className).not.toContain('km-seal--milestone');
  });

  it('defaults to the accent tone and the 韓 glyph when no char is given', () => {
    const { container } = render(<SealStamp size="sm" />);
    const badge = container.firstElementChild;
    expect(badge?.className).toContain('km-tone--accent');
    expect(badge).toHaveTextContent('韓');
  });
});

describe('SealStamp — milestone variant (device #7)', () => {
  it('applies the km-seal--milestone class', () => {
    const { container } = render(<SealStamp milestone />);
    expect(container.firstElementChild?.className).toContain(
      'km-seal--milestone',
    );
  });

  it('defaults the glyph to 印 when milestone is set and no char is given', () => {
    render(<SealStamp milestone />);
    expect(screen.getByText('印')).toBeInTheDocument();
  });

  it('still honors an explicit char over the milestone default', () => {
    render(<SealStamp milestone char="完" />);
    expect(screen.getByText('完')).toBeInTheDocument();
    expect(screen.queryByText('印')).not.toBeInTheDocument();
  });
});

describe('SealStamp — label', () => {
  it('renders the label in a sibling span OUTSIDE the aria-hidden glyph', () => {
    const { container } = render(
      <SealStamp milestone label="Mastered" />,
    );
    const group = container.querySelector('.km-seal-group');
    expect(group).toBeInTheDocument();

    const label = screen.getByText('Mastered');
    expect(label).not.toHaveAttribute('aria-hidden');
    expect(label.closest('[aria-hidden="true"]')).toBeNull();

    // The glyph itself is still aria-hidden, as a sibling of the label.
    const glyph = group?.querySelector('.km-seal');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders no wrapper when label is omitted', () => {
    const { container } = render(<SealStamp char="韓" />);
    expect(container.querySelector('.km-seal-group')).not.toBeInTheDocument();
  });
});

describe('SealStamp — tone', () => {
  it('resolves an explicit tone to its km-tone--* class', () => {
    const { container } = render(<SealStamp milestone tone="blue" />);
    expect(container.firstElementChild?.className).toContain('km-tone--blue');
  });
});

describe('SealStamp — SF-B: className reaches the badge even when label is set', () => {
  it('applies className to the badge, not just the wrapper, when both label and className are passed', () => {
    const { container } = render(
      <SealStamp milestone label="Mastered" className="my-extra" />,
    );
    const glyph = container.querySelector('.km-seal');
    expect(glyph?.className).toContain('my-extra');
  });

  it('still applies className to the bare badge when label is omitted', () => {
    const { container } = render(
      <SealStamp char="韓" className="my-extra" />,
    );
    expect(container.firstElementChild?.className).toContain('my-extra');
  });
});
