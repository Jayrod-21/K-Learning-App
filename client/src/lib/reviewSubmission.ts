/**
 * reviewSubmission — build the wire payload for `POST /vocab/cards/:id/reviews`
 * from the UI's "rating only" gesture.
 *
 * Server-authoritative scheduling (ADR-003 amendment, 2026-07-02): the client
 * sends ONLY the rating + the card's optimistic-concurrency version snapshot.
 * The server reads the card's current FSRS state from the DB, runs the shared
 * FSRS engine, and computes `due_at` itself — the old Pass-3 stub that echoed
 * `*_before` back as `*_after` with `scheduled_days_after: 0` (making every
 * rated card due immediately) is gone, and no client value can dictate the
 * schedule anymore.
 *
 * Lives in lib/ (not pages/Review.tsx) so the payload contract is directly
 * unit-testable without violating react-refresh/only-export-components.
 */
import type { DueCard, FsrsRating, ReviewSubmission } from '../types/domain';

export function buildReviewSubmission(card: DueCard, rating: FsrsRating): ReviewSubmission {
  return {
    rating,
    // D-B1 fix: thread the per-card version snapshot rather than hardcoding
    // `1`. Without this, every second rating of any card 409s on stale
    // version and breaks the FSRS learning loop.
    expected_version: card.version,
  };
}
