/**
 * Toast context object + types. Kept separate from the Provider so the
 * React Refresh rule (`react-refresh/only-export-components`) stays clean
 * across `ToastProvider.tsx` and `useToast.ts` — the same split used by
 * `theme-context.ts` / `ThemeProvider.tsx`.
 */
import { createContext } from 'react';

/**
 * Visual + semantic tone of a toast.
 *   - `error`   → vermilion accent, `role="alert"` (assertive — interrupts).
 *   - `success` → moss accent, `aria-live="polite"`.
 *   - `info`    → ink accent, `aria-live="polite"`.
 */
export type ToastTone = 'error' | 'success' | 'info';

/** Optional inline action — e.g. a "Retry" button on a failed save. */
export interface ToastAction {
  /** Author-controlled button label. Keep it short ("Retry", "Undo"). */
  label: string;
  /**
   * Invoked when the user taps the action. The toast auto-dismisses after
   * the handler runs so the action can't be double-fired from one toast.
   */
  onClick: () => void;
}

export interface ToastOptions {
  /**
   * Human-readable line. Author-controlled — NEVER an echo of raw server
   * text (same contract as `ErrorCard`). Callers map error shapes to fixed
   * copy before they reach here, closing the XSS-via-error-string vector.
   */
  message: string;
  /** Tone — drives color + ARIA politeness. Defaults to `error`. */
  tone?: ToastTone;
  /** Optional inline action (retry, undo, …). */
  action?: ToastAction;
  /**
   * Auto-dismiss delay in ms. Defaults vary by tone (errors linger longer —
   * see `ToastProvider`). Pass `0` (or a negative number) to make the toast
   * sticky until the user dismisses it manually.
   */
  durationMs?: number;
}

/** A live toast — `ToastOptions` plus the provider-assigned identity. */
export interface ToastRecord extends ToastOptions {
  /** Stable id used as the React key and the `dismiss(id)` handle. */
  id: string;
  /** Resolved tone (default applied). */
  tone: ToastTone;
  /** Resolved auto-dismiss delay; `0` means sticky. */
  durationMs: number;
}

export interface ToastContextValue {
  /**
   * Enqueue a toast. Returns the assigned id so the caller can dismiss it
   * programmatically (e.g. clear a "saving…" toast once the save lands).
   */
  toast: (opts: ToastOptions) => string;
  /** Dismiss a specific toast by id. No-op if it's already gone. */
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
