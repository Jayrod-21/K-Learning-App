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
 * TWO different 429s reach this route and must not share copy: the image
 * endpoints also sit behind the generic short-window rate limiter, whose
 * 429 carries the structured `retry_after` (a seconds-scale wait), while
 * the per-user DAILY VISION CAP (a cost control) does not — that one
 * really is "try again tomorrow". `retryAfter` presence is the
 * discriminator (both use code `rate_limited` on some paths, so the code
 * field cannot disambiguate).
 */
export function imageUploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      // Short-window limiter (retry_after present) vs the daily cap. Only
      // the STRUCTURED retry_after number is interpolated — never prose.
      return err.retryAfter !== undefined
        ? `Rate-limited. Try again in about ${String(Math.ceil(err.retryAfter))} seconds.`
        : "You've hit today's image limit. Try again tomorrow.";
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

/**
 * Fixed copy for a failed BOOK upload (`POST /uploads`, U1 — see
 * services/uploads.ts). Mirrors `imageUploadErrorMessage`'s shape: the
 * per-user DAILY upload cap (an abuse/cost backstop) carries NO
 * `retry_after`, while the short-window rate limiter's 429 does —
 * `retryAfter` presence is the discriminator, same reasoning as that
 * function's doc.
 */
export function bookUploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return err.retryAfter !== undefined
        ? `Rate-limited. Try again in about ${String(Math.ceil(err.retryAfter))} seconds.`
        : "You've hit today's upload limit. Try again tomorrow.";
    }
    if (err.status === 413) {
      return 'That PDF is too large. Pick one under 15 MB.';
    }
    if (err.status === 400) {
      return 'That file isn’t a valid PDF. Choose a different file.';
    }
    if (err.code === 'network') {
      return 'Network unreachable. Check your connection and try again.';
    }
  }
  return 'Upload failed. Try again.';
}
