/**
 * /enrich — Claude-backed enrichment for a lemma in a source sentence.
 *
 * Threat model:
 *   - POST endpoint → CSRF surface; defended by SameSite=Strict cookie.
 *   - Expensive Claude call; the server expensive bucket throttles. The
 *     default axios timeout (10 s) is borderline for a cold Claude start —
 *     callers should pass `{ timeout: 30_000 }` via the lower-level
 *     `apiRequest` if a screen needs a longer ceiling. Tracked in
 *     SECURITY.md §10 (FU-NF-14).
 *   - Body shape locked by server Zod schema. Client trusts TS types.
 *   - Upstream error: the server wraps Claude errors as `UpstreamError`
 *     (502). The api layer surfaces them as `ApiError` with status 502 and
 *     a server-provided code. Call sites can branch on `status >= 500`.
 */
import { api } from './api';
import type { EnrichRequest, EnrichResult } from '../types/domain';

/**
 * POST /enrich → enrichment result for a lemma in context.
 *
 * `signal` forwards to axios so the caller can abort a stale enrichment
 * (e.g. the user closes the popover before Claude responds). The Claude
 * call is expensive — abort matters here.
 */
export async function enrich(
  body: EnrichRequest,
  signal?: AbortSignal,
): Promise<EnrichResult> {
  return api.post<EnrichResult>(
    '/enrich',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}
