/**
 * ScrollSnapCarousel — a native CSS scroll-snap horizontal pager.
 *
 * Why this exists next to SwipeCarousel (and why Listen uses it): on a page
 * whose DOCUMENT scrolls vertically (Listen's tall 2-col tile grids), a
 * hand-rolled pointer-drag carousel under `touch-action: pan-y` loses a
 * gesture race it cannot win. The browser's own touch arbitration (its slop
 * radius + direction heuristic, independent of any JS axis lock) may claim
 * an arced thumb-swipe as a vertical pan at any moment, fire `pointercancel`,
 * and stop delivering moves — usually before the drag has accumulated enough
 * dx to cross a snap threshold. No pointer-event countermeasure fixes that:
 * `preventDefault()` on pointermove cannot veto a pan that `touch-action`
 * permits (per spec, only `touch-action` gates scrolling), and committing on
 * the cancel (SwipeCarousel's mitigation) still only sees the few px the
 * browser deigned to deliver — the observed "nudges but doesn't swipe over"
 * mobile bug.
 *
 * The fix is to stop fighting the browser and let IT own the swipe: a
 * horizontal `overflow-x: auto` track with `scroll-snap-type: x mandatory`.
 * Native horizontal overflow-scroll coexists with native vertical document
 * scroll — the engine's gesture arbitration routes horizontal pans to the
 * track and vertical pans through to the document scroller (the track has no
 * vertical overflow, so vertical pans chain straight up). There is no
 * pointercancel to lose, no threshold to miss, and momentum + snap physics
 * are the platform's own. No `touch-action` is set ANYWHERE here — default
 * `auto` is exactly what lets the browser arbitrate both axes natively.
 *
 * SwipeCarousel remains the right tool where its pages do NOT scroll
 * vertically (Progress, Today) and where `loop` is needed — scroll-snap has
 * no native wrap. This component deliberately supports no `loop` and no
 * `cornerSlot`; it is the vertical-scroll-coexistent pager.
 *
 * Dots: same W3C carousel-with-tabs pattern as SwipeCarousel (`tablist` of
 * `tab` buttons, roving tabindex, Left/Right/Home/End with wrap). The ACTIVE
 * dot is derived from scroll position: a scroll listener (rAF-throttled for
 * the live mid-swipe sync) computes `round(scrollLeft / pageWidth)`, and a
 * short debounce after the last scroll event marks the gesture SETTLED —
 * that settle is what fires `onChange` for swipes. A dot click/keypress
 * scrolls the track programmatically (`scrollTo`, smooth unless
 * `prefers-reduced-motion`) and reports `onChange` immediately (the target
 * is known — parity with SwipeCarousel's dot behavior); the in-flight
 * smooth scroll's intermediate positions are suppressed from dot state via
 * a pending-target ref so the dots never flicker through pages en route.
 *
 * A11y — INTENTIONAL difference from SwipeCarousel: off-screen pages are
 * NOT `aria-hidden`/`inert`. With native scroll the off-screen pages must
 * remain scrollable-to and focusable — inerting them would make the
 * carousel's own mechanism unreachable (sequential focus / find-in-page can
 * legitimately land there, and the browser scrolls the page into view when
 * it does, which is correct behavior for a scroll-driven pager). Every page
 * is instead a labeled `tabpanel` wired to its dot (`aria-controls` /
 * `aria-labelledby` both ways), inside a labeled
 * `aria-roledescription="carousel"` section.
 *
 * Test-environment honesty: happy-dom/jsdom have no layout, so
 * `clientWidth`/`scrollLeft` are 0 and `Element.scrollTo` may not exist.
 * Every geometry read is guarded (`width <= 0` → no scroll attempt, dot
 * state still updates), and `scrollTo` falls back to a `scrollLeft`
 * assignment when absent. Real snap physics are therefore ONLY verifiable
 * on-device — see the test file's header for the exact manual checklist.
 *
 * Lint contract (repo convention, mirrors SwipeCarousel): no state is set
 * inside any effect — scroll bookkeeping lives in refs mutated by event
 * handlers and their scheduled callbacks (timers/rAF are handler-scheduled,
 * not effects); the mount effect only positions `scrollLeft` (not state);
 * the active index is CLAMPED at render time so a shrinking `children`
 * array can never strand the dots on a page that no longer exists (the
 * native scroller clamps its own `scrollLeft` when `scrollWidth` shrinks).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import './ScrollSnapCarousel.css';

export interface ScrollSnapCarouselProps {
  /** The pages, one ReactNode per page, in display order. */
  children: ReactNode[];
  /** Accessible name for the carousel region. */
  ariaLabel: string;
  /** Page shown first (clamped into range). Defaults to 0. */
  initialIndex?: number;
  /**
   * Called with the new settled page index whenever the page changes via a
   * user gesture — a swipe once its scroll settles, or a dot click/keypress
   * immediately (the target is known). Not called for intermediate pages a
   * smooth scroll passes through, nor when a shrinking `children` array
   * clamps the index at render time. Optional.
   */
  onChange?: (index: number) => void;
}

/**
 * Quiet time (ms) after the last scroll event before the gesture counts as
 * settled. Native snap keeps emitting scroll events until the snap animation
 * lands, so this fires once per gesture, on the final resting position.
 */
const SETTLE_MS = 150;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function ScrollSnapCarousel({
  children,
  ariaLabel,
  initialIndex = 0,
  onChange,
}: ScrollSnapCarouselProps): JSX.Element {
  const count = children.length;
  const maxIndex = Math.max(0, count - 1);

  const [rawActive, setRawActive] = useState(() =>
    clamp(initialIndex, 0, maxIndex),
  );
  // Clamp at render time — if `children` shrinks, the dots land on the new
  // last page immediately (no effect, no flash of a dot for a gone page).
  const active = clamp(rawActive, 0, maxIndex);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Debounce handle for the settled-gesture detector. */
  const settleTimerRef = useRef<number | null>(null);
  /** rAF handle for the live (mid-swipe) dot sync. */
  const rafRef = useRef<number | null>(null);
  /**
   * Index a programmatic scroll (dot click/keys) is heading to. While set,
   * the live dot sync ignores the smooth scroll's intermediate positions
   * (the dot already sits on the target); the settle detector clears it.
   */
  const pendingTargetRef = useRef<number | null>(null);
  /** Last index reported settled (via onChange or explicit navigation). */
  const settledRef = useRef(clamp(initialIndex, 0, maxIndex));
  const id = useId();

  // Mount: place the track on initialIndex BEFORE first paint (a plain
  // scrollLeft write — instant, no smooth animation on load). In layoutless
  // test DOMs clientWidth is 0, so there is nothing to position; the dots
  // already reflect initialIndex via state.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const width = track.clientWidth;
    if (width > 0 && settledRef.current > 0) {
      track.scrollLeft = settledRef.current * width;
    }
  }, []);

  // Unmount: kill any in-flight settle timer / rAF.
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** Page index the track's current scroll position rounds to. */
  const indexFromScroll = (track: HTMLElement): number => {
    const width = track.clientWidth;
    // No geometry (test DOM, display:none) — trust the last settled index.
    if (width <= 0) return settledRef.current;
    return clamp(Math.round(track.scrollLeft / width), 0, maxIndex);
  };

  /**
   * Programmatic scroll to a page. Smooth unless the user prefers reduced
   * motion (then an instant jump). Guarded for layoutless test DOMs: with
   * zero width there is nowhere to scroll (dot state alone carries the
   * change), and a missing `Element.scrollTo` degrades to a `scrollLeft`
   * assignment (the same instant jump).
   */
  const scrollToIndex = (target: number): void => {
    const track = trackRef.current;
    if (track === null) return;
    const width = track.clientWidth;
    const left = target * width;
    if (width <= 0 || Math.abs(track.scrollLeft - left) < 1) return;
    pendingTargetRef.current = target;
    if (typeof track.scrollTo === 'function') {
      track.scrollTo({
        left,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    } else {
      track.scrollLeft = left;
    }
  };

  /** Dot-driven navigation (click / keyboard). */
  const goTo = (next: number, focusDot = false): void => {
    const target = clamp(next, 0, maxIndex);
    setRawActive(target);
    scrollToIndex(target);
    // Report immediately — the destination is known, no need to wait for
    // the smooth scroll to land (and clicking the already-active dot is a
    // no-op, exactly like SwipeCarousel).
    if (target !== settledRef.current) {
      settledRef.current = target;
      onChange?.(target);
    }
    if (focusDot) tabRefs.current[target]?.focus();
  };

  /**
   * Scroll listener — the ONLY input during a native swipe. Two jobs:
   *  1. Live dot sync (rAF-throttled): the dot tracks the page under the
   *     finger mid-gesture, unless a programmatic scroll is in flight
   *     (pendingTargetRef — the dot already sits on the destination).
   *  2. Settle detection (trailing debounce): SETTLE_MS of scroll silence
   *     means the snap landed; clear any pending target and report the
   *     resting page via onChange if it actually changed.
   */
  const onScroll = (): void => {
    if (
      rafRef.current === null &&
      typeof requestAnimationFrame === 'function'
    ) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const track = trackRef.current;
        if (track === null) return;
        if (pendingTargetRef.current !== null) return;
        setRawActive(indexFromScroll(track));
      });
    }
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      const track = trackRef.current;
      if (track === null) return;
      const settled = indexFromScroll(track);
      pendingTargetRef.current = null;
      setRawActive(settled);
      if (settled !== settledRef.current) {
        settledRef.current = settled;
        onChange?.(settled);
      }
    }, SETTLE_MS);
  };

  // ── Dot keyboard navigation (W3C tabs pattern, with wrap) ──
  // Attached to each (focusable) tab button, not the tablist wrapper —
  // mirrors SwipeCarousel (roving tabindex keeps focus on a tab anyway).
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = active === maxIndex ? 0 : active + 1;
    else if (e.key === 'ArrowLeft') next = active === 0 ? maxIndex : active - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = maxIndex;
    if (next === null) return;
    e.preventDefault();
    goTo(next, true);
  };

  return (
    <section
      className="km-snap-carousel"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
    >
      <div
        ref={trackRef}
        className="km-snap-carousel__track"
        onScroll={onScroll}
      >
        {children.map((child, i) => (
          <div
            // Pages are positional by contract (children order IS page
            // order and the list never reorders), so the index is the key.
            key={i}
            id={`${id}-panel-${String(i)}`}
            className="km-snap-carousel__page"
            role="tabpanel"
            aria-labelledby={`${id}-tab-${String(i)}`}
            // Deliberately NOT aria-hidden/inert (see header): native
            // scroll must be able to reach and reveal every page.
          >
            {child}
          </div>
        ))}
      </div>

      {count >= 2 ? (
        <div
          className="km-snap-carousel__dots"
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
              className={`km-snap-carousel__dot${i === active ? ' km-snap-carousel__dot--active' : ''} focusring`}
              role="tab"
              aria-selected={i === active}
              aria-controls={`${id}-panel-${String(i)}`}
              aria-label={`Page ${String(i + 1)} of ${String(count)}`}
              tabIndex={i === active ? 0 : -1}
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

export default ScrollSnapCarousel;
