/**
 * CityCard — conditional composition (`rail`, `heading`, `feat`), the
 * `tone` -> `km-tone--*` class resolution, and that arbitrary HTML
 * attributes spread through to the root element.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CityCard } from './CityCard';

describe('CityCard', () => {
  it('renders children with no rail/heading by default', () => {
    const { container } = render(<CityCard>Hello</CityCard>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(container.querySelector('.km-dancheong-rail')).not.toBeInTheDocument();
    expect(container.querySelector('.km-citycard__title')).not.toBeInTheDocument();
  });

  it('composes DancheongRail when rail is set', () => {
    const { container } = render(<CityCard rail>Hello</CityCard>);
    expect(container.querySelector('.km-dancheong-rail')).toBeInTheDocument();
  });

  it('renders the heading slot with the kr-display class', () => {
    const { container } = render(<CityCard heading="완료">Body</CityCard>);
    const title = container.querySelector('.km-citycard__title');
    expect(title).toHaveTextContent('완료');
    expect(title?.className).toContain('kr-display');
  });

  it('does not render a title node when heading is omitted', () => {
    const { container } = render(<CityCard>Body</CityCard>);
    expect(container.querySelector('.km-citycard__title')).not.toBeInTheDocument();
  });

  it('applies km-citycard--feat when feat is set', () => {
    const { container } = render(<CityCard feat>Body</CityCard>);
    expect(container.firstElementChild?.className).toContain('km-citycard--feat');
  });

  it('passes feat through to a composed DancheongRail', () => {
    const { container } = render(<CityCard rail feat>Body</CityCard>);
    expect(container.querySelector('.km-dancheong-rail--feat')).toBeInTheDocument();
  });

  it('defaults tone to accent and resolves an explicit tone to km-tone--*', () => {
    const { container: def } = render(<CityCard>Body</CityCard>);
    expect(def.firstElementChild?.className).toContain('km-tone--accent');

    const { container: mint } = render(<CityCard tone="mint">Body</CityCard>);
    expect(mint.firstElementChild?.className).toContain('km-tone--mint');
  });

  it('spreads ...rest HTML attributes onto the root element', () => {
    const { container } = render(
      <CityCard data-testid="hero-card" aria-label="Hero">
        Body
      </CityCard>,
    );
    const root = container.firstElementChild;
    expect(root).toHaveAttribute('data-testid', 'hero-card');
    expect(root).toHaveAttribute('aria-label', 'Hero');
  });

  it('merges a caller className with the base classes', () => {
    const { container } = render(<CityCard className="my-extra">Body</CityCard>);
    expect(container.firstElementChild?.className).toContain('my-extra');
    expect(container.firstElementChild?.className).toContain('km-citycard');
  });
});
