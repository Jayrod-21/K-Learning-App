/**
 * coerceId — shared guarded coercion for BIGINT ids crossing the wire
 * (F-204).
 *
 * Why this exists: Postgres BIGINT (`int8`) ids leave the server as JSON
 * **strings** today — `db/pool.ts` registers no int8 parser, and the
 * routes return rows raw — so every client service mapper has been doing a
 * bare `Number(row.id)` at its wire→domain boundary. Bare `Number()` is a
 * silent-junk factory: `Number('')` is `0`, `Number('abc')` is `NaN`, and
 * a string beyond 2^53 quietly loses precision — any of which then flows
 * into strict `===` cross-refs, URL paths, and cache keys as a plausible-
 * looking number. This helper is the ONE place that coercion happens, and
 * it fails LOUD: anything that isn't a positive safe integer throws.
 *
 * Accepts both `number` and `string` on purpose: F-203 will normalize ids
 * to JSON numbers server-side, at which point this becomes a cheap
 * invariant check instead of a conversion — call sites don't change.
 *
 * No I/O — pure validation over a caller-supplied value; the threat here
 * is data corruption (silent id mangling), not injection.
 */

/**
 * Coerce a wire id (`number` today-or-post-F-203, BIGINT-as-`string`
 * today) onto the numeric id the domain types declare.
 *
 * @throws Error if the value does not represent a positive safe integer
 *   (empty/non-numeric string, `NaN`, `Infinity`, zero, negatives,
 *   fractions, or magnitudes above `Number.MAX_SAFE_INTEGER` where int8
 *   precision would be lost).
 */
export function coerceId(v: number | string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid id from server: ${JSON.stringify(v)}`);
  }
  return n;
}
