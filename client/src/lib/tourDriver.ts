/**
 * tourDriver — the ONLY module that touches driver.js (the coach-mark
 * overlay engine). Everything else speaks the inert registry shapes from
 * `lib/tours.ts`; tests mock THIS module instead of driver.js internals.
 *
 * Responsibilities:
 *   - Missing-target guard: anchored steps whose element is not currently in
 *     the DOM are dropped before the drive starts. If a tour that HAS
 *     anchored steps loses all of them (page still loading, empty state,
 *     desktop-vs-mobile chrome), the un-anchored connective copy usually
 *     still runs; a tour reduced to ZERO steps reports 'unavailable' and the
 *     caller does not mark it seen — it simply retries on a later visit.
 *     The tour can therefore never block the UI or crash on a missing node.
 *   - Reduced motion: `prefers-reduced-motion: reduce` turns off the
 *     spotlight/popover animations (driver's `animate: false`).
 *   - Dismissal: Esc and overlay-click close the tour (`allowClose`), and
 *     BOTH finish and dismiss funnel through `onFinished` — a skipped tour
 *     is a seen tour (never re-nag someone who closed it).
 *   - `disableActiveInteraction` — the spotlighted element is inert while
 *     the tour runs, so a highlighted nav tab can't navigate mid-tour and
 *     strand the popover on a dead node.
 *
 * Theming: driver's stock stylesheet is imported once here and re-skinned by
 * `styles/tour.css` (imported globally) via the `km-tour` popoverClass —
 * app tokens only, so light/dark themes and the Seoul-neon accent presets
 * apply automatically.
 */
import { driver, type Config, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
// App re-skin — must import AFTER driver's stock stylesheet so the token
// overrides win on cascade order (see styles/tour.css header).
import '../styles/tour.css';
import type { TourDefinition } from './tours';

/** Handle over a running tour — `destroy()` tears the overlay down
 *  immediately (unmount / route-change cleanup); it still fires the
 *  driver's destroy pipeline, so `onFinished` runs exactly once. */
export interface TourHandle {
  destroy: () => void;
}

export type StartTourResult =
  | { status: 'started'; handle: TourHandle }
  | { status: 'unavailable' };

/** OS-level reduced-motion preference, read at start time (same guarded
 *  matchMedia pattern as Shell.tsx — some test DOMs lack matchMedia). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Start a tour. Filters missing-target steps, then drives the rest.
 * `onFinished` fires exactly once when the tour ends for ANY reason —
 * completed, skipped via Esc/overlay/✕, or destroyed by the caller.
 */
export function startTour(
  tour: TourDefinition,
  opts: { onFinished: () => void },
): StartTourResult {
  const steps: DriveStep[] = [];
  for (const s of tour.steps) {
    if (s.target !== undefined) {
      // Missing-target guard — resolve NOW, render later. driver.js would
      // fall back to a centered popover for a dead selector, which would
      // show anchored copy ("this button here") with no button; dropping
      // the step is the honest behavior.
      if (document.querySelector(s.target) === null) continue;
      steps.push({
        element: s.target,
        popover: {
          title: s.title,
          description: s.body,
          ...(s.side !== undefined ? { side: s.side } : {}),
        },
      });
    } else {
      // No target — driver renders a centered modal popover.
      steps.push({ popover: { title: s.title, description: s.body } });
    }
  }

  if (steps.length === 0) {
    return { status: 'unavailable' };
  }

  let finished = false;
  const config: Config = {
    steps,
    animate: !prefersReducedMotion(),
    allowClose: true, // Esc / overlay click / ✕ all skip the tour.
    disableActiveInteraction: true,
    showProgress: steps.length > 1,
    progressText: '{{current}} / {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    stagePadding: 6,
    stageRadius: 10,
    overlayOpacity: 0.6,
    popoverClass: 'km-tour',
    onDestroyed: () => {
      // Fires for finish AND skip AND programmatic destroy. Latch so a
      // double-destroy (route change racing a finish) can't double-mark.
      if (finished) return;
      finished = true;
      opts.onFinished();
    },
  };

  const d = driver(config);
  d.drive();
  return {
    status: 'started',
    handle: {
      destroy: () => {
        // Idempotent — driver.js no-ops when already destroyed, and the
        // `finished` latch above keeps onFinished single-fire regardless.
        d.destroy();
      },
    },
  };
}
