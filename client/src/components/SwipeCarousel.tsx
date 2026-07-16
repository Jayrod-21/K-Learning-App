/**
 * SwipeCarousel — generic one-page-at-a-time swipeable carousel (F-017).
 *
 * Greenfield primitive (no swipe lib — a hand-rolled pointer drag, per the
 * project's no-heavy-deps convention). One child = one page; the track
 * slides horizontally and snaps to exactly one page.
 *
 * Interaction model:
 *   - **Pointer drag.** A primary-pointer, left/first-button pointerdown arms
 *     a gesture; the first ~8px of movement decides its axis.
 *     Horizontal-dominant → the carousel captures the pointer and drags the
 *     track; vertical-dominant → the gesture is surrendered IMMEDIATELY
 *     (tracking stops, the ref clears) so the page keeps scrolling
 *     (`touch-action: pan-y` on the viewport tells the browser the same
 *     thing for touch — it's set on the SAME element (`viewportRef`) that
 *     owns the pointer handlers, which is load-bearing: `touch-action`
 *     only affects the element the touch actually contacts, so a value
 *     declared on a sibling or non-ancestor would be silently ignored.
 *     Once the axis locks 'h', every subsequent move also calls
 *     `preventDefault()` (guarded by `cancelable`) as a same-tick veto
 *     against the browser's own gesture arbitration racing the 8px JS
 *     threshold, and to suppress the trailing synthetic click a short
 *     drag-then-release could otherwise replay on interactive page content
 *     (see `onPointerMove`). Releasing past the snap threshold (20% of the
 *     viewport, min 48px) advances one page; short drags spring back.
 *     Overscroll at either end is damped 3:1.
 *   - **Stuck-drag safety.** Mouse pointers have no implicit capture, and we
 *     deliberately defer `setPointerCapture` until the axis locks `'h'` (so
 *     `click` retargeting can't break interactive page content). That means
 *     a still-undecided gesture whose pointer leaves the viewport would never
 *     see its `pointerup` — so `pointerleave` ends any non-captured gesture,
 *     and `lostpointercapture` ends a captured one whose capture is revoked.
 *     Without these, one off-viewport release would silently swallow every
 *     future swipe until remount.
 *   - **Dots.** `role="tablist"` of `role="tab"` buttons below the track
 *     (the W3C carousel-with-tabs pattern): click to jump, Left/Right arrows
 *     move selection (with wrap), Home/End jump to the ends. Roving
 *     tabindex — only the active dot is in the tab order.
 *   - **Reduced motion.** The slide transition is disabled under
 *     `prefers-reduced-motion: reduce` (pure CSS — the page still changes,
 *     it just doesn't animate).
 *   - **Loop (F-029, opt-in).** `loop` wraps next/prev/swipe last→first and
 *     first→last, and disables the edge damping (a looping carousel has no
 *     edges). The wrap is a "rewind" — the track animates back across the
 *     intermediate pages rather than seamlessly continuing, which is the
 *     honest trade for keeping ONE DOM node per page (a seamless loop needs
 *     leading/trailing page clones plus a mid-transition index snap, and no
 *     current consumer justifies that machinery). Default false: the
 *     existing Progress.tsx usage keeps its solid edges untouched.
 *   - **Corner slot (F-029, opt-in).** `cornerSlot` renders inside the
 *     viewport as a top-left overlay ABOVE the track (for a future resume
 *     banner). It stays fixed while pages slide underneath; it is sized to
 *     its content, so it only intercepts pointers where it actually paints —
 *     swipes on the rest of the viewport are unaffected.
 *   - **Settled-index callback (F-179, opt-in).** `onChange` fires with the
 *     new page index whenever the settled page CHANGES — a swipe that snaps
 *     to a neighbor, a dot click, or dot keyboard navigation. It does not
 *     fire mid-drag, on a spring-back (the index didn't change), on a click
 *     of the already-active dot, or for the render-time clamp when
 *     `children` shrinks (the parent drove that change and already knows).
 *     Default undefined — zero behavior change for existing consumers.
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
  /**
   * Wrap navigation last→first and first→last (next/prev/swipe). Default
   * false — existing consumers keep hard edges with overscroll damping.
   */
  loop?: boolean;
  /**
   * Optional overlay pinned to the viewport's top-left corner, rendered
   * above the slides (e.g. a resume banner). Omitted → nothing renders.
   */
  cornerSlot?: ReactNode;
  /**
   * Called with the new settled page index whenever the page changes via a
   * user gesture (swipe snap, dot click, dot arrow/Home/End). Not called
   * mid-drag, on a spring-back, or when a shrinking `children` array clamps
   * the index at render time. Optional (F-179) — omitted, the carousel
   * behaves exactly as before.
   */
  onChange?: (index: number) => void;
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
  loop = false,
  cornerSlot,
  onChange,
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
    // Looping wraps via a double modulo (handles the -1 from a prev on page
    // 0); non-looping clamps to the hard edges as before.
    const target =
      loop && count > 0
        ? ((next % count) + count) % count
        : clamp(next, 0, maxIndex);
    setRawIndex(target);
    // F-179: report only real settles — `goTo` is only ever called from user
    // gestures (swipe snap, dot click, dot keys), and a no-op target (e.g.
    // clicking the already-active dot, or an edge swipe clamped back onto
    // the same page) is not a page change.
    if (target !== index) onChange?.(target);
    if (focusDot) tabRefs.current[target]?.focus();
  };

  // ── Pointer drag ────────────────────────────────────────────
  const endDrag = (): void => {
    dragRef.current = null;
    setDragX(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (count < 2) return;
    // Only the primary pointer with the left/first button may arm a gesture —
    // a right-click (whose pointerup a context menu can suppress) or a second
    // touch must never start (or corrupt) a drag.
    if (!e.isPrimary || e.button !== 0) return;
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
        // the gesture entirely — and stop tracking it NOW. Keeping the ref
        // alive here is the stuck-drag bug: a mouse released off-viewport
        // never delivers pointerup to us, and the immortal ref would then
        // swallow every future gesture via the guard in onPointerDown.
        endDrag();
        return;
      }
    }
    if (d.axis !== 'h') return;

    // Once the axis has locked horizontal, this pointer sequence is OURS.
    // `touch-action: pan-y` (the viewport's CSS) is what stops the browser
    // from ever starting a native scroll for this gesture in the first
    // place, but on real touch devices the browser's own gesture
    // arbitration (edge-swipe-back navigation, momentum-scroll capture) can
    // still race our 8px JS axis lock during the first couple of samples —
    // `preventDefault()` here is the explicit, same-tick veto that tells the
    // engine "this pointer is spoken for," on every 'h' move, not just the
    // first. It also suppresses the trailing synthetic click on whatever
    // interactive content a carousel page renders (Today's tiles are full-
    // page `<button>`s): per the Pointer Events spec, a browser that has
    // seen `preventDefault()` called during an active touch's move sequence
    // will not replay it as a tap — so a drag that locks 'h' but springs
    // back under the snap threshold can never accidentally "activate" the
    // tile underneath. Guarded by `cancelable` — some replayed/synthetic
    // events (tests, capture-less browsers) aren't, and calling
    // `preventDefault` on those just logs a console warning for nothing.
    if (e.cancelable) e.preventDefault();

    // Damp overscroll beyond the first/last page so the edge feels solid.
    // A looping carousel has no edges — never damp there, or the wrap swipe
    // would feel like it was fighting the user.
    const overscroll =
      !loop && ((index === 0 && dx > 0) || (index === maxIndex && dx < 0));
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

  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    // Once the axis locks 'h' the pointer is captured, so moves keep coming
    // and a leave is not a concern. A gesture still in the capture-less
    // 'none' phase can never complete once the pointer leaves (mouse
    // pointerup off-element would never reach us) — end it here so it can't
    // permanently block future gestures.
    if (d.axis !== 'h') endDrag();
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
        onPointerLeave={onPointerLeave}
        // Belt-and-braces: if a captured 'h' drag has its capture revoked
        // externally, drop the gesture rather than stranding dragX mid-track.
        onLostPointerCapture={endDrag}
      >
        {cornerSlot != null ? (
          <div className="km-carousel__corner">{cornerSlot}</div>
        ) : null}
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
