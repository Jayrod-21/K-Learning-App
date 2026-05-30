/**
 * /grammar — KGIU corpus search + user grammar bank + AI identify.
 *
 * Threat model:
 *   - Auth required; user-scoped queries on the server.
 *   - State changes via POST; SameSite=Strict defends CSRF.
 *   - `POST /grammar/identify` is an expensive (Claude) bucket. The default
 *     axios timeout (10 s) may be tight for a cold start; UI should accept
 *     an `ApiError(code: 'timeout')` and let the user retry.
 *   - Body shapes are validated by server Zod. Client trusts TS types.
 */
import { api } from './api';
import type {
  BankGrammarBody,
  BankedGrammarList,
  IdentifyPatternBody,
  KgiuEntryDetail,
  KgiuEntrySummary,
  KgiuListResponse,
  PatternMatch,
  ServerProficiency,
} from '../types/domain';

/** Query options for `GET /grammar/kgiu`. */
export interface ListPatternsOptions {
  q?: string;
  corpus?: 'kgiu_beginner' | 'kgiu_intermediate' | 'kgiu_advanced';
  proficiency?: ServerProficiency;
  limit?: number;
  offset?: number;
}

/** GET /grammar/kgiu — paginated KGIU patterns. */
export async function listPatterns(
  opts: ListPatternsOptions = {},
  signal?: AbortSignal,
): Promise<KgiuEntrySummary[]> {
  const params: Record<string, string | number> = {};
  for (const k of Object.keys(opts) as (keyof ListPatternsOptions)[]) {
    const v = opts[k];
    if (v !== undefined) params[k] = v;
  }
  const res = await api.get<KgiuListResponse>('/grammar/kgiu', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.entries;
}

/** GET /grammar/kgiu/:id — single KGIU pattern. */
export async function getPattern(
  id: number,
  signal?: AbortSignal,
): Promise<KgiuEntryDetail> {
  return api.get<KgiuEntryDetail>(
    `/grammar/kgiu/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/** POST /grammar/bank — bank a pattern. Idempotent on (user, pattern_key). */
export async function bankPattern(
  body: BankGrammarBody,
  signal?: AbortSignal,
): Promise<{ id: number }> {
  return api.post<{ id: number }>(
    '/grammar/bank',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/** GET /grammar/bank — list the user's banked patterns. */
export async function listBanked(
  signal?: AbortSignal,
): Promise<BankedGrammarList> {
  return api.get<BankedGrammarList>(
    '/grammar/bank',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /grammar/identify — drag-to-highlight → canonical pattern mapping.
 *
 * Server-side schema names the fields `highlightSpan` + `fullSentence`. The
 * task wording mentioned "(span, sentence)" — this helper accepts a single
 * body object so future fields (e.g. `contextHint`) are non-breaking.
 */
export async function identifyPattern(
  body: IdentifyPatternBody,
  signal?: AbortSignal,
): Promise<PatternMatch> {
  return api.post<PatternMatch>(
    '/grammar/identify',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}
