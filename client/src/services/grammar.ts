/**
 * /grammar — KGIU corpus search + user grammar bank + per-pattern mastery
 * (F-099) + AI identify.
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
  BankedGrammarRow,
  BookLevel,
  ContentDomain,
  GrammarMasteryPage,
  IdentifyPatternBody,
  KgiuEntryDetail,
  KgiuEntrySummary,
  KgiuListResponse,
  MasteryBucket,
  PatternMatch,
  ServerProficiency,
} from '../types/domain';

/** Query options for `GET /grammar/kgiu`. */
export interface ListPatternsOptions {
  q?: string;
  corpus?: 'kgiu_beginner' | 'kgiu_intermediate' | 'kgiu_advanced';
  proficiency?: ServerProficiency;
  /** Genre filter — the server's `content_domain` tag (F-005). */
  domain?: ContentDomain;
  /** Difficulty filter — the source book's `book_level` band (F-005). */
  book_level?: BookLevel;
  /**
   * Source-book filter (U1 scaffolding — `db/docs/PDF_UPLOAD_DESIGN.md`
   * §"U1 → sort-by-source filter"). The `book_uploads.id` to filter by.
   * WIRED but inert until U2 lands: no `kgiu_entries` row carries a
   * `source_upload_id` yet, so this param returns nothing today (the
   * server's query schema isn't `.strict()`, so an unused param is a safe
   * no-op, never a 400) — U2's extraction just has to start populating the
   * column for this to start returning real rows.
   */
  source_upload_id?: string;
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
  // BIGINT `id` rides the wire as a JSON string (no int8 parser server-side,
  // and the list route returns rows raw) — coerce onto the declared numeric
  // type so a strict `===` against a converted detail id can't silently miss.
  return res.entries.map((e) => ({ ...e, id: Number(e.id) }));
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
  const res = await api.get<BankedGrammarList>(
    '/grammar/bank',
    signal !== undefined ? { signal } : undefined,
  );
  // Same BIGINT-as-string wire leak as `listPatterns` — coerce `id` so it
  // matches the numeric ids the graduate/readmit envelopes carry.
  return { ...res, entries: res.entries.map((e) => ({ ...e, id: Number(e.id) })) };
}

/**
 * POST /grammar/bank/:id/graduate — mark a banked pattern as known.
 * Removes it from active learning (drill pool, due reviews, weekly picks);
 * idempotent server-side (the original graduated_at is kept on a repeat).
 * `id` is the grammar bank row id from `BankedGrammarRow.id`, NOT a KGIU id.
 */
export async function graduatePattern(
  id: number,
  signal?: AbortSignal,
): Promise<{ entry: BankedGrammarRow }> {
  return api.post<{ entry: BankedGrammarRow }>(
    `/grammar/bank/${String(id)}/graduate`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /grammar/bank/:id/readmit — return a graduated pattern to active
 * learning. Its production card resurfaces with FSRS state intact.
 */
export async function readmitPattern(
  id: number,
  signal?: AbortSignal,
): Promise<{ entry: BankedGrammarRow }> {
  return api.post<{ entry: BankedGrammarRow }>(
    `/grammar/bank/${String(id)}/readmit`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

/** Query options for `GET /grammar/mastery` (mirrors vocab's FetchMasteryOptions). */
export interface FetchGrammarMasteryOptions {
  bucket?: MasteryBucket;
  limit?: number;
  offset?: number;
}

/**
 * GET /grammar/mastery — per-pattern FSRS mastery for the signed-in user
 * (F-099; feeds the Progress "Grammar" tab). Returns the bucket summary plus
 * a paginated, optionally bucket-filtered page of banked patterns — the
 * grammar sibling of `fetchMastery` (services/vocab.ts), same params, same
 * envelope shape (`patterns` instead of `words`).
 */
export async function fetchGrammarMastery(
  opts: FetchGrammarMasteryOptions = {},
  signal?: AbortSignal,
): Promise<GrammarMasteryPage> {
  const params: Record<string, string | number> = {};
  if (opts.bucket !== undefined) params.bucket = opts.bucket;
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<GrammarMasteryPage>('/grammar/mastery', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
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
