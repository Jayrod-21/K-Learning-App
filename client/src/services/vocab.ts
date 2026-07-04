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
  BookLevel,
  ContentDomain,
  CreateListBody,
  CreateListResponse,
  DueCard,
  InitCardsBody,
  InitCardsResult,
  ListListsResponse,
  MineWordInput,
  MineWordResult,
  PatchListBody,
  PatchListResponse,
  ReviewResult,
  ReviewSubmission,
  ServerProficiency,
  ServerVocabList,
  VocabCorpus,
  VocabEntriesPage,
  VocabEntry,
  VocabEntryDetail,
  VocabListDetailResponse,
} from '../types/domain';

/** Pagination + filter for `GET /vocab/entries`. */
export interface SearchEntriesOptions {
  q?: string;
  corpus?: VocabCorpus;
  proficiency?: ServerProficiency;
  /** Genre filter — the server's `content_domain` tag (F-003). */
  domain?: ContentDomain;
  /** Difficulty filter — the source book's `book_level` band (F-003). */
  book_level?: BookLevel;
  limit?: number;
  offset?: number;
}

/** GET /vocab/entries?q=… — returns just the rows (existing callers). */
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

/**
 * GET /vocab/entries?q=… — returns the FULL page envelope (entries + total +
 * limit + offset). The Resources Vocabulary tab needs the real `total` to
 * paginate the curated corpus ("see all words whenever I want"), which the
 * row-only `searchEntries` discards. Kept as a separate function so the
 * existing row-only callers (Reference search, Review) stay unchanged.
 */
export async function searchEntriesPage(
  opts: SearchEntriesOptions = {},
  signal?: AbortSignal,
): Promise<VocabEntriesPage> {
  const params = stripUndef({ ...opts });
  return api.get<VocabEntriesPage>('/vocab/entries', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
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
 * FU-NF-42 A4), and for vocab cards it LEFT JOINs `vocab_entries` and carries
 * the entry's korean/english/example/source fields (NULL for non-vocab cards,
 * B-009). `getDueCards` normalises all of these onto the camelCase `DueCard`
 * fields so the screens never reach across the wire boundary.
 */
interface DueCardWire extends DueCard {
  vocab_korean?: string | null;
  vocab_english?: string | null;
  vocab_example_korean?: string | null;
  vocab_example_english?: string | null;
  vocab_source_book?: string | null;
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
 * Map the server's snake-case JOIN columns (grammar_* per FU-NF-42, vocab_*
 * per B-009) onto the camelCase `DueCard` fields. NULLs collapse to
 * `undefined` so a vocab card's `grammarPatternDisplay` stays absent (the
 * Review branch keys on it being present + the card face) and a grammar
 * card's `vocabKorean` stays absent likewise. Spreads the row first so any
 * field the server adds later survives untouched.
 */
function normalizeDueCard(row: DueCardWire): DueCard {
  const {
    vocab_korean: korean,
    vocab_english: english,
    vocab_example_korean: exampleKorean,
    vocab_example_english: exampleEnglish,
    vocab_source_book: sourceBook,
    grammar_pattern_display: display,
    grammar_summary_en: summary,
    grammar_pattern_key: patternKey,
    ...rest
  } = row;
  return {
    ...rest,
    ...(korean != null ? { vocabKorean: korean } : {}),
    ...(english != null ? { vocabEnglish: english } : {}),
    ...(exampleKorean != null ? { vocabExampleKorean: exampleKorean } : {}),
    ...(exampleEnglish != null ? { vocabExampleEnglish: exampleEnglish } : {}),
    ...(sourceBook != null ? { vocabSourceBook: sourceBook } : {}),
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

/**
 * POST /vocab/mine — the "tap anything → bank it" path (FU-NF-33). The shared
 * KRDICT→bank helper both the Reading tap-chain and the Images OCR list call.
 *
 * A tapped/OCR'd word, resolved through KRDICT, is upserted into the shared
 * `user_mined` corpus and banked as a recognition card for the current user.
 * Unlike `bankEntry` (which needs a pre-existing `vocab_entries.id`), this
 * accepts the lemma + optional KRDICT entry id the tap chain actually resolves,
 * so the gesture reaches the bank without a separate lemma→entry resolver.
 *
 * Idempotent on the server: the entry is keyed on `krdict-{id}` (or
 * `lemma-{lemma}` when no id is given) and the card on (user, entry,
 * recognition), so a double-tap returns the same `card.id` — safe to call from
 * an optimistic-flip handler.
 *
 * `signal` is the popover-scoped `AbortController.signal`: a popover close or a
 * new tap aborts the in-flight request, and the caller swallows the resulting
 * cancellation rather than treating it as a bank failure.
 */
export async function mineWord(
  input: MineWordInput,
  signal?: AbortSignal,
): Promise<MineWordResult> {
  return api.post<MineWordResult>(
    '/vocab/mine',
    stripUndef({ ...input }),
    signal !== undefined ? { signal } : undefined,
  );
}

// ── Vocab lists (migration 012) ────────────────────────────────────────

/** GET /vocab/lists — the user's lists (soft-deleted excluded server-side). */
export async function listLists(): Promise<ServerVocabList[]> {
  const res = await api.get<ListListsResponse>('/vocab/lists');
  return res.lists;
}

/** POST /vocab/lists — create a list. Returns the row + seed-append count. */
export async function createList(
  body: CreateListBody,
): Promise<CreateListResponse> {
  return api.post<CreateListResponse>('/vocab/lists', stripUndef({ ...body }));
}

/**
 * GET /vocab/lists/:id — list detail + its first page of joined entry rows.
 *
 * Distinct from `listLists`' summary rows: this carries the membership the
 * "open list → entries + remove" flow renders. The server paginates the
 * entries (`entry_limit`/`entry_offset`); the default page (100) covers the
 * sizes the Resources UI surfaces today.
 */
export async function getListDetail(
  id: number,
  signal?: AbortSignal,
): Promise<VocabListDetailResponse> {
  return api.get<VocabListDetailResponse>(
    `/vocab/lists/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/** PATCH /vocab/lists/:id — rename / re-caption / re-kind. */
export async function patchList(
  id: number,
  body: PatchListBody,
): Promise<PatchListResponse> {
  return api.patch<PatchListResponse>(`/vocab/lists/${String(id)}`, body);
}

/** DELETE /vocab/lists/:id — soft delete. Returns void on 204. */
export async function deleteList(id: number): Promise<void> {
  await api.delete<void>(`/vocab/lists/${String(id)}`);
}

/**
 * POST /vocab/lists/:id/entries — append entries. The server rejects a
 * duplicate membership with 409 (NOT a silent skip), so callers should treat
 * an `ApiError(status: 409)` as "already in this list".
 */
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
