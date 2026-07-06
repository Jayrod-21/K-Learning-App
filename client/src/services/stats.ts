/**
 * Per-skill trend series (F-017 — Today's "Progress by skill" carousel).
 *
 * Assembles the five-skill `AllSkillSeries` from the three series endpoints
 * in one `Promise.all` fan-out:
 *
 *   GET /topik/series?days=N   → { reading, listening }   (two SkillSeries)
 *   GET /vocab/series?days=N   → { series }               (one SkillSeries)
 *   GET /grammar/series?days=N → { series }               (one SkillSeries)
 *
 * Writing has no series route yet, so its slot is synthesized client-side as
 * the `metric: 'none'` sentinel — the carousel renders a placeholder panel
 * for it instead of a chart. A fresh object is built per call (never a shared
 * module-level constant) so no caller can mutate another's series.
 *
 * `Promise.all` is all-or-nothing on purpose: the carousel is one widget, and
 * painting three real charts next to one silently-missing skill would lie
 * about the user's progress. A single rejection propagates to
 * `useEndpointOrMock`, which owns the mock fallback + error surfacing.
 *
 * Threat model:
 *   - **Auth + session.** All three routes are `requireAuth` server-side; the
 *     session cookie rides via `withCredentials` on the shared axios
 *     instance. No bearer token is read or echoed from JS.
 *   - **CSRF.** All three are GETs (no state change); the `SameSite=Strict`
 *     session cookie covers them regardless.
 *   - **Injection.** `days` is a caller-supplied number serialized by axios
 *     into the query string — never interpolated into the path — and the
 *     server re-validates/clamps it.
 *   - **Rendered text is escaped.** `unit` is server prose rendered as React
 *     children downstream, so a malicious payload becomes literal text, not
 *     markup.
 *
 * Signal note: the optional `signal` lets a direct caller cancel the whole
 * fan-out (one signal aborts all three requests). Like the other services,
 * the Today screen consumes this through `useEndpointOrMock` (no-arg
 * `realFn`), which owns cancellation itself — the param is for symmetry and
 * future direct callers.
 */
import { api } from './api';
import type { AllSkillSeries, SkillSeries } from '../types/domain';

/** Envelope returned by `GET /topik/series` — two skills in one response. */
export interface TopikSeriesResponse {
  reading: SkillSeries;
  listening: SkillSeries;
}

/** Envelope returned by `GET /vocab/series` and `GET /grammar/series`. */
export interface SingleSeriesResponse {
  series: SkillSeries;
}

/**
 * Fetch all five skill trends for the last `days` days (server default 30).
 *
 * The three GETs run in parallel; `writing` is synthesized empty (no route).
 * Rejects with the first request's `ApiError` if any of the three fails.
 */
export async function fetchSkillSeries(
  days = 30,
  signal?: AbortSignal,
): Promise<AllSkillSeries> {
  const config = {
    params: { days },
    ...(signal !== undefined ? { signal } : {}),
  };

  const [topik, vocab, grammar] = await Promise.all([
    api.get<TopikSeriesResponse>('/topik/series', config),
    api.get<SingleSeriesResponse>('/vocab/series', config),
    api.get<SingleSeriesResponse>('/grammar/series', config),
  ]);

  return {
    reading: topik.reading,
    listening: topik.listening,
    vocab: vocab.series,
    grammar: grammar.series,
    // No /writing/series route yet — synthesize the client-only sentinel so
    // the carousel can render its "start writing" placeholder panel.
    writing: { metric: 'none', unit: '', points: [] },
  };
}
