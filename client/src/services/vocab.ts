/**
 * /vocab — corpus lookup, FSRS card queue, reviews, banked lists.
 *
 * Threat model:
 *   - Cookie session required (`requireAuth` on the server router). The
 *     server scopes every query by `user_id`; we don't pass a user id from
 *     the client.
 *   - State changes use POST/PATCH/DELETE → CSRF surface; defended by
 *     SameSite=Strict cookie. If that ever relaxes, surface a CSRF token
 *     at the api layer, not here.
 *   - Optimistic concurrency: `submitReview` sends `expected_version`.
 *     A 409 means the caller's snapshot is stale; UI must re-fetch the
 *     card and replay the rating against the fresh version.
 *   - Cards/init is idempotent (server uses NOT EXISTS). Re-issuing the
 *     same body returns `inserted: 0`, not an error.
 *   - Lists CRUD (Pass 3A): the routes land alongside this client wiring.
 *     Calling them before the routes deploy returns 404 wrapped as
 *     `ApiError(status: 404)`.
 *   - Body validation: server validates with Zod. Client trusts TS types.
 */
import { api } from './api';
import type {
  AddListEntriesResult,
  CreateListBody,
  DueCard,
  InitCardsBody,
  InitCardsResult,
  ListListsResponse,
  PatchListBody,
  ReviewResult,
  ReviewSubmission,
  ServerProficiency,
  ServerVocabList,
  VocabCorpus,
  VocabEntriesPage,
  VocabEntry,
  VocabEntryDetail,
} from '../types/domain';

/** Pagination + filter for `GET /vocab/entries`. */
export interface SearchEntriesOptions {
  q?: string;
  corpus?: VocabCorpus;
  proficiency?: ServerProficiency;
  limit?: number;
  offset?: number;
}

/** GET /vocab/entries?q=… */
export async function searchEntries(
  opts: SearchEntriesOptions = {},
  signal?: AbortSignal,
): Promise<VocabEntry[]> {
  const params = stripUndef({ ...opts });
  const res = await api.get<VocabEntriesPage>('/vocab/entries', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.entries;
}

/** GET /vocab/entries/:entryId */
export async function getEntry(
  entryId: number,
  signal?: AbortSignal,
): Promise<VocabEntryDetail> {
  return api.get<VocabEntryDetail>(
    `/vocab/entries/${String(entryId)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * Raw wire row for a due card. The server speaks snake_case; for grammar
 * production cards it LEFT JOINs `grammar_entries` and carries
 * `grammar_pattern_display` / `grammar_summary_en` (NULL for vocab cards,
 * FU-NF-42 A4). `getDueCards` normalises those two onto the camelCase
 * `DueCard` fields so the screens never reach across the wire boundary.
 */
interface DueCardWire extends DueCard {
  grammar_pattern_display?: string | null;
  grammar_summary_en?: string | null;
  grammar_pattern_key?: string | null;
}

/** GET /vocab/cards/due — paginated due cards for the current user. */
export async function getDueCards(
  limit?: number,
  signal?: AbortSignal,
): Promise<DueCard[]> {
  const params = limit !== undefined ? { limit } : undefined;
  const res = await api.get<{ cards: DueCardWire[] }>('/vocab/cards/due', {
    ...(params !== undefined ? { params } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.cards.map(normalizeDueCard);
}

/**
 * Map the server's snake-case grammar JOIN columns onto the camelCase
 * `DueCard` fields. NULLs collapse to `undefined` so a vocab card's
 * `grammarPatternDisplay` stays absent (the Review branch keys on it being
 * present + the card face). Spreads the row first so any field the server
 * adds later survives untouched.
 */
function normalizeDueCard(row: DueCardWire): DueCard {
  const {
    grammar_pattern_display: display,
    grammar_summary_en: summary,
    grammar_pattern_key: patternKey,
    ...rest
  } = row;
  return {
    ...rest,
    ...(display != null ? { grammarPatternDisplay: display } : {}),
    ...(summary != null ? { grammarSummaryEn: summary } : {}),
    ...(patternKey != null ? { grammarPatternKey: patternKey } : {}),
  };
}

/** POST /vocab/cards/:cardId/reviews — record an FSRS review. */
export async function submitReview(
  cardId: number,
  payload: ReviewSubmission,
): Promise<ReviewResult> {
  return api.post<ReviewResult>(
    `/vocab/cards/${String(cardId)}/reviews`,
    payload,
  );
}

/** POST /vocab/cards/init — seed a recognition card slice. Idempotent. */
export async function initCards(
  body: InitCardsBody,
  signal?: AbortSignal,
): Promise<InitCardsResult> {
  return api.post<InitCardsResult>(
    '/vocab/cards/init',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /vocab/entries/:entryId/bank — bank a single vocab entry as a
 * recognition card for the current user. Idempotent on (user, entry) —
 * second call returns the same card row.
 *
 * Replaces the misleading `initCards({ corpus, limit: 1 })` slice-vs-per-
 * entry workaround the Reading screen was wired against in Pass 3. The
 * per-entry endpoint exists on the server (`/vocab/entries/:entryId/bank`)
 * and threads the user's actual tap intent end-to-end.
 */
export async function bankEntry(
  entryId: number,
  signal?: AbortSignal,
): Promise<{ card: { id: number; version: number } }> {
  return api.post<{ card: { id: number; version: number } }>(
    `/vocab/entries/${String(entryId)}/bank`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

// ── Vocab lists (Pass 3A) ──────────────────────────────────────────────

/** GET /vocab/lists */
export async function listLists(): Promise<ServerVocabList[]> {
  const res = await api.get<ListListsResponse>('/vocab/lists');
  return res.lists;
}

/** POST /vocab/lists */
export async function createList(
  body: CreateListBody,
): Promise<ServerVocabList> {
  return api.post<ServerVocabList>('/vocab/lists', body);
}

/** GET /vocab/lists/:id */
export async function getList(
  id: number,
  signal?: AbortSignal,
): Promise<ServerVocabList> {
  return api.get<ServerVocabList>(
    `/vocab/lists/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/** PATCH /vocab/lists/:id */
export async function patchList(
  id: number,
  body: PatchListBody,
): Promise<ServerVocabList> {
  return api.patch<ServerVocabList>(`/vocab/lists/${String(id)}`, body);
}

/** DELETE /vocab/lists/:id — returns void on 204. */
export async function deleteList(id: number): Promise<void> {
  await api.delete<void>(`/vocab/lists/${String(id)}`);
}

/** POST /vocab/lists/:id/entries — bulk add. */
export async function addListEntries(
  id: number,
  entryIds: number[],
): Promise<AddListEntriesResult> {
  return api.post<AddListEntriesResult>(`/vocab/lists/${String(id)}/entries`, {
    entry_ids: entryIds,
  });
}

/** DELETE /vocab/lists/:id/entries/:entryId */
export async function removeListEntry(
  id: number,
  entryId: number,
): Promise<void> {
  await api.delete<void>(
    `/vocab/lists/${String(id)}/entries/${String(entryId)}`,
  );
}

/**
 * Strip `undefined` values from a flat record. Axios serialises `undefined`
 * as the literal string `"undefined"` in some configurations — safer to
 * drop the keys outright so the server never sees them.
 */
function stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
