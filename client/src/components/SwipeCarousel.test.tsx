/**
 * SwipeCarousel — pages render, dot navigation, keyboard arrows (with
 * wrap + Home/End), the ARIA carousel/tabs contract, index clamping, and a
 * pointer-drag snap (happy-dom's PointerEvent carries the coordinates the
 * axis lock needs; capture APIs are feature-guarded in the component).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwipeCarousel } from './SwipeCarousel';

function renderCarousel(
  props: Partial<{ initialIndex: number }> = {},
): ReturnType<typeof render> {
  return render(
    <SwipeCarousel ariaLabel="Progress by skill" {...props}>
      {[
        <div key="a">PAGE ALPHA</div>,
        <div key="b">PAGE BRAVO</div>,
        <div key="c">PAGE CHARLIE</div>,
      ]}
    </SwipeCarousel>,
  );
}

/** The tabpanel wrappers, in page order. */
function panels(): HTMLElement[] {
  return screen.getAllByRole('tabpanel', { hidden: true });
}

describe('SwipeCarousel', () => {
  it('renders every page and the ARIA carousel/tabs contract', () => {
    renderCarousel();

    const region = screen.getByRole('region', { name: 'Progress by skill' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');

    expect(screen.getByText('PAGE ALPHA')).toBeInTheDocument();
    expect(screen.getByText('PAGE BRAVO')).toBeInTheDocument();
    expect(screen.getByText('PAGE CHARLIE')).toBeInTheDocument();

    expect(
      screen.getByRole('tablist', { name: 'Progress by skill pages' }),
    ).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    // Tabs and panels are wired both ways.
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panels()[0]?.id);
    expect(panels()[0]?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);

    // Only the active page is exposed; the rest are hidden + inert.
    expect(panels()[0]).toHaveAttribute('aria-hidden', 'false');
    expect(panels()[1]).toHaveAttribute('aria-hidden', 'true');
    expect(panels()[1]).toHaveAttribute('inert');
  });

  it('changes page when a dot is clicked', async () => {
    const user = userEvent.setup();
    renderCarousel();

    await user.click(screen.getByRole('tab', { name: 'Page 3 of 3' }));

    expect(
      screen.getByRole('tab', { name: 'Page 3 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(panels()[2]).toHaveAttribute('aria-hidden', 'false');
    expect(panels()[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('moves selection with arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup();
    renderCarousel();

    await user.click(screen.getByRole('tab', { name: 'Page 1 of 3' }));
    await user.keyboard('{ArrowRight}');
    expect(
      screen.getByRole('tab', { name: 'Page 2 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
    // Focus roves with selection.
    expect(screen.getByRole('tab', { name: 'Page 2 of 3' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    // 2 → 1 → wrap to 3.
    expect(
      screen.getByRole('tab', { name: 'Page 3 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    // Wrap 3 → 1.
    expect(
      screen.getByRole('tab', { name: 'Page 1 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{End}');
    expect(
      screen.getByRole('tab', { name: 'Page 3 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(
      screen.getByRole('tab', { name: 'Page 1 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('respects initialIndex and clamps it into range', () => {
    const first = renderCarousel({ initialIndex: 1 });
    expect(
      screen.getByRole('tab', { name: 'Page 2 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
    first.unmount();

    renderCarousel({ initialIndex: 99 });
    expect(
      screen.getByRole('tab', { name: 'Page 3 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('renders a single page with no dots and no swipe affordance', () => {
    render(
      <SwipeCarousel ariaLabel="Solo">
        {[<div key="only">ONLY PAGE</div>]}
      </SwipeCarousel>,
    );
    expect(screen.getByText('ONLY PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('snaps to the next page on a horizontal-dominant drag past the threshold', () => {
    const { container } = renderCarousel();
    const viewport = container.querySelector('.km-carousel__viewport');
    if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');

    // Leftward drag of 120px (threshold floor is 48px in a zero-width env).
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 140, clientY: 52 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 55 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 80, clientY: 55 });

    expect(
      screen.getByRole('tab', { name: 'Page 2 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves the page alone on a vertical-dominant drag (scroll, not swipe)', () => {
    const { container } = renderCarousel();
    const viewport = container.querySelector('.km-carousel__viewport');
    if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 50 });
    // Vertical wins the axis lock; the later horizontal travel must be ignored.
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 202, clientY: 120 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 80, clientY: 200 });

    expect(
      screen.getByRole('tab', { name: 'Page 1 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('springs back on a short drag under the threshold', () => {
    const { container } = renderCarousel();
    const viewport = container.querySelector('.km-carousel__viewport');
    if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 180, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 180, clientY: 50 });

    expect(
      screen.getByRole('tab', { name: 'Page 1 of 3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });
});
