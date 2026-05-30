/**
 * /define — KRDICT lookup for a single headword.
 *
 * Threat model:
 *   - GET endpoint → no CSRF surface. Cookie session required.
 *   - 503 path: the server returns 503 `krdict_unavailable` when KRDICT
 *     tables aren't present (B2 not deployed yet). Surfaced as `ApiError`
 *     with `status: 503` and `code: 'krdict_unavailable'` — UI can branch.
 *   - 404 path: "no dictionary entry for requested word" — surfaced as a
 *     generic `ApiError` with `status: 404`. The server deliberately does
 *     not echo the request back; we keep that contract.
 *
 * Naming note: the task description used `lemma` as the parameter name; the
 * server uses the query key `word`. We pass `word` on the wire and keep the
 * caller-facing name flexible (the parameter is just a string).
 */
import { api } from './api';
import type { DefineResult } from '../types/domain';

/**
 * GET /define?word=… → KRDICT entries for the headword.
 *
 * Note: the path retains its trailing slash (`/define/`) to match the
 * server's Express route. Stripping it would 404 under strict-routing
 * proxies. The rest of the API uses unsuffixed segments; this is the one
 * intentional exception.
 *
 * `signal` forwards to axios so the caller can abort a stale lookup (e.g.
 * the user closes the popover before KRDICT responds).
 */
export async function defineEntry(
  word: string,
  signal?: AbortSignal,
): Promise<DefineResult> {
  return api.get<DefineResult>('/define/', {
    params: { word },
    ...(signal !== undefined ? { signal } : {}),
  });
}
