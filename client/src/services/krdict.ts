/**
 * /krdict — full KRDICT dictionary search (Resources Dictionary tab).
 *
 * The curated `vocab_2000` corpus is browsable and listable; the full KRDICT
 * dictionary (~54k headwords) is far too large to scroll, so this surface is
 * search-driven and paginated. The route is read-only (cheap rate limiter,
 * Zod-validated `q`/`limit`/`offset`) and returns a `total` so the UI can
 * render a real "N of M" pager rather than a length-capped list.
 *
 * Threat model:
 *   - GET endpoint → no CSRF surface. Cookie session required (the shared
 *     axios instance carries `withCredentials`).
 *   - `q` is user-controlled. We do NOT sanitise on the client — the server
 *     validates `q` via Zod and parameterises the SQL (ILIKE/prefix), and the
 *     headword/definition strings render through React text children, so a
 *     hostile row cannot escape into the DOM. The client's defence is rate:
 *     callers debounce keystrokes and abort the prior in-flight request.
 *   - 503 path: the server returns 503 `krdict_unavailable` when the KRDICT
 *     tables aren't present (mirrors `/define`). Surfaced as an `ApiError`
 *     with `status: 503` so the UI can show an "unavailable" empty state
 *     rather than a generic failure.
 *   - Body validation: server validates with Zod; the client trusts TS types.
 */
import { api } from './api';
import type { KrdictSearchPage } from '../types/domain';

/** Pagination + query for `GET /krdict/search`. */
export interface SearchKrdictOptions {
  q: string;
  limit?: number;
  offset?: number;
}

/**
 * GET /krdict/search?q=&limit=&offset= → paginated KRDICT headwords.
 *
 * `signal` forwards to axios so a caller can abort a stale search (e.g. the
 * user types another character past the debounce window).
 */
export async function searchKrdict(
  opts: SearchKrdictOptions,
  signal?: AbortSignal,
): Promise<KrdictSearchPage> {
  const params: Record<string, string | number> = { q: opts.q };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<KrdictSearchPage>('/krdict/search', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
}
