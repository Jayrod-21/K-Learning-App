/**
 * grammarScheduler — the grammar-drill-specific half of server-derived FSRS
 * scheduling (FU-NF-42).
 *
 * A grammar production drill has NO learner self-rating step — it is
 * SERVER-scored by Claude (verdict + score). This module owns exactly that
 * divergence: mapping the drill verdict (+ pattern-usage check) onto a
 * canonical FSRS rating. The state-transition math itself lives in the shared
 * engine (services/fsrs.ts) that the vocab review route also calls — extracted
 * from here so the two paths cannot drift (FU-NF-45, first step). Historical
 * context for the divergence is documented in ADR-003's amendments.
 *
 * PURE module — no I/O, no clock, no DB. The route owns the clock.
 *
 * THREAT MODEL (the inputs are NOT user-controlled, but defend anyway):
 *   - `verdict`/`usesPattern` come from the server's own Claude scoring result,
 *     not from request body. The shared engine additionally clamps/floors every
 *     output so even a garbage `current` (e.g. a corrupted row) can never
 *     produce an out-of-CHECK value — see services/fsrs.ts.
 */
import type { DrillVerdict } from './claudeProxy.js';
import type { FsrsRating } from './fsrs.js';

// Re-export the shared engine surface so existing consumers/tests keep a single
// import site for "grammar scheduling" (mapping + math together).
export {
  schedule,
  type CardFsrs,
  type FsrsRating,
  type FsrsStateName,
  type NextFsrs,
} from './fsrs.js';

/**
 * Map a drill verdict (+ whether the answer actually used the target pattern) to
 * an FSRS rating.
 *
 *   incorrect  → again
 *   needs_work → hard
 *   good       → good
 *   excellent  → easy
 *
 * OVERRIDE: `usesPattern === false` forces `again` regardless of the verdict.
 * If the learner produced a fluent, correct Korean sentence that DOESN'T use the
 * pattern being drilled, they have not demonstrated the target skill — the
 * production card must not advance. This is the one place fluency is deliberately
 * subordinated to pattern usage.
 */
export function ratingFromVerdict(verdict: DrillVerdict, usesPattern: boolean): FsrsRating {
  if (!usesPattern) return 'again';
  switch (verdict) {
    case 'incorrect':
      return 'again';
    case 'needs_work':
      return 'hard';
    case 'good':
      return 'good';
    case 'excellent':
      return 'easy';
    default: {
      // Exhaustiveness guard: DrillVerdict is a closed union. If a new variant is
      // added without updating this map, fail loudly rather than silently
      // mis-scheduling — the verdict is server-sourced so this is an invariant.
      const _exhaustive: never = verdict;
      throw new Error(`unhandled drill verdict: ${String(_exhaustive)}`);
    }
  }
}
