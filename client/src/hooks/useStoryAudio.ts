/**
 * useStoryAudio — the F-210 story-TTS state machine, shared by the Reading
 * story reader (read-along player) and the Listen landing's story creator
 * card. Extracted verbatim from `pages/Reading.tsx` (Listen-tab story
 * generator work): hydrate once on mount, POST on demand, bounded ~2s poll
 * while a job is pending/running, abort-everything-on-unmount. See the
 * hook's own doc comment below for the full contract.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessageFor } from '../lib/errorCopy';
import { ApiError } from '../services/api';
import { getStoryAudio, requestStoryAudio } from '../services/reading';
import type { StoryAudio } from '../services/reading';

/** Poll cadence while a TTS job is pending/running (server contract:
 *  "poll every ~2s until done or failed"). */
const STORY_AUDIO_POLL_MS = 2000;

/**
 * Poll attempt ceiling — bounded churn for a never-settling job (the
 * MyAudioDetail precedent). 150 ticks × 2s = 5 minutes, generous against a
 * short story's real synthesis time; the last known status stays on screen
 * and a reopen restarts the budget.
 */
const STORY_AUDIO_POLL_MAX_TICKS = 150;

/** Fixed fallback copy for a failed audio REQUEST (errorCopy contract). */
const AUDIO_REQUEST_FAILED_COPY = 'Could not request audio. Try again.';

/** Fixed fallback shown for a `failed` envelope whose `error` is null
 *  (defensive — the server settles a failure with copy, but never trust
 *  a nullable field to be populated). */
export const AUDIO_FAILED_FALLBACK_COPY = 'Audio generation failed. Try again.';

/** The empty envelope — what a hydrate failure degrades to (the button
 *  shows; the POST is idempotent, so a tap on an already-voiced story just
 *  returns the done envelope — self-healing). */
const NO_STORY_AUDIO: StoryAudio = {
  status: 'none',
  jobId: null,
  error: null,
  track: null,
  segments: [],
};

/**
 * F-210 story-audio state machine: hydrate once on mount (an already-voiced
 * story shows its player immediately), POST on demand, poll the GET every
 * `STORY_AUDIO_POLL_MS` while a job is pending/running, and stop on settle
 * (done/failed), unmount, a terminal mid-poll 404, or the tick ceiling.
 * Every request is abortable; cleanup aborts in-flight calls so a closed
 * reader never lands a late setState (the page-wide contract).
 *
 * Error copy: the daily-cap 429 (no `retryAfter`) and a `failed` envelope's
 * `error` are server-authored WHITELISTED copy shown verbatim — the F-210
 * contract's sanctioned exception to the fixed-copy rule (see
 * services/reading.ts `requestStoryAudio`). Everything else routes through
 * `errorMessageFor` as usual.
 */
export function useStoryAudio(storyId: number): {
  /** Latest envelope, or null while the mount hydrate is in flight. */
  audio: StoryAudio | null;
  /** True while the POST itself is in flight (pre-202 button busy state). */
  requesting: boolean;
  /** Request failure copy (429 cap verbatim / fixed copy), or null. */
  requestError: string | null;
  requestAudio: () => void;
  /** F-216 — imperatively land a fresh envelope from OUTSIDE this hook's
   *  own request path (the combined-experience POST's audio half). Pure
   *  setState: a pending/running envelope flips `polling` and starts the
   *  bounded poll exactly as `requestAudio`'s 202 would; a settled one
   *  renders directly. The hydrate/poll/abort lifecycle is untouched. */
  seed: (env: StoryAudio) => void;
} {
  const [audio, setAudio] = useState<StoryAudio | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const hydrateCtrlRef = useRef<AbortController | null>(null);
  const pollTickCtrlRef = useRef<AbortController | null>(null);
  const requestCtrlRef = useRef<AbortController | null>(null);

  // Hydrate once per story: a `done` shows the player with no click; a
  // `pending`/`running` (requested in an earlier session) resumes polling.
  useEffect(() => {
    const ctrl = new AbortController();
    hydrateCtrlRef.current?.abort();
    hydrateCtrlRef.current = ctrl;
    getStoryAudio(storyId, ctrl.signal)
      .then((env) => {
        if (ctrl.signal.aborted) return;
        setAudio(env);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        // Degrade to 'none' rather than blocking the reader behind an audio
        // status probe: the button renders, and the idempotent POST
        // self-heals (an already-voiced story answers 200 done).
        setAudio(NO_STORY_AUDIO);
      });
    return () => {
      ctrl.abort();
    };
  }, [storyId]);

  // Poll while a job is unsettled — per-tick abort-before-fetch, transient
  // failures retried next tick, terminal 404 (story deleted mid-poll) stops
  // immediately, and the interval + in-flight tick both die on unmount
  // (MyAudioDetail's exact posture).
  const status = audio?.status;
  const polling = status === 'pending' || status === 'running';
  useEffect(() => {
    if (!polling) return;
    let ticks = 0; // effect-local — every (re)start gets a fresh budget
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > STORY_AUDIO_POLL_MAX_TICKS) {
        window.clearInterval(id);
        return;
      }
      pollTickCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollTickCtrlRef.current = ctrl;
      getStoryAudio(storyId, ctrl.signal)
        .then((env) => {
          if (ctrl.signal.aborted) return;
          // Settling to done/failed flips `polling` false → effect teardown
          // clears this interval.
          setAudio(env);
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
    }, STORY_AUDIO_POLL_MS);
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

  const requestAudio = useCallback((): void => {
    requestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    requestCtrlRef.current = ctrl;
    setRequesting(true);
    setRequestError(null);
    requestStoryAudio(storyId, ctrl.signal).then(
      (env) => {
        if (ctrl.signal.aborted) return;
        setRequesting(false);
        // 202 lands a pending/running envelope (polling starts via the
        // effect above); 200 lands `done` directly (already voiced).
        setAudio(env);
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
          // The DAILY TTS cap — server-authored whitelisted copy, shown
          // verbatim per the F-210 contract ("try again tomorrow"); the
          // button stays available. A short-window 429 carries `retryAfter`
          // and falls through to errorMessageFor's structured copy instead.
          setRequestError(err.message);
          return;
        }
        setRequestError(errorMessageFor(err, AUDIO_REQUEST_FAILED_COPY));
      },
    );
  }, [storyId]);

  const seed = useCallback((env: StoryAudio): void => {
    // A seeded envelope supersedes any earlier per-asset failure — clear the
    // stale error so a capped experience half doesn't render two alerts.
    setRequestError(null);
    setAudio(env);
  }, []);

  return { audio, requesting, requestError, requestAudio, seed };
}
