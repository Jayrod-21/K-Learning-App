/**
 * /plan — the daily study plan that drives the Today screen.
 *
 * Threat model:
 *   - Auth required; cookie session rides via `withCredentials` on the shared
 *     axios instance. Read-only GET — no CSRF surface.
 *   - No path/query params are constructed from user input — the URL is a
 *     constant string.
 *   - The server returns plain data (titles, integer minutes, level labels);
 *     the screen renders them as React children (escaped). We never inject the
 *     response into HTML.
 *   - Rate limit: server `cheapLimiter` per user. The client does not retry on
 *     its own — `useEndpointOrMock`'s `refetch()` is user-driven.
 *
 * Shape note: the server speaks `dueCount`; the client domain type
 * (`TodayPlan`) speaks `reviewCount` (the field the Review queue card reads).
 * `fetchToday` is the single place that bridges the two so the screen stays on
 * the domain type. Task fields (title/mins/level/tag) and `largestGap` already
 * line up, so they pass through unchanged.
 */
import { api } from './api';
import type { Recommendation, TodayPlan, TodayTask } from '../types/domain';

/** Raw `GET /plan/today` envelope as the server sends it.
 *
 * `recommendation`/`alternatives` (F-212 Phase 4) are typed optional here —
 * additive server fields, so a not-yet-flipped blue/green color (or a cached
 * pre-P4 response) may legitimately omit them. `fetchToday` normalizes an
 * absent `recommendation` to `null`, which the Today screen already treats as
 * "no card, existing tiles carry the day" — deploy-order skew degrades to the
 * cold-start fallback instead of a type error. */
export interface PlanTodayResponse {
  dueCount: number;
  reading: TodayTask | null;
  listening: TodayTask | null;
  writing: TodayTask | null;
  largestGap: TodayTask['tag'] | null;
  recommendation?: Recommendation | null;
  alternatives?: Recommendation[];
}

/**
 * GET /plan/today — the composed daily plan.
 *
 * Maps the server envelope onto the `TodayPlan` domain type (`dueCount` →
 * `reviewCount`).
 *
 * The optional `signal` lets a direct caller cancel an in-flight request. The
 * Today screen intentionally does NOT pass one: it calls `fetchToday()` through
 * `useEndpointOrMock`, whose `realFn` contract is no-arg and which owns
 * cancellation itself (it drops the resolution via `raceAgainstAbort` on
 * unmount). The param is kept as cheap insurance for future direct callers and
 * to match the other services that accept a signal.
 */
export async function fetchToday(signal?: AbortSignal): Promise<TodayPlan> {
  const res = await api.get<PlanTodayResponse>(
    '/plan/today',
    signal !== undefined ? { signal } : undefined,
  );
  const plan: TodayPlan = {
    reviewCount: res.dueCount,
    reading: res.reading,
    listening: res.listening,
    writing: res.writing,
    largestGap: res.largestGap,
    // F-212 P4 — absent (older server color) and explicit null (cold-start)
    // both land on null: no card, existing tiles unchanged.
    recommendation: res.recommendation ?? null,
  };
  if (res.alternatives !== undefined) {
    plan.alternatives = res.alternatives;
  }
  return plan;
}
