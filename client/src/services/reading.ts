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
} from '../types/domain';

/** Pagination + corpus filter for `GET /reading/units`. */
export interface FetchUnitsOptions {
  corpus: ReadingCorpus;
  limit?: number;
  offset?: number;
}

/** Envelope returned by `GET /reading/units`. */
interface UnitsEnvelope {
  units: ReadingUnit[];
}

/**
 * GET /reading/units?corpus=…
 *
 * `corpus` is required by the server schema (Zod enum) — the helper rejects
 * an omitted corpus with `ApiError(400)` so callers don't accidentally hit
 * a no-op default at the server.
 */
export async function fetchUnits(
  opts: FetchUnitsOptions,
): Promise<ReadingUnit[]> {
  const params: Record<string, string | number> = { corpus: opts.corpus };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  const res = await api.get<UnitsEnvelope>('/reading/units', { params });
  return res.units;
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
