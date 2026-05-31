/**
 * ToastProvider — owns the global toast queue and renders the live toasts
 * into a fixed portal region above the BottomNav.
 *
 * Mirrors the `ThemeProvider` / `SettingsProvider` shape: a context object
 * lives in `toast-context.ts`, the hook in `useToast.ts`, and this file
 * holds the stateful provider + the presentational mount. The split keeps
 * `react-refresh/only-export-components` happy.
 *
 * Design decisions:
 *   - **Stacking cap.** At most `MAX_VISIBLE` (3) toasts render at once.
 *     Overflow is queued, not dropped — when a visible toast dismisses, the
 *     oldest queued one promotes in. This caps screen real-estate without
 *     silently losing a failure notice.
 *   - **Auto-dismiss with pause.** Each visible toast runs a `setTimeout`.
 *     Hover/focus pauses it (clears the timer + banks the remaining time);
 *     leaving resumes from the banked remainder. Sticky toasts
 *     (`durationMs <= 0`) never arm a timer.
 *   - **Tone-tuned defaults.** Errors default to a longer dwell (8s) than
 *     success/info (5s) — a failure the user must read shouldn't vanish as
 *     fast as a confirmation.
 *   - **Cleanup.** Every armed timer is cleared on unmount; promoting/
 *     dismissing always clears the relevant timer first, so no orphaned
 *     timer ever fires into an unmounted tree.
 *
 * Threat model: `message` is author-controlled (see `ToastOptions`) — this
 * provider never inspects or echoes server text. Ids are minted from a
 * monotonic counter (NOT `Math.random()`/`Date.now()` in render), so two
 * toasts in the same tick never collide and render stays pure.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Toast } from './Toast';
import {
  ToastContext,
  type ToastContextValue,
  type ToastOptions,
  type ToastRecord,
  type ToastTone,
} from './toast-context';

/** Most toasts visible at once; the rest queue behind them. */
const MAX_VISIBLE = 3;

/** Default auto-dismiss dwell per tone, in ms. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  error: 8000,
  success: 5000,
  info: 5000,
};

export function ToastProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // The full ordered list — visible (first MAX_VISIBLE) + queued (the rest).
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  // Monotonic id source. A ref (not state) because bumping it must not
  // re-render, and reading it must not happen in render — only inside the
  // `toast()` event callback. Avoids Date.now()/Math.random() entirely.
  const seqRef = useRef(0);

  // Per-toast auto-dismiss bookkeeping, keyed by id:
  //   - `timer`     — the live setTimeout handle (null while paused).
  //   - `remaining` — ms left to run; re-banked on each pause.
  //   - `startedAt` — performance.now() when the current run armed, so a
  //                   pause can compute the elapsed slice.
  // Kept in a ref so timer churn never triggers a render.
  const timersRef = useRef<
    Map<string, { timer: number | null; remaining: number; startedAt: number }>
  >(new Map());

  const dismiss = useCallback((id: string): void => {
    const entry = timersRef.current.get(id);
    if (entry?.timer !== null && entry !== undefined) {
      window.clearTimeout(entry.timer);
    }
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Arm (or re-arm) the countdown for a toast. Sticky toasts (remaining <= 0)
  // never arm. Safe to call repeatedly; clears any prior timer first.
  const arm = useCallback(
    (id: string, remaining: number): void => {
      const existing = timersRef.current.get(id);
      if (existing?.timer != null) window.clearTimeout(existing.timer);
      if (remaining <= 0) {
        // Sticky — record the state but never schedule a dismiss.
        timersRef.current.set(id, {
          timer: null,
          remaining,
          startedAt: performance.now(),
        });
        return;
      }
      const timer = window.setTimeout(() => {
        dismiss(id);
      }, remaining);
      timersRef.current.set(id, {
        timer,
        remaining,
        startedAt: performance.now(),
      });
    },
    [dismiss],
  );

  const pause = useCallback((id: string): void => {
    const entry = timersRef.current.get(id);
    if (!entry || entry.timer == null) return; // sticky or already paused
    window.clearTimeout(entry.timer);
    const elapsed = performance.now() - entry.startedAt;
    timersRef.current.set(id, {
      timer: null,
      remaining: Math.max(0, entry.remaining - elapsed),
      startedAt: entry.startedAt,
    });
  }, []);

  const resume = useCallback(
    (id: string): void => {
      const entry = timersRef.current.get(id);
      // Only resume a toast that's paused (timer null) and still has a
      // finite, positive remainder — sticky toasts (remaining 0) stay put.
      if (!entry || entry.timer != null || entry.remaining <= 0) return;
      arm(id, entry.remaining);
    },
    [arm],
  );

  const toast = useCallback(
    (opts: ToastOptions): string => {
      const tone: ToastTone = opts.tone ?? 'error';
      const durationMs = opts.durationMs ?? DEFAULT_DURATION[tone];
      const id = `toast-${String((seqRef.current += 1))}`;
      const record: ToastRecord = {
        id,
        message: opts.message,
        tone,
        action: opts.action,
        durationMs,
      };
      setToasts((prev) => [...prev, record]);
      return id;
    },
    [],
  );

  // Arm timers for newly-visible toasts; the timer map is the source of
  // truth for "already armed". We key the effect on the visible slice so a
  // toast promoted from the queue (because a sibling dismissed) gets its
  // countdown started exactly once, when it first becomes visible.
  const visible = toasts.slice(0, MAX_VISIBLE);
  useEffect(() => {
    for (const t of visible) {
      if (!timersRef.current.has(t.id)) {
        arm(t.id, t.durationMs);
      }
    }
    // `visible` is derived from `toasts`; depending on the id list keeps the
    // effect honest without re-running on unrelated state.
  }, [visible, arm]);

  // Clear every outstanding timer on unmount so none fire into a torn-down
  // tree. Snapshot the map ref in the cleanup per the exhaustive-deps lint
  // guidance (the ref identity is stable, but reading `.current` at cleanup
  // time is what we want here — the live map).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const entry of timers.values()) {
        if (entry.timer != null) window.clearTimeout(entry.timer);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport
        toasts={visible}
        onDismiss={dismiss}
        onPause={pause}
        onResume={resume}
      />
    </ToastContext.Provider>
  );
}

/**
 * The fixed portal region. Rendered to `document.body` so it escapes any
 * transformed/overflow-clipped ancestor and always layers above the app
 * chrome. Positioned above the BottomNav with a safe-area inset so it clears
 * the iOS home indicator. Empty list → render nothing (no stray region).
 */
function ToastViewport({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}): JSX.Element | null {
  // happy-dom / jsdom provide document.body; guard anyway so a non-browser
  // host (future SSR/pre-render) degrades to rendering nothing rather than
  // throwing on a missing portal target.
  if (typeof document === 'undefined' || !document.body) return null;
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="km-toast-viewport" aria-label="Notifications">
      {/* Newest on top of the stack — reverse so the latest toast sits
          closest to the user's thumb / the top of the cluster. */}
      {[...toasts].reverse().map((t) => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={onDismiss}
          onPause={onPause}
          onResume={onResume}
        />
      ))}
    </div>,
    document.body,
  );
}
