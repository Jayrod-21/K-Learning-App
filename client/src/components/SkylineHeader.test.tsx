/**
 * SkylineHeader — the optional `title` renders as a real (non-hidden) DOM
 * node, the decorative SVG is `aria-hidden` + `focusable="false"`, and both
 * the Day and Night `<g>` layers are always present in the DOM (theme
 * switching is pure CSS, no FOUC) per REVIEW_components.md.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkylineHeader } from './SkylineHeader';

describe('SkylineHeader', () => {
  it('renders no title node when title is omitted', () => {
    const { container } = render(<SkylineHeader />);
    expect(container.querySelector('.km-skyline__title')).not.toBeInTheDocument();
  });

  it('renders the title as a real, non-hidden DOM node', () => {
    render(<SkylineHeader title="Today, 7/13" />);
    const title = screen.getByText('Today, 7/13');
    expect(title).toBeInTheDocument();
    expect(title).not.toHaveAttribute('aria-hidden');
    expect(title.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('marks the SVG as decorative: aria-hidden + focusable="false"', () => {
    const { container } = render(<SkylineHeader />);
    const svg = container.querySelector('svg.km-skyline__svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
  });

  it('renders BOTH the day and night <g> layers in the DOM unconditionally', () => {
    const { container } = render(<SkylineHeader />);
    expect(container.querySelector('g.km-skyline__day')).toBeInTheDocument();
    expect(container.querySelector('g.km-skyline__night')).toBeInTheDocument();
  });

  it('forwards className onto the root element', () => {
    const { container } = render(<SkylineHeader className="my-extra" />);
    expect(container.firstElementChild?.className).toContain('my-extra');
  });
});
