/**
 * PageHubHeader — the shared hub-header recipe (batch-2 fix-pass, BLOCKER-2).
 * Direct tests for the component's own contract: a real `<h1>`, the eyebrow,
 * the optional actions slot, and the optional glyph watermark.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHubHeader } from './PageHubHeader';

describe('PageHubHeader', () => {
  it('renders a real, non-decorative <h1> carrying the heading content', () => {
    render(
      <PageHubHeader
        titleId="test-title"
        eyebrow="Library"
        heading="Vocabulary"
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Vocabulary' });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveAttribute('id', 'test-title');
  });

  it('renders the eyebrow as visible text above the heading', () => {
    render(
      <PageHubHeader titleId="t" eyebrow="Library" heading="Vocabulary" />,
    );
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('renders the DancheongRail divider under the header', () => {
    const { container } = render(
      <PageHubHeader titleId="t" eyebrow="Library" heading="Vocabulary" />,
    );
    expect(
      container.querySelector('.km-hubheader__rail-divider .km-dancheong-rail'),
    ).toBeInTheDocument();
  });

  it('omits the actions row when no actions are given', () => {
    const { container } = render(
      <PageHubHeader titleId="t" eyebrow="Library" heading="Vocabulary" />,
    );
    expect(container.querySelector('.km-hubheader__actions')).toBeNull();
  });

  it('renders a supplied actions slot', () => {
    render(
      <PageHubHeader
        titleId="t"
        eyebrow="Library"
        heading="Vocabulary"
        actions={<button type="button">Filter</button>}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Filter' }),
    ).toBeInTheDocument();
  });

  it('applies the hangul-watermark texture + data-glyph only when glyph is given', () => {
    const { container: withoutGlyph } = render(
      <PageHubHeader titleId="t" eyebrow="Library" heading="Vocabulary" />,
    );
    expect(withoutGlyph.querySelector('.km-hangul-watermark')).toBeNull();

    const { container: withGlyph } = render(
      <PageHubHeader
        titleId="t2"
        eyebrow="Library"
        heading="Vocabulary"
        glyph="단"
      />,
    );
    const watermarked = withGlyph.querySelector('.km-hangul-watermark');
    expect(watermarked).not.toBeNull();
    expect(watermarked).toHaveAttribute('data-glyph', '단');
  });

  it('forwards className onto the root element', () => {
    const { container } = render(
      <PageHubHeader
        titleId="t"
        eyebrow="Library"
        heading="Vocabulary"
        className="km-vocab__hub"
      />,
    );
    expect(container.firstElementChild?.className).toContain('km-vocab__hub');
  });
});
