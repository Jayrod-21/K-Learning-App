/**
 * useStoryImages — the F-211 story-illustration state machine, shared by the
 * Reading story reader (hero-plus-grid gallery) and the Listen landing's
 * story creator card (`components/StoryIllustrations.tsx`). Extracted
 * verbatim from `pages/Reading.tsx` (Listen-tab illustration-visibility
 * work) — the `useStoryAudio` recipe applied to the images route: hydrate
 * once on mount, POST on demand, bounded ~2.5s poll while a job is
 * pending/running, abort-everything-on-unmount. See the hook's own doc
 * comment below for the full contract.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import { getStoryImages, requestStoryImages } from '../services/reading';
import type { StoryImagesEnvelope } from '../services/reading';

/** Poll cadence while an illustration job is pending/running (server
 *  contract: "poll every ~2–3s until done or failed" — image batches take
 *  longer than TTS, so the cadence sits a touch above F-210's 2s). */
const STORY_IMAGES_POLL_MS = 2500;

/**
 * Poll attempt ceiling — bounded churn for a never-settling job (the
 * useStoryAudio precedent). 120 ticks × 2.5s = 5 minutes, generous against
 * a 2–4-image batch's real generation time; the last known status stays on
 * screen and a reopen restarts the budget.
 */
const STORY_IMAGES_POLL_MAX_TICKS = 120;

/** Fixed fallback copy for a failed illustration REQUEST (errorCopy
 *  contract). */
const IMAGES_REQUEST_FAILED_COPY =
  'Could not request illustrations. Try again.';

/** Fixed fallback shown for a `failed` envelope whose `error` is null
 *  (defensive — the server settles a failure with copy, but never trust
 *  a nullable field to be populated). */
export const IMAGES_FAILED_FALLBACK_COPY =
  'Illustration generation failed. Try again.';

/** The empty envelope — what a hydrate failure degrades to (the button
 *  shows; the POST is idempotent, so a tap on an already-illustrated story
 *  just returns the done envelope — self-healing). */
const NO_STORY_IMAGES: StoryImagesEnvelope = {
  status: 'none',
  jobId: null,
  error: null,
  images: [],
};

/**
 * F-211 story-images state machine — the useStoryAudio recipe verbatim:
 * hydrate once on mount (a batch-at-create story is usually pending or
 * already done), POST on demand (old stories), poll the GET every
 * `STORY_IMAGES_POLL_MS` while a job is pending/running, and stop on settle
 * (done/failed), unmount, a terminal mid-poll 404, or the tick ceiling.
 * Every request is abortable; cleanup aborts in-flight calls so a closed
 * reader never lands a late setState (the page-wide contract).
 *
 * Error copy: the daily-cap 429 (no `retryAfter`) and a `failed` envelope's
 * `error` are server-authored WHITELISTED copy shown verbatim — the same
 * sanctioned exception to the fixed-copy rule as F-210 (see
 * services/reading.ts `requestStoryImages`). Everything else routes through
 * `errorMessageFor` as usual.
 */
export function useStoryImages(storyId: number): {
  /** Latest envelope, or null while the mount hydrate is in flight. */
  images: StoryImagesEnvelope | null;
  /** True while the POST itself is in flight (pre-202 button busy state). */
  requesting: boolean;
  /** Request failure copy (429 cap verbatim / fixed copy), or null. */
  requestError: string | null;
  requestImages: () => void;
  /** F-216 — imperatively land a fresh envelope from OUTSIDE this hook's
   *  own request path (the combined-experience POST's images half). Pure
   *  setState: a pending/running envelope flips `polling` and starts the
   *  bounded poll exactly as `requestImages`'s 202 would; a settled one
   *  renders directly. The hydrate/poll/abort lifecycle is untouched. */
  seed: (env: StoryImagesEnvelope) => void;
} {
  const [images, setImages] = useState<StoryImagesEnvelope | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const hydrateCtrlRef = useRef<AbortController | null>(null);
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  const requestCtrlRef = useRef<AbortController | null>(null);

  // Hydrate once per story: `done` shows the gallery with no click; a
  // `pending`/`running` (the batch-at-create job, or one requested in an
  // earlier session) resumes polling.
  useEffect(() => {
    const ctrl = new AbortController();
    hydrateCtrlRef.current?.abort();
    hydrateCtrlRef.current = ctrl;
    getStoryImages(storyId, ctrl.signal)
      .then((env) => {
        if (ctrl.signal.aborted) return;
        setImages(env);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        // Degrade to 'none' rather than blocking the reader behind an image
        // status probe: the button renders, and the idempotent POST
        // self-heals (an already-illustrated story answers 200 done).
        setImages(NO_STORY_IMAGES);
      });
    return () => {
      ctrl.abort();
    };
  }, [storyId]);

  // Poll while a job is unsettled — per-tick abort-before-fetch, transient
  // failures retried next tick, terminal 404 (story deleted mid-poll) stops
  // immediately, and the interval + in-flight tick both die on unmount
  // (useStoryAudio's exact posture).
  const status = images?.status;
  const polling = status === 'pending' || status === 'running';
  useEffect(() => {
    if (!polling) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > STORY_IMAGES_POLL_MAX_TICKS) {
        window.clearInterval(id);
        return;
      }
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      getStoryImages(storyId, ctrl.signal)
        .then((env) => {
          if (ctrl.signal.aborted) return;
          // Settling to done/failed flips `polling` false → effect teardown
          // clears this interval.
          setImages(env);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'canceled') return;
          if (err instanceof ApiError && err.status === 404) {
            // Story gone mid-poll — terminal: stop NOW rather than hammer a
            // route that can only 404 again.
            window.clearInterval(id);
            return;
          }
          // Transient poll failure — next tick retries.
        });
    }, STORY_IMAGES_POLL_MS);
    return () => {
      window.clearInterval(id);
      pollTickCtrlRef.current?.abort();
      pollTickCtrlRef.current = null;
    };
  }, [polling, storyId]);

  // Abort an in-flight POST on unmount (the hydrate/poll effects own their
  // own cleanup above).
  useEffect(
    () => () => {
      requestCtrlRef.current?.abort();
    },
    [],
  );

  const requestImages = useCallback((): void => {
    requestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    requestCtrlRef.current = ctrl;
    setRequesting(true);
    setRequestError(null);
    requestStoryImages(storyId, ctrl.signal).then(
      (env) => {
        if (ctrl.signal.aborted) return;
        setRequesting(false);
        // 202 lands a pending/running envelope (polling starts via the
        // effect above); 200 lands `done` directly (already illustrated).
        setImages(env);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setRequesting(false);
        if (
          err instanceof ApiError &&
          err.status === 429 &&
          err.retryAfter === undefined
        ) {
          // The DAILY image cap — server-authored whitelisted copy, shown
          // verbatim (the F-210 daily-TTS-cap posture); the button stays
          // available. A short-window 429 carries `retryAfter` and falls
          // through to errorMessageFor's structured copy instead.
          setRequestError(err.message);
          return;
        }
        setRequestError(errorMessageFor(err, IMAGES_REQUEST_FAILED_COPY));
      },
    );
  }, [storyId]);

  const seed = useCallback((env: StoryImagesEnvelope): void => {
    // A seeded envelope supersedes any earlier per-asset failure — clear the
    // stale error so a capped experience half doesn't render two alerts.
    setRequestError(null);
    setImages(env);
  }, []);

  return { images, requesting, requestError, requestImages, seed };
}
