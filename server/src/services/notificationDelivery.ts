/**
 * notificationDelivery — the atomic claim + settle primitives for
 * `notification_deliveries` (F-092), ahead of any actual sender/worker.
 *
 * WHY THIS EXISTS BEFORE A SENDER DOES: 052 shipped `notification_deliveries`
 * as an empty log table with a "probe newest, then insert" idempotency
 * sketch in its header comment — read the newest delivery row for a
 * schedule, and if nothing looks like "already sent this firing", insert a
 * pending one. That is a read-then-write race: two concurrent sender workers
 * (a cron-tick overlap, a redeploy racing the previous process's tail, a
 * horizontally-scaled worker pool) can both probe, both see nothing, and
 * both insert — a double-send to the user. Migration 063 adds a `window_start`
 * column plus a `UNIQUE (schedule_id, window_start)` constraint so the INSERT
 * itself is the arbiter, not a prior SELECT: `claimDelivery` below is an
 * `INSERT ... ON CONFLICT DO NOTHING`, which Postgres resolves atomically at
 * the unique-index level — exactly one concurrent caller ever gets a row back
 * for the same (schedule, firing window) pair, no matter how many race it.
 *
 * SCOPE: this module is ONLY the claim/settle primitives. No scheduler picks
 * "which schedules are due right now", no worker loop, no actual
 * push/email/SMS transport — that is the F-040 sender phase, a later ticket.
 * This is the guard rail so that phase can be added without re-litigating
 * the concurrency story.
 *
 * SECURITY / correctness:
 *   - All SQL is parameterized (no string interpolation of caller input).
 *   - `claimDelivery` never trusts a caller-supplied "is this claimed"
 *     boolean — the ONLY signal is whether the INSERT returned a row.
 *   - `settleDelivery`'s UPDATE is gated on `status = 'pending'`, so a
 *     settle call can only ever transition a row ITS OWN claim produced
 *     (or another party's still-pending claim, but never re-settle an
 *     already-terminal row) — the "UPDATE ... WHERE unclaimed" half of the
 *     claim pattern, guarding against a duplicate/late settle call
 *     double-writing a terminal status.
 */
import { query } from '../db/pool.js';

export interface ClaimDeliveryResult {
  /** True iff THIS call won the claim (the INSERT produced a row). */
  claimed: boolean;
  /** The claimed row's id, or null when another caller already holds the
   *  claim for this (scheduleId, windowStart) pair. */
  deliveryId: number | null;
}

/**
 * Atomically claim a schedule's firing window. Exactly one concurrent caller
 * racing the SAME (scheduleId, windowStart) pair receives `claimed: true` —
 * Postgres's `ON CONFLICT (schedule_id, window_start) DO NOTHING` resolves
 * the race at the unique-index level; there is no probe-then-insert gap for
 * two workers to both slip through.
 *
 * `windowStart` is the firing's OWN identity (e.g. the minute-truncated
 * instant a sender determines a schedule was due for THIS cycle) — it must
 * be identical across every worker racing the same firing, which is exactly
 * what the UNIQUE constraint keys on (see migration 063's header for why
 * this can't just be `created_at`).
 */
export async function claimDelivery(
  scheduleId: number,
  windowStart: Date,
): Promise<ClaimDeliveryResult> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO notification_deliveries (schedule_id, window_start, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (schedule_id, window_start) DO NOTHING
     RETURNING id`,
    [scheduleId, windowStart.toISOString()],
  );
  const row = rows[0];
  if (row === undefined) {
    return { claimed: false, deliveryId: null };
  }
  return { claimed: true, deliveryId: row.id };
}

export type DeliveryOutcome =
  | { status: 'sent'; sentAt: Date; providerRef?: string }
  | { status: 'failed' }
  | { status: 'skipped' };

/**
 * Transition a claimed (pending) delivery to its terminal outcome.
 *
 * Gated on `status = 'pending'` — the "UPDATE ... WHERE unclaimed" half of
 * the claim pattern: this can only ever settle a row that is STILL pending,
 * so a duplicate settle call (a retried send, a crashed-and-resumed worker
 * replaying its last step) is a no-op (`settled: false`) rather than a
 * second write clobbering whatever terminal status the first settle already
 * recorded. Mirrors the 052 CHECK that a 'sent' row must carry `sent_at`
 * (ck_notification_deliveries_sent_has_sent_at) — the 'sent' branch here is
 * the only one that supplies it.
 */
export async function settleDelivery(
  deliveryId: number,
  outcome: DeliveryOutcome,
): Promise<{ settled: boolean }> {
  const sentAt = outcome.status === 'sent' ? outcome.sentAt.toISOString() : null;
  const providerRef =
    outcome.status === 'sent' ? outcome.providerRef ?? null : null;
  const { rowCount } = await query(
    `UPDATE notification_deliveries
        SET status = $1, sent_at = $2, provider_ref = $3
      WHERE id = $4 AND status = 'pending'`,
    [outcome.status, sentAt, providerRef, deliveryId],
  );
  return { settled: rowCount === 1 };
}
