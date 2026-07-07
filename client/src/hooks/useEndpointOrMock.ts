/**
 * useEndpointOrMock — single-line mock ↔ real-endpoint swap for screens.
 *
 * Mock-fallback contract (per CLAUDE_DESIGN_INTEGRATION_PLAN Pass 2):
 *
 *   const { data, loading, error, isMock, refetch } =
 *     useEndpointOrMock('today', loadTodayMock, { realFn: fetchTodayPlan });
 *
 * Behaviour:
 *   - `realFn` provided → call it first. On success, `data` is the real value
 *     and `isMock` stays false.
 *   - `realFn` omitted → fall back to `mockFn` (an explicit mock-only source;
 *     the screen was never wired to a real endpoint). `isMock` flips true on
 *     the mock resolve.
 *   - `realFn` rejects in DEV → fall back to `mockFn` (the 🅂 badge shows, so
 *     a developer can't mistake fixture data for real). `error` still
 *     reflects the real call's failure so error paths get exercised.
 *   - `realFn` rejects in PROD → **NO mock fallback.** `data` stays null and
 *     `error` carries the failure, so the consuming screen shows its error
 *     state. The old behaviour silently resolved the fixture — and because
 *     `MockBadge` renders null in prod, the page painted fabricated data
 *     indistinguishable from real (expired session → "24 reviews due" from a
 *     fixture, no error, no badge). Fabricated-data-as-real is the worst
 *     available failure mode; an honest error card is strictly better.
 *   - `error` reflects the **real** call's failure, even when DEV then falls
 *     back to the mock — the screen still renders something, but the toast
 *     layer (Pass 3) gets to surface the original failure.
 *   - On unmount, an `AbortController` cancels any in-flight call. StrictMode
 *     double-mount is safe — the first effect's controller aborts before the
 *     second effect's controller is created.
 *   - `key` changes trigger a full re-fetch. `mockFn`/`realFn`/`opts`
 *     identity changes do NOT — by design. The convention is to define the
 *     loader at module scope (mock files do this), or to memoise it caller-
 *     side. Re-running on every render-new function would cause an infinite
 *     loop.
 *   - **Key changes reset `data` and `isMock` to their initial values
 *     immediately** (data → null, isMock → false), so the consuming screen
 *     never paints stale data + lying `MockBadge` while a key-driven
 *     refetch is in flight. The previous loading skeleton appears on cue.
 *   - **`refetch()`** re-runs the loader without changing the key — used by
 *     screens to wire `<ErrorCard onRetry={…}>` to a real re-fetch instead
 *     of `window.location.reload()`. Like effect-driven runs, it aborts any
 *     in-flight call and resets `data`/`isMock`/`error`.
 *
 * Why this shape:
 *   - One hook covers all 11 screens; the Pass 2 plan says "swap mock → real
 *     endpoint in one line". This is that line.
 *   - `isMock` drives the dev-only 🅂 corner badge so screens can't silently
 *     ship without a real endpoint.
 *   - Errors are typed (`ApiError`) so error UI can branch on `code`/`status`.
 *
 * Threat model (Pass 3+ as `realFn` wires real network calls):
 *   - **Stale-data flash on key change.** Old behaviour leaked the previous
 *     fetch's `data` and `isMock` across `key` boundaries — a screen could
 *     paint last visit's data with the wrong-key MockBadge while the new
 *     fetch ran. This pass resets both eagerly on every key change so the
 *     transition is honest. Mitigates a user trust footgun, not a CIA
 *     property.
 *   - **`isMock` lying in PROD.** `MockBadge` is gated on `import.meta.env.PROD`
 *     so a stuck `isMock=true` never reaches end-users. The internal value
 *     can still mislead a dev; the eager reset on key change closes that gap.
 *   - **Fixture-as-real in PROD.** Because the badge is dev-only, a prod
 *     real-call failure that fell back to the fixture would paint fabricated
 *     data with no visible tell. The real-failure mock fallback is therefore
 *     gated to non-PROD builds (see `run` below); in prod a real failure
 *     surfaces as `error` + `data: null` and the screen's error/retry path
 *     takes over. Mock-only sources (no `realFn`) are unaffected — they are
 *     an explicit choice, not a silent substitution.
 *   - **Error-shape divergence between mock and real.** The mock loaders
 *     resolve happy paths only. `realFn` may reject with an `ApiError`
 *     bearing a `code`/`status` the mock branch never sees. The hook's
 *     contract: `error` always carries the **real** call's failure when one
 *     occurred, so error-handling code paths get exercised even when the
 *     screen paints the mock fallback underneath.
 *   - **Race on key change.** Two near-simultaneous key changes can produce
 *     interleaved resolves. The effect cleanup aborts the previous
 *     controller before the new one runs, and every async hop guards on
 *     `signal.aborted` before calling `safeSet`. The aborted promise's
 *     `safeSet` is a no-op; the live promise wins.
 *   - **Retry after a `refetch()` abort.** `refetch()` triggers the same
 *     reset+run path, so a Retry button never inherits the previous run's
 *     error. The latest call's settle wins.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';

/** State the hook surfaces to the consuming component. */
export interface UseEndpointOrMockResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** True iff the returned `data` came from `mockFn`, not `realFn`. */
  isMock: boolean;
  /**
   * Re-run the loader without changing the `key`. Aborts any in-flight
   * call, resets `data` / `isMock` / `error`, and re-enters the run path.
   * Returns a Promise that resolves when the new run settles (or aborts).
   */
  refetch: () => void;
}

/** Optional realFn override — when present, the hook prefers it over the mock. */
export interface UseEndpointOrMockOptions<T> {
  realFn?: () => Promise<T>;
}

/**
 * AbortController-aware promise wrapper.
 *
 * The hook's `realFn` / `mockFn` are user-supplied and the contract doesn't
 * require them to be abortable. We honour the abort signal at the *callback
 * level* — if the caller aborts before the promise resolves, we throw the
 * canonical "canceled" `ApiError` and the consumer's setState branches bail.
 */
async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new ApiError('request canceled', { status: 0, code: 'canceled' });
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ApiError('request canceled', { status: 0, code: 'canceled' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    return new ApiError(err.message, { status: 0, code: 'unknown' });
  }
  return new ApiError('unknown error', { status: 0, code: 'unknown' });
}

/**
 * Fetches `realFn` if present; otherwise falls back to `mockFn`. `key`
 * controls cache-busting — change it to force a refetch.
 *
 * The hook returns immediately with `{ data: null, loading: true, ... }` and
 * settles on either a real or mock value. Abort on unmount.
 */
export function useEndpointOrMock<T>(
  key: string,
  mockFn: () => Promise<T>,
  opts?: UseEndpointOrMockOptions<T>,
): UseEndpointOrMockResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [isMock, setIsMock] = useState<boolean>(false);
  // Monotonic tick — bumped by `refetch()` so the effect re-runs even
  // when `key` is unchanged. The effect dep array reads `[key, tick]`.
  const [tick, setTick] = useState<number>(0);

  // Latest-call tracking: each fetch gets its own controller; the effect
  // cleanup aborts the previous one. StrictMode's double-mount means the
  // first effect's controller is aborted before the second runs — we read
  // `signal.aborted` after every async hop to bail out cleanly.
  const ctrlRef = useRef<AbortController | null>(null);

  // Stash the latest loader callbacks in refs so a `refetch()` between
  // renders sees the freshest closures without forcing every consumer to
  // memoise them. The effect itself still uses ref values, not the
  // captured props directly, so the dep array can stay minimal.
  const mockFnRef = useRef<() => Promise<T>>(mockFn);
  const realFnRef = useRef<(() => Promise<T>) | undefined>(opts?.realFn);
  // Sync the latest loader closures into refs from an effect — assigning
  // to `ref.current` during render trips `react-hooks/refs`. The main run
  // effect's deps stay `[key, tick]`, so by the time it re-runs the
  // sync effect has already landed the fresh closure.
  useEffect(() => {
    mockFnRef.current = mockFn;
    realFnRef.current = opts?.realFn;
  });

  useEffect(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    // Reset to loading on every key change AND on every refetch tick.
    // Eager `data`/`isMock` reset closes the "stale data + lying badge"
    // window between the old fetch's settle and the new one's settle.
    // Sync-to-external-system case — same as AuthProvider's initial probe.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setData(null);
    setIsMock(false);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Local helper — sets state only if this effect's controller hasn't
    // been aborted. Saves us writing the same guard at every hop.
    const safeSet = (next: {
      data?: T | null;
      isMock?: boolean;
      error?: ApiError | null;
    }): void => {
      if (ctrl.signal.aborted) return;
      if (next.data !== undefined) setData(next.data);
      if (next.isMock !== undefined) setIsMock(next.isMock);
      if (next.error !== undefined) setError(next.error);
    };

    const run = async (): Promise<void> => {
      let realError: ApiError | null = null;
      const realFn = realFnRef.current;
      const mockFn = mockFnRef.current;

      if (realFn) {
        try {
          const real = await raceAgainstAbort(realFn(), ctrl.signal);
          safeSet({ data: real, isMock: false, error: null });
          if (!ctrl.signal.aborted) setLoading(false);
          return;
        } catch (err) {
          if (ctrl.signal.aborted) return;
          realError = toApiError(err);
          // Don't surface a `canceled` from a stale unmount as an error —
          // but here we are guaranteed not aborted (guarded above), so any
          // `canceled` is real (e.g. caller aborted internally). Preserve.

          // PROD: a real-endpoint failure must SURFACE, never be papered
          // over with fixture data. MockBadge is dev-only, so a prod mock
          // fallback would render fabricated data indistinguishable from
          // real (see threat model above). Propagate the error; the screen
          // renders its error state + retry.
          if (import.meta.env.PROD) {
            safeSet({ data: null, isMock: false, error: realError });
            if (!ctrl.signal.aborted) setLoading(false);
            return;
          }
        }
      }

      // Either no realFn was provided (explicit mock-only source), or realFn
      // rejected in a NON-PROD build (badge visible). Fall back to mock.
      try {
        const mocked = await raceAgainstAbort(mockFn(), ctrl.signal);
        safeSet({ data: mocked, isMock: true, error: realError });
        if (!ctrl.signal.aborted) setLoading(false);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const mockError = toApiError(err);
        // Mock failure dominates — the screen has no data to render.
        safeSet({ data: null, isMock: false, error: mockError });
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };

    void run();

    return () => {
      ctrl.abort();
    };
    // `key` is the explicit refetch trigger; `tick` is bumped by
    // `refetch()`. `mockFn` / `realFn` identity is deliberately excluded
    // — see the JSDoc header for the rationale. Their latest values are
    // read via refs inside `run`.
  }, [key, tick]);

  const refetch = useCallback((): void => {
    setTick((t) => t + 1);
  }, []);

  return { data, loading, error, isMock, refetch };
}
