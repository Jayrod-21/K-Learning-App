/**
 * Per-skill trend series (F-017 — Today's "Progress by skill" carousel).
 *
 * Assembles the five-skill `AllSkillSeries` from the four series endpoints
 * in one `Promise.all` fan-out:
 *
 *   GET /topik/series?days=N   → { reading, listening }   (two SkillSeries)
 *   GET /vocab/series?days=N   → { series }               (one SkillSeries)
 *   GET /grammar/series?days=N → { series }               (one SkillSeries)
 *   GET /writing/series?days=N → { series }               (one SkillSeries)
 *
 * Writing's route landed with F-014 (graded attempts persist server-side, so
 * a real per-day score series exists — normalized to % of the rubric max).
 *
 * Failure model — degrade per skill, NEVER fabricate:
 * `Promise.allSettled`, not `Promise.all`. A rejected route degrades that
 * skill (both TOPIK skills for the topik route) to the `metric: 'none'`
 * placeholder, so its panel honestly reads "No data yet" while the other
 * skills still show real data. A fresh placeholder object is built per call
 * (never a shared module-level constant) so no caller can mutate another's
 * series. The old all-or-nothing rejection propagated to
 * `useEndpointOrMock`, whose mock fallback then painted ALL FIVE panels with
 * hardcoded fixture numbers as if they were the user's real progress — for a
 * stats widget, fabricated data is the worst available failure mode. This
 * function therefore never rejects on a route failure (total outage = five
 * placeholder panels, still honest); the only rejection is cancellation via
 * the caller's `signal`, preserved so aborts stay aborts.
 *
 * Threat model:
 *   - **Auth + session.** All four routes are `requireAuth` server-side; the
 *     session cookie rides via `withCredentials` on the shared axios
 *     instance. No bearer token is read or echoed from JS.
 *   - **CSRF.** All four are GETs (no state change); the `SameSite=Strict`
 *     session cookie covers them regardless.
 *   - **Injection.** `days` is a caller-supplied number serialized by axios
 *     into the query string — never interpolated into the path — and the
 *     server re-validates/clamps it.
 *   - **Rendered text is escaped.** `unit` is server prose rendered as React
 *     children downstream, so a malicious payload becomes literal text, not
 *     markup.
 *
 * Signal note: the optional `signal` lets a direct caller cancel the whole
 * fan-out (one signal aborts all four requests). Like the other services,
 * the Today screen consumes this through `useEndpointOrMock` (no-arg
 * `realFn`), which owns cancellation itself — the param is for symmetry and
 * future direct callers.
 */
import { api, ApiError } from './api';
import type { AllSkillSeries, SkillSeries } from '../types/domain';

/** Envelope returned by `GET /topik/series` — two skills in one response. */
export interface TopikSeriesResponse {
  reading: SkillSeries;
  listening: SkillSeries;
}

/** Envelope of `GET /vocab/series`, `GET /grammar/series`, `GET /writing/series`. */
export interface SingleSeriesResponse {
  series: SkillSeries;
}

/**
 * Placeholder for a skill whose route failed — the carousel renders it as an
 * honest "No data yet" panel, never fixture numbers. Fresh object per call
 * so no caller can mutate another's series.
 */
function unavailableSeries(): SkillSeries {
  return { metric: 'none', unit: '', points: [] };
}

/**
 * Fetch all five skill trends for the last `days` days (server default 30).
 *
 * The four GETs run in parallel. A failed route degrades its skill(s) to the
 * `metric: 'none'` placeholder — this function only rejects when `signal`
 * aborts the fan-out.
 */
export async function fetchSkillSeries(
  days = 30,
  signal?: AbortSignal,
): Promise<AllSkillSeries> {
  const config = {
    params: { days },
    ...(signal !== undefined ? { signal } : {}),
  };

  const [topik, vocab, grammar, writing] = await Promise.allSettled([
    api.get<TopikSeriesResponse>('/topik/series', config),
    api.get<SingleSeriesResponse>('/vocab/series', config),
    api.get<SingleSeriesResponse>('/grammar/series', config),
    api.get<SingleSeriesResponse>('/writing/series', config),
  ]);

  // An aborted fan-out is a cancellation, not "five skills with no data" —
  // rethrow the canonical canceled error so callers (and the hook's abort
  // guards) still see a rejection, exactly as with `Promise.all`.
  if (signal?.aborted) {
    throw new ApiError('request canceled', { status: 0, code: 'canceled' });
  }

  const topikRes = topik.status === 'fulfilled' ? topik.value : null;
  return {
    reading: topikRes !== null ? topikRes.reading : unavailableSeries(),
    listening: topikRes !== null ? topikRes.listening : unavailableSeries(),
    vocab: vocab.status === 'fulfilled' ? vocab.value.series : unavailableSeries(),
    grammar:
      grammar.status === 'fulfilled' ? grammar.value.series : unavailableSeries(),
    writing:
      writing.status === 'fulfilled' ? writing.value.series : unavailableSeries(),
  };
}
