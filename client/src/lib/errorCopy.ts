/**
 * errorCopy — the app-wide fixed-copy error message helper (F-UP-018).
 *
 * Contract (mirrors `Login.messageFor` / `Writing.messageFor` / ErrorCard's
 * own doc): user-facing error text is ALWAYS author-controlled. A server
 * `ApiError.message` is server prose — it may leak upstream/driver detail
 * and drifts per deploy — so it is never echoed into the UI. Instead, the
 * structured fields (`code`, `status`, `retryAfter`) select from this fixed
 * lookup, and everything else falls back to the caller's own fixed copy.
 *
 * Before this helper, ~8 pages inlined the pattern
 * `err instanceof ApiError ? err.message : '<fallback>'`, which echoed
 * server prose whenever the error WAS an ApiError — the exact opposite of
 * the contract the fixed-copy pages follow. Those call sites now route
 * through here, so the whole app is consistent in one place.
 *
 * Threat model:
 *   - Info leakage: raw server messages (constraint names, upstream SDK
 *     errors, stack fragments) never reach the DOM. Only the numeric
 *     `retryAfter` is interpolated — a number, not prose.
 *   - XSS: all output is rendered via React text children (escaped), same
 *     as before; this helper removes the *content* risk, not just markup.
 */
import { ApiError } from '../services/api';

/**
 * Fixed user-facing copy for a failed request. `fallback` is the caller's
 * own author-controlled copy for the generic case ("Could not load the
 * list.") — it is returned verbatim whenever no structured field gives a
 * more specific fixed message.
 */
export function errorMessageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
    if (err.code === 'timeout') {
      return 'The request timed out. Try again in a moment.';
    }
    if (err.status === 401) {
      return 'Your session has expired. Sign in again.';
    }
    if (err.status === 429) {
      // Only the STRUCTURED retry_after number is interpolated — never prose.
      return err.retryAfter !== undefined
        ? `Rate-limited. Try again in about ${String(Math.ceil(err.retryAfter))} seconds.`
        : 'Rate-limited right now. Wait a moment and try again.';
    }
  }
  return fallback;
}

/**
 * Fixed copy for a failed IMAGE upload (the OCR pipeline behind both the
 * Images screen's `POST /images/ocr` and Chat's
 * `POST /conversation/:id/image` — chat rework Slice 3). Keyed on the
 * structured status/code only; server prose is never echoed. Shared so the
 * two upload surfaces can't drift apart on copy.
 *
 * 429 here is the per-user DAILY VISION CAP (a cost control), not the
 * generic short-window rate limit — hence the "today's limit" phrasing
 * instead of `errorMessageFor`'s retry-in-N-seconds line.
 */
export function imageUploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return "You've hit today's image limit. Try again tomorrow.";
    }
    if (err.status === 413) {
      return 'That image is too large. Pick one under 8 MB.';
    }
    if (err.status === 400) {
      return 'That file isn’t a supported image. Use a JPEG, PNG, or WebP.';
    }
    if (err.status === 502) {
      return 'OCR is temporarily unavailable. Try again shortly.';
    }
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
  }
  return 'Upload failed. Try again.';
}
