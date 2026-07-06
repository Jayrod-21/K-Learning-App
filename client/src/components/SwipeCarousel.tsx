/**
 * SwipeCarousel — generic one-page-at-a-time swipeable carousel (F-017).
 *
 * Greenfield primitive (no swipe lib — a hand-rolled pointer drag, per the
 * project's no-heavy-deps convention). One child = one page; the track
 * slides horizontally and snaps to exactly one page.
 *
 * Interaction model:
 *   - **Pointer drag.** pointerdown arms a gesture; the first ~8px of
 *     movement decides its axis. Horizontal-dominant → the carousel captures
 *     the pointer and drags the track; vertical-dominant → the gesture is
 *     surrendered so the page keeps scrolling (`touch-action: pan-y` on the
 *     viewport tells the browser the same thing for touch). Releasing past
 *     the snap threshold (20% of the viewport, min 48px) advances one page;
 *     short drags spring back. Overscroll at either end is damped 3:1.
 *   - **Dots.** `role="tablist"` of `role="tab"` buttons below the track
 *     (the W3C carousel-with-tabs pattern): click to jump, Left/Right arrows
 *     move selection (with wrap), Home/End jump to the ends. Roving
 *     tabindex — only the active dot is in the tab order.
 *   - **Reduced motion.** The slide transition is disabled under
 *     `prefers-reduced-motion: reduce` (pure CSS — the page still changes,
 *     it just doesn't animate).
 *
 * Accessibility: the container is a labeled `<section>` (implicit `region`)
 * with `aria-roledescription="carousel"`; each page is a `tabpanel` wired to
 * its dot via `aria-controls`/`aria-labelledby`. Off-screen pages are
 * `aria-hidden` + `inert` so their contents are neither read nor tabbable.
 *
 * Lint contract notes: no state is set inside any effect (drag bookkeeping
 * lives in a ref, mutated only in event handlers), and no ref is written
 * during render (dot refs land via ref callbacks; the drag ref via
 * handlers). Index is CLAMPED at render time instead of "fixed up" in an
 * effect, so a shrinking `children` array can never strand the carousel on
 * a page that no longer exists.
 */
import { useId, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import './SwipeCarousel.css';

export interface SwipeCarouselProps {
  /** The pages, one ReactNode per page, in display order. */
  children: ReactNode[];
  /** Accessible name for the carousel region. */
  ariaLabel: string;
  /** Page shown first (clamped into range). Defaults to 0. */
  initialIndex?: number;
}

/** Movement (px) before a gesture commits to an axis. */
const AXIS_LOCK_PX = 8;
/** Snap threshold floor (px) when the viewport width is unknown/small. */
const MIN_SNAP_PX = 48;
/** Snap threshold as a fraction of the viewport width. */
const SNAP_FRACTION = 0.2;
/** Overscroll damping divisor at the first/last page. */
const EDGE_DAMPING = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Per-gesture bookkeeping — lives in a ref, only handlers touch it. */
interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  /** 'none' until the axis lock decides; 'v' means we surrendered. */
  axis: 'none' | 'h' | 'v';
}

export function SwipeCarousel({
  children,
  ariaLabel,
  initialIndex = 0,
}: SwipeCarouselProps): JSX.Element {
  const count = children.length;
  const maxIndex = Math.max(0, count - 1);

  const [rawIndex, setRawIndex] = useState(() =>
    clamp(initialIndex, 0, maxIndex),
  );
  // Clamp at render time — if `children` shrinks, the carousel lands on the
  // new last page immediately (no effect, no flash of an empty page).
  const index = clamp(rawIndex, 0, maxIndex);

  // Live horizontal drag offset in px; null when no drag is in progress.
  const [dragX, setDragX] = useState<number | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();

  const goTo = (next: number, focusDot = false): void => {
    const target = clamp(next, 0, maxIndex);
    setRawIndex(target);
    if (focusDot) tabRefs.current[target]?.focus();
  };

  // ── Pointer drag ────────────────────────────────────────────
  const endDrag = (): void => {
    dragRef.current = null;
    setDragX(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (count < 2) return;
    // A second touch while a gesture is live is ignored, not restarted.
    if (dragRef.current !== null) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: 'none',
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (d.axis === 'none') {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        d.axis = 'h';
        // Keep receiving moves even if the finger leaves the viewport.
        // (Guarded — happy-dom's PointerEvent lacks capture APIs.)
        const vp = viewportRef.current;
        if (vp && typeof vp.setPointerCapture === 'function') {
          try {
            vp.setPointerCapture(e.pointerId);
          } catch {
            // Capture is an enhancement; the drag works without it.
          }
        }
      } else {
        // Vertical-dominant: this is a page scroll, not a swipe. Surrender
        // the gesture entirely so we never hijack vertical scrolling.
        d.axis = 'v';
        return;
      }
    }
    if (d.axis !== 'h') return;

    // Damp overscroll beyond the first/last page so the edge feels solid.
    const overscroll =
      (index === 0 && dx > 0) || (index === maxIndex && dx < 0);
    setDragX(overscroll ? dx / EDGE_DAMPING : dx);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;

    if (d.axis === 'h') {
      // Decide off the raw event delta, not the damped state — no staleness.
      const dx = e.clientX - d.startX;
      const width = viewportRef.current?.offsetWidth ?? 0;
      const threshold = Math.max(MIN_SNAP_PX, width * SNAP_FRACTION);
      if (dx <= -threshold) goTo(index + 1);
      else if (dx >= threshold) goTo(index - 1);
    }
    endDrag();
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    endDrag();
  };

  // ── Dot keyboard navigation (W3C tabs pattern, with wrap) ──
  // Attached to each (focusable) tab button, not the tablist wrapper —
  // roving tabindex means focus always sits on a tab anyway, and
  // jsx-a11y/interactive-supports-focus rightly rejects a keydown handler
  // on the non-focusable wrapper.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = index === maxIndex ? 0 : index + 1;
    else if (e.key === 'ArrowLeft') next = index === 0 ? maxIndex : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = maxIndex;
    if (next === null) return;
    e.preventDefault();
    goTo(next, true);
  };

  const dragging = dragX !== null;

  return (
    <section
      className="km-carousel"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
    >
      <div
        ref={viewportRef}
        className="km-carousel__viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          className={`km-carousel__track${dragging ? ' km-carousel__track--dragging' : ''}`}
          style={{
            transform: `translateX(calc(${String(-index * 100)}% + ${String(dragX ?? 0)}px))`,
          }}
        >
          {children.map((child, i) => (
            <div
              // Pages are positional by contract (children order IS page
              // order and the list never reorders), so the index is the key.
              key={i}
              id={`${id}-panel-${String(i)}`}
              className="km-carousel__page"
              role="tabpanel"
              aria-labelledby={`${id}-tab-${String(i)}`}
              aria-hidden={i !== index}
              inert={i !== index}
            >
              {child}
            </div>
          ))}
        </div>
      </div>

      {count >= 2 ? (
        <div
          className="km-carousel__dots"
          role="tablist"
          aria-label={`${ariaLabel} pages`}
        >
          {children.map((_, i) => (
            <button
              key={i}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              id={`${id}-tab-${String(i)}`}
              className={`km-carousel__dot${i === index ? ' km-carousel__dot--active' : ''} focusring`}
              role="tab"
              aria-selected={i === index}
              aria-controls={`${id}-panel-${String(i)}`}
              aria-label={`Page ${String(i + 1)} of ${String(count)}`}
              tabIndex={i === index ? 0 : -1}
              onClick={() => {
                goTo(i);
              }}
              onKeyDown={onTabKeyDown}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default SwipeCarousel;
