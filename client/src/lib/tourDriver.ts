/**
 * tourDriver — the ONLY module that touches driver.js (the coach-mark
 * overlay engine). Everything else speaks the inert registry shapes from
 * `lib/tours.ts`; tests mock THIS module instead of driver.js internals.
 *
 * Responsibilities:
 *   - Missing-target guard: anchored steps whose element is not currently in
 *     the DOM are dropped before the drive starts.
 *   - Availability threshold (fix-pass S1): a tour that DEFINES anchored
 *     steps must resolve AT LEAST ONE of them, or it reports 'unavailable'
 *     and the caller does not mark it seen — it retries on a later visit
 *     instead of burning its one shot running connective copy over a
 *     half-loaded or empty-state page. "At least one" (not "the first" /
 *     "all") is deliberate: it is robust to step reordering, and a
 *     partially-loaded page that resolves most anchors still delivers the
 *     tour's value — only the fully-anchorless case is a degraded no-show.
 *     A tour with NO anchored steps at all (modal-only welcome/outro copy)
 *     is always available. The tour can therefore never block the UI or
 *     crash on a missing node.
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
  let anchoredDefined = 0;
  let anchoredResolved = 0;
  for (const s of tour.steps) {
    if (s.target !== undefined) {
      anchoredDefined += 1;
      // Missing-target guard — resolve NOW, render later. driver.js would
      // fall back to a centered popover for a dead selector, which would
      // show anchored copy ("this button here") with no button; dropping
      // the step is the honest behavior.
      if (document.querySelector(s.target) === null) continue;
      anchoredResolved += 1;
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

  // Availability threshold (see header): an anchored tour that resolved NONE
  // of its anchors is a half-loaded/empty page — report 'unavailable' so the
  // caller does NOT mark it seen and it retries on a later visit, instead of
  // running only its connective copy and burning the one-shot. Modal-only
  // tours (anchoredDefined === 0) skip the check and are always available.
  if (steps.length === 0 || (anchoredDefined > 0 && anchoredResolved === 0)) {
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
