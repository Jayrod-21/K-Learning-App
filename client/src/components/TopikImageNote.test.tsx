/**
 * <TopikImageNote/> (F-081 text descriptions; F-120 real exam figures).
 *
 * Coverage:
 *   - text-only rendering unchanged: description → featured paragraph,
 *     no description → the honest fallback hint, never an <img>;
 *   - F-120: a valid `imageUrl` renders an <img> whose src went through
 *     buildTopikImageSrc (empty API base in tests → the app-relative path
 *     verbatim), with the description as the figure's caption AND alt;
 *   - imageUrl without a description still renders the figure (generic alt);
 *   - a failed image load (error event) removes the <img> and falls back to
 *     the same text note used when no image was mapped;
 *   - an off-allow-list imageUrl (tampered wire value) renders NO <img> and
 *     falls back to the text path — the allow-list is what feeds the src.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TopikImageNote } from './TopikImageNote';

// NOTE on src assertions: the test env builds with no VITE_API_URL, so
// `getApiBaseUrl()` returns '' (prod same-origin shape) and
// buildTopikImageSrc yields the app-relative path verbatim.

const DESC = '두 사람이 카페에서 이야기하는 그림';

describe('TopikImageNote — text-only (pre-F-120 behavior unchanged)', () => {
  it('features the description when captured, with no <img>', () => {
    const { container } = render(<TopikImageNote description={DESC} />);
    expect(container.querySelector('.km-topik__image-desc')?.textContent).toBe(DESC);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the honest fallback hint when no description exists', () => {
    const { container } = render(<TopikImageNote description={null} />);
    expect(container.querySelector('.km-topik__image-hint')?.textContent).toContain(
      'Answer from the text above',
    );
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('TopikImageNote — real exam figure (F-120)', () => {
  it('renders the <img> through the allow-list join, description as caption + alt', () => {
    const { container } = render(
      <TopikImageNote description={DESC} imageUrl="/topik/image/60/2/1" />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/topik/image/60/2/1');
    expect(img?.getAttribute('alt')).toBe(DESC);
    expect(container.querySelector('figcaption')?.textContent).toBe(DESC);
    // The figure replaces the bare paragraph; the hint never shows.
    expect(container.querySelector('.km-topik__image-hint')).toBeNull();
  });

  it('renders the figure with a generic alt when no description was captured', () => {
    const { container } = render(
      <TopikImageNote description={null} imageUrl="/topik/image/60/1/17" />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/topik/image/60/1/17');
    expect(img?.getAttribute('alt')).toBe('Exam figure for this question');
    expect(container.querySelector('figcaption')).toBeNull();
  });

  it('a failed image load drops the <img> and falls back to the text note', () => {
    const { container } = render(
      <TopikImageNote description={DESC} imageUrl="/topik/image/60/2/1" />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.km-topik__image-desc')?.textContent).toBe(DESC);
  });

  it('an off-allow-list imageUrl never reaches an <img> — text fallback instead', () => {
    const { container } = render(
      <TopikImageNote description={DESC} imageUrl="https://evil.example/x.png" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.km-topik__image-desc')?.textContent).toBe(DESC);
  });

  it('an off-allow-list imageUrl with no description degrades to the hint', () => {
    const { container } = render(
      <TopikImageNote description={null} imageUrl="//evil.example/x.png" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.km-topik__image-hint')).not.toBeNull();
  });
});
