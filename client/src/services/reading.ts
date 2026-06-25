/**
 * /reading — TTMIK / Iyagi corpus units and sentences (read-only).
 *
 * Threat model:
 *   - All routes are GET — no CSRF surface. Cookie session ride via
 *     `withCredentials` set on the shared axios instance.
 *   - Rate limit: server `cheapLimiter` per user. Client does not retry.
 *   - Path-traversal: `corpus` is a string union (`ttmik`/`iyagi`) and
 *     `unitId` is a number; both are interpolated into the path. No
 *     user-input string is concatenated into the URL.
 *   - Body validation: server validates. We trust TS types client-side.
 */
import { api } from './api';
import type {
  ReadingCorpus,
  ReadingSentences,
  ReadingUnit,
  ReadingUnitsPage,
} from '../types/domain';

/** Pagination + corpus filter for `GET /reading/units`. */
export interface FetchUnitsOptions {
  corpus: ReadingCorpus;
  limit?: number;
  offset?: number;
}

/**
 * GET /reading/units?corpus=… — one page of units PLUS the corpus `total`.
 *
 * Backs the passage picker, which needs the total to paginate the full
 * corpus (2,742 ttmik + 11,162 iyagi sentences across hundreds of units)
 * in one round-trip rather than capping the user at the first page.
 *
 * `corpus` is required by the server schema (Zod enum) — passing it
 * explicitly avoids a no-op default at the server.
 */
export async function fetchUnitsPage(
  opts: FetchUnitsOptions,
): Promise<ReadingUnitsPage> {
  const params: Record<string, string | number> = { corpus: opts.corpus };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<ReadingUnitsPage>('/reading/units', { params });
}

/**
 * GET /reading/units?corpus=… — just the unit rows.
 *
 * Thin wrapper over {@link fetchUnitsPage} for callers that only need the
 * list (e.g. the default first-unit load on the Reading screen). `corpus`
 * is required by the server schema; the helper rejects a network/validation
 * failure with `ApiError` so the caller's fallback path lights up.
 */
export async function fetchUnits(
  opts: FetchUnitsOptions,
): Promise<ReadingUnit[]> {
  const page = await fetchUnitsPage(opts);
  return page.units;
}

/** GET /reading/units/:corpus/:unitId/sentences */
export async function fetchSentences(
  corpus: ReadingCorpus,
  unitId: number,
): Promise<ReadingSentences> {
  return api.get<ReadingSentences>(
    `/reading/units/${corpus}/${String(unitId)}/sentences`,
  );
}
