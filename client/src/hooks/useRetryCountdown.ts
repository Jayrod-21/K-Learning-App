/**
 * useRetryCountdown — a ticking seconds-remaining countdown for rate-limit
 * backoff (F-006 fix-pass, client SF-2).
 *
 * Server 429s carry a structured `retry_after` (seconds), surfaced as
 * `ApiError.retryAfter`. Affordances that can be re-fired (the resend
 * verification button/form) call `start(err.retryAfter ?? FALLBACK)` on a 429
 * and disable themselves while `secondsLeft > 0`, so the user cannot hammer a
 * rate-limited endpoint click-by-click — mirroring Login's 423 lockout
 * handling. The value is a STRUCTURED NUMBER from the server, never echoed
 * prose, so rendering it does not violate the fixed-error-string rule.
 */
import { useEffect, useState } from 'react';

/** Backoff to assume when a 429 carries no usable retry_after. */
export const RETRY_FALLBACK_SECONDS = 30;

export function useRetryCountdown(): {
  /** Whole seconds until the affordance should re-enable; 0 = ready. */
  secondsLeft: number;
  /** Begin (or restart) the countdown. Non-finite/≤0 inputs use the fallback. */
  start: (seconds: number | undefined) => void;
} {
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => {
      setSecondsLeft((s) => (s > 1 ? s - 1 : 0));
    }, 1000);
    return () => {
      clearTimeout(id);
    };
  }, [secondsLeft]);

  function start(seconds: number | undefined): void {
    const n =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds)
        : RETRY_FALLBACK_SECONDS;
    setSecondsLeft(n);
  }

  return { secondsLeft, start };
}
