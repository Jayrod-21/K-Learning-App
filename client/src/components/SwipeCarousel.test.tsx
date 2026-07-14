/**
 * SwipeCarousel — pages render, dot navigation, keyboard arrows (with
 * wrap + Home/End), the ARIA carousel/tabs contract, index clamping, and a
 * pointer-drag snap (happy-dom's PointerEvent carries the coordinates the
 * axis lock needs; capture APIs are feature-guarded in the component).
 * Failure/edge side: stuck-drag recovery (off-element release, vertical
 * surrender), pointercancel cleanup, edge overscroll, multi-touch and
 * non-primary/right-button rejection.
 * F-029 additions: `loop` wrap in both directions (swipe + dot state) with
 * the non-loop edge behavior preserved by default, and the `cornerSlot`
 * overlay (renders above the slides; absent when omitted).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { SwipeCarousel } from './SwipeCarousel';

function renderCarousel(
  props: Partial<{
    initialIndex: number;
    loop: boolean;
    cornerSlot: ReactNode;
  }> = {},
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

/** The pointer-event target (the drag surface). */
function viewportOf(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector('.km-carousel__viewport');
  if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');
  return viewport;
}

/**
 * A full valid leftward swipe (120px, past the 48px threshold floor) that
 * must advance one page. Real gestures are primary left-button pointers, so
 * every event carries `isPrimary: true` (the component rejects the rest).
 */
function swipeLeft(viewport: HTMLElement, pointerId = 9): void {
  fireEvent.pointerDown(viewport, {
    pointerId, isPrimary: true, button: 0, clientX: 200, clientY: 50,
  });
  fireEvent.pointerMove(viewport, {
    pointerId, isPrimary: true, clientX: 140, clientY: 52,
  });
  fireEvent.pointerMove(viewport, {
    pointerId, isPrimary: true, clientX: 80, clientY: 55,
  });
  fireEvent.pointerUp(viewport, {
    pointerId, isPrimary: true, clientX: 80, clientY: 55,
  });
}

/** The mirror gesture — a full valid rightward swipe (previous page). */
function swipeRight(viewport: HTMLElement, pointerId = 9): void {
  fireEvent.pointerDown(viewport, {
    pointerId, isPrimary: true, button: 0, clientX: 80, clientY: 50,
  });
  fireEvent.pointerMove(viewport, {
    pointerId, isPrimary: true, clientX: 140, clientY: 52,
  });
  fireEvent.pointerMove(viewport, {
    pointerId, isPrimary: true, clientX: 200, clientY: 55,
  });
  fireEvent.pointerUp(viewport, {
    pointerId, isPrimary: true, clientX: 200, clientY: 55,
  });
}

/** aria-selected assertion helper — `page` is 1-based. */
function expectSelectedPage(page: number, of = 3): void {
  expect(
    screen.getByRole('tab', { name: `Page ${String(page)} of ${String(of)}` }),
  ).toHaveAttribute('aria-selected', 'true');
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
    const viewport = viewportOf(container);

    // Leftward drag of 120px (threshold floor is 48px in a zero-width env).
    swipeLeft(viewport, 1);

    expectSelectedPage(2);
  });

  it('leaves the page alone on a vertical-dominant drag (scroll, not swipe)', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    // Vertical wins the axis lock; the later horizontal travel must be ignored.
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 202, clientY: 120,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 200,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 200,
    });

    expectSelectedPage(1);
  });

  it('springs back on a short drag under the threshold', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 180, clientY: 50,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1, isPrimary: true, clientX: 180, clientY: 50,
    });

    expectSelectedPage(1);
  });

  // ── Stuck-drag regressions (B1) ─────────────────────────────
  // Mouse pointers have no implicit capture; a gesture that never locks 'h'
  // and is released off-viewport would previously leave `dragRef` populated
  // forever, silently swallowing every future swipe.

  it('still swipes after a press whose pointer left the viewport and was released off-element', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // Press, flick out of the viewport with no in-element move, release on
    // the body — neither pointerup nor pointercancel reaches the viewport.
    // (React synthesizes onPointerLeave from native pointerout + an outside
    // relatedTarget, so that is what a real leave delivers here.)
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    fireEvent.pointerOut(viewport, {
      pointerId: 1, isPrimary: true, relatedTarget: document.body,
    });
    fireEvent.pointerUp(document.body, {
      pointerId: 1, isPrimary: true, clientX: 500, clientY: 400,
    });
    expectSelectedPage(1);

    // A subsequent fully valid swipe MUST still snap.
    swipeLeft(viewport, 2);
    expectSelectedPage(2);
  });

  it('still swipes after a vertical drag released off-element', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // Vertical-dominant gesture (surrendered), released below the carousel.
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 201, clientY: 160,
    });
    fireEvent.pointerUp(document.body, {
      pointerId: 1, isPrimary: true, clientX: 201, clientY: 400,
    });
    expectSelectedPage(1);

    // A subsequent fully valid swipe MUST still snap.
    swipeLeft(viewport, 2);
    expectSelectedPage(2);
  });

  it('cleans up on pointercancel and accepts the next gesture', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // A live horizontal drag gets cancelled mid-flight (e.g. OS gesture).
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 100, clientY: 52,
    });
    fireEvent.pointerCancel(viewport, { pointerId: 1, isPrimary: true });
    // The cancelled drag must not snap...
    expectSelectedPage(1);

    // ...and must not block the next gesture.
    swipeLeft(viewport, 2);
    expectSelectedPage(2);
  });

  // ── Edge overscroll (the goTo clamp under drag) ─────────────

  it('stays on the first page when swiping backwards past the start', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // Rightward drag on page 1 — over the threshold, but there is no page 0.
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 52,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 52,
    });

    expectSelectedPage(1);
  });

  it('stays on the last page when swiping forwards past the end', () => {
    const { container } = renderCarousel({ initialIndex: 2 });
    const viewport = viewportOf(container);

    swipeLeft(viewport, 1);

    expectSelectedPage(3);
  });

  // ── Multi-touch + non-primary pointers ──────────────────────

  it('ignores a second pointer during a live gesture (multi-touch)', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // First (primary) finger arms and drags horizontally.
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 140, clientY: 52,
    });
    // Second finger lands mid-gesture — its down/move/up must all be inert.
    fireEvent.pointerDown(viewport, {
      pointerId: 2, isPrimary: false, clientX: 300, clientY: 60,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 2, isPrimary: false, clientX: 30, clientY: 60,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 2, isPrimary: false, clientX: 30, clientY: 60,
    });
    expectSelectedPage(1);

    // The first finger completes its swipe: exactly one page advance.
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 55,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 55,
    });
    expectSelectedPage(2);
  });

  it('ignores non-primary and non-left-button presses entirely', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // Right-button drag past the threshold — never a swipe.
    fireEvent.pointerDown(viewport, {
      pointerId: 1, isPrimary: true, button: 2, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 52,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1, isPrimary: true, clientX: 80, clientY: 52,
    });
    expectSelectedPage(1);

    // Non-primary press (e.g. a stray second touch) — also never a swipe.
    fireEvent.pointerDown(viewport, {
      pointerId: 2, isPrimary: false, button: 0, clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 2, isPrimary: false, clientX: 80, clientY: 52,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 2, isPrimary: false, clientX: 80, clientY: 52,
    });
    expectSelectedPage(1);

    // And neither dead press blocks a real swipe afterwards.
    swipeLeft(viewport, 3);
    expectSelectedPage(2);
  });

  // ── Loop (F-029) ────────────────────────────────────────────

  it('wraps last→first on a forward swipe when loop is set', () => {
    const { container } = renderCarousel({ loop: true, initialIndex: 2 });
    const viewport = viewportOf(container);

    swipeLeft(viewport, 1);

    // The dot state follows the wrap — page 1 is now selected + exposed.
    expectSelectedPage(1);
    expect(panels()[0]).toHaveAttribute('aria-hidden', 'false');
    expect(panels()[2]).toHaveAttribute('aria-hidden', 'true');
  });

  it('wraps first→last on a backward swipe when loop is set', () => {
    const { container } = renderCarousel({ loop: true });
    const viewport = viewportOf(container);

    swipeRight(viewport, 1);

    expectSelectedPage(3);
    expect(panels()[2]).toHaveAttribute('aria-hidden', 'false');
  });

  it('keeps looping across repeated forward swipes (1 → 2 → 3 → 1)', () => {
    const { container } = renderCarousel({ loop: true });
    const viewport = viewportOf(container);

    swipeLeft(viewport, 1);
    expectSelectedPage(2);
    swipeLeft(viewport, 2);
    expectSelectedPage(3);
    swipeLeft(viewport, 3);
    expectSelectedPage(1);
  });

  it('still hard-stops at the edges by default (loop unset)', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    // Backward on page 1 must NOT wrap to page 3.
    swipeRight(viewport, 1);
    expectSelectedPage(1);
  });

  // ── Corner slot (F-029) ─────────────────────────────────────

  it('renders cornerSlot content as an overlay inside the viewport', () => {
    const { container } = renderCarousel({
      cornerSlot: <button type="button">Resume session</button>,
    });

    const slot = screen.getByRole('button', { name: 'Resume session' });
    const corner = slot.closest('.km-carousel__corner');
    expect(corner).not.toBeNull();
    // The overlay lives inside the viewport, alongside (not inside) a page.
    expect(viewportOf(container).contains(corner)).toBe(true);
    expect(slot.closest('.km-carousel__page')).toBeNull();
  });

  it('renders no corner container when cornerSlot is omitted', () => {
    const { container } = renderCarousel();
    expect(container.querySelector('.km-carousel__corner')).toBeNull();
  });

  // ── Touch pointer flow (Bug 2 — real-mobile swipe) ──────────────────
  //
  // happy-dom's PointerEvent carries `pointerType`, so these exercise the
  // exact same handlers a real touch would hit — nothing in the component
  // branches on `pointerType`, so a touch-flagged gesture must behave
  // identically to the untyped one the tests above use, and a regression
  // that accidentally filtered by `pointerType` would fail here first.

  it('advances the page on a touch pointer down/move/up horizontal drag', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    fireEvent.pointerDown(viewport, {
      pointerId: 4, isPrimary: true, button: 0, pointerType: 'touch',
      clientX: 200, clientY: 50,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 140, clientY: 52,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 80, clientY: 55,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 80, clientY: 55,
    });

    expectSelectedPage(2);
  });

  it('leaves the page alone on a vertical-dominant touch drag, preserving scroll (no preventDefault)', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    fireEvent.pointerDown(viewport, {
      pointerId: 4, isPrimary: true, button: 0, pointerType: 'touch',
      clientX: 200, clientY: 50,
    });
    // Vertical-dominant move — the axis locks 'v' and surrenders. A
    // cancelable event's dispatch returns `true` when `preventDefault` was
    // NOT called — asserting that here is exactly the "scroll preserved"
    // contract: this component must never veto a gesture it surrendered.
    const notPrevented = fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 202, clientY: 120,
    });
    expect(notPrevented).toBe(true);

    fireEvent.pointerUp(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 202, clientY: 120,
    });
    expectSelectedPage(1);
  });

  it('calls preventDefault on every move once the axis locks horizontal, not before', () => {
    const { container } = renderCarousel();
    const viewport = viewportOf(container);

    fireEvent.pointerDown(viewport, {
      pointerId: 4, isPrimary: true, button: 0, pointerType: 'touch',
      clientX: 200, clientY: 50,
    });

    // Still inside the 8px axis-lock window — undecided, so the browser
    // must remain free to claim the gesture (no preventDefault yet).
    const undecided = fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 204, clientY: 51,
    });
    expect(undecided).toBe(true);

    // This move crosses the threshold with a horizontal-dominant delta —
    // the axis locks 'h' and this SAME move must already be vetoed.
    const locking = fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 180, clientY: 52,
    });
    expect(locking).toBe(false);

    // Every subsequent 'h'-axis move keeps vetoing, not just the first.
    const continuing = fireEvent.pointerMove(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 140, clientY: 53,
    });
    expect(continuing).toBe(false);

    fireEvent.pointerUp(viewport, {
      pointerId: 4, isPrimary: true, pointerType: 'touch',
      clientX: 140, clientY: 53,
    });
  });
});
