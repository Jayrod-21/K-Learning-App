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
import { coerceId } from '../lib/coerceId';
import { api } from './api';
import type {
  AddListEntriesResult,
  BookLevel,
  ClearCardsResult,
  ClozeGradeRequest,
  ClozeGradeResponse,
  ContentDomain,
  CreateListBody,
  CreateListResponse,
  DueCard,
  InitCardsBody,
  InitCardsResult,
  ListEntryItemType,
  ListListsResponse,
  MasteryBucket,
  MasteryPage,
  MineWordInput,
  MineWordResult,
  PatchListBody,
  PatchListResponse,
  ReviewResult,
  ReviewSubmission,
  SavedFromUploadsResponse,
  ServerProficiency,
  ServerVocabList,
  VocabCorpus,
  VocabEntriesPage,
  VocabEntry,
  VocabEntryDetail,
  VocabListDetailResponse,
  VocabListKind,
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
  /**
   * Per-book chapter/topic facet (F-176) — `vocab_entries.theme`, a free-text
   * label lifted verbatim from the source PDF (e.g. "01 인간 / People"), NOT
   * a closed enum like `domain`/`book_level`. Exact match. See
   * `fetchVocabThemes` for the values list this binds against.
   */
  theme?: string;
  /**
   * Source-book filter (U1 scaffolding — `db/docs/PDF_UPLOAD_DESIGN.md`
   * §"U1 → sort-by-source filter"). The `book_uploads.id` to filter by.
   * LIVE as of F-107: `POST /vocab/mine` (see `mineWord`) now writes
   * `vocab_entries.source_upload_id` for saves that carry upload provenance,
   * so this filter returns those user-mined rows. The server only matches
   * rows whose upload the CALLER owns (an unowned/unknown id yields zero
   * rows, never an error). U2's PDF extraction will additionally populate
   * the column for loader-extracted entries.
   */
  source_upload_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * Normalise the `q` filter at the service boundary: the server schema is
 * `z.string().trim().min(1)`, so a whitespace-only `q` trims to `''`
 * server-side and 400s the WHOLE request (a single space in the Reference
 * search box replaced the Vocabulary tab with an error card). Trim here and
 * drop an empty result entirely — an all-whitespace query means "browse",
 * not "error". Callers that already trim (Review.tsx) are unaffected.
 */
function normalizeSearchOpts(opts: SearchEntriesOptions): SearchEntriesOptions {
  if (opts.q === undefined) return opts;
  const q = opts.q.trim();
  const rest: SearchEntriesOptions = { ...opts };
  delete rest.q;
  return q === '' ? rest : { ...rest, q };
}

/** Coerce a wire id onto the numeric type the client contract declares —
 *  `vocab_entries.id` / `vocab_lists.id` are BIGINT, which node-postgres
 *  serialises as a JSON **string** (no int8 parser in db/pool.ts). Every
 *  sibling route's client mapping coerces; these were missed. */
function numericId<T extends { id: number }>(row: T): T {
  return { ...row, id: coerceId(row.id) };
}

/** GET /vocab/entries?q=… — returns just the rows (existing callers). */
export async function searchEntries(
  opts: SearchEntriesOptions = {},
  signal?: AbortSignal,
): Promise<VocabEntry[]> {
  const params = stripUndef({ ...normalizeSearchOpts(opts) });
  const res = await api.get<VocabEntriesPage>('/vocab/entries', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.entries.map(numericId);
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
  const params = stripUndef({ ...normalizeSearchOpts(opts) });
  const res = await api.get<VocabEntriesPage>('/vocab/entries', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
  return { ...res, entries: res.entries.map(numericId) };
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
 * GET /vocab/themes — the distinct, non-null `theme` values across the
 * curated corpus (F-176). Themes are free text lifted per-book from the
 * source extraction (beginner and intermediate corpora each have their OWN
 * "01"/"02"… numbered taxonomy with similar-but-not-identical labels — e.g.
 * "01 인간 / People" vs "01 사람 / People" are two DIFFERENT strings from two
 * different books), so this is fetched from the live corpus rather than
 * hardcoded client-side.
 */
export async function fetchVocabThemes(signal?: AbortSignal): Promise<string[]> {
  const res = await api.get<{ themes: string[] }>(
    '/vocab/themes',
    signal !== undefined ? { signal } : undefined,
  );
  return res.themes;
}

/** Filter + pagination for `GET /vocab/mastery` (F-013). */
export interface FetchMasteryOptions {
  /** Restrict the word list to one bucket; omit for all buckets. */
  bucket?: MasteryBucket;
  limit?: number;
  offset?: number;
}

/**
 * GET /vocab/mastery — the signed-in user's per-word FSRS mastery: a bucket
 * summary plus a paginated, optionally bucket-filtered list of words.
 */
export async function fetchMastery(
  opts: FetchMasteryOptions = {},
  signal?: AbortSignal,
): Promise<MasteryPage> {
  const params: Record<string, string | number> = {};
  if (opts.bucket !== undefined) params.bucket = opts.bucket;
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<MasteryPage>('/vocab/mastery', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
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
 * GET /vocab/cards/due — the page PLUS a real, unbounded `total` (count
 * reconciliation, TODAY_NAV_SCOPING Part A / the "665 due" vs "0 cards due"
 * bug). `getDueCards` above discards `total` for its existing callers
 * (Grammar.tsx's due-queue check, which only ever needed the rows); this
 * sibling exists so a screen that needs to DISPLAY a due count (Review.tsx's
 * landing) can show the server's exact total instead of the capped page's
 * `.length`, which structurally can never exceed `limit` (default 20) no
 * matter how large the real backlog is.
 */
export async function getDueCardsPage(
  limit?: number,
  signal?: AbortSignal,
): Promise<{ cards: DueCard[]; total: number }> {
  const params = limit !== undefined ? { limit } : undefined;
  const res = await api.get<{ cards: DueCardWire[]; total: number }>(
    '/vocab/cards/due',
    {
      ...(params !== undefined ? { params } : {}),
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return { cards: res.cards.map(normalizeDueCard), total: res.total };
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

/**
 * POST /vocab/cards/:cardId/cloze/grade — grade a TYPED cloze answer (F-208).
 *
 * Two-attempt, hint-then-reveal flow; the server is the sole grader (exact
 * surface match, then Kiwi lemma tolerance) and — on a committing outcome —
 * ADVANCES THE SAME CARD'S FSRS SCHEDULE ITSELF. Callers must NOT follow a
 * committing response with `submitReview` (that would double-write FSRS);
 * use the returned `version`/`due_at` as the card's fresh snapshot instead.
 *
 * Response union (discriminate on `'hint' in res`):
 *   - `ClozeGradeHintResponse` — wrong on attempt 1 without giveUp.
 *     NON-committing: no FSRS write, no version bump, no answer reveal.
 *   - `ClozeGradeCommittedResponse` — correct (any attempt), wrong on
 *     attempt 2, or giveUp. FSRS committed; carries the reveal.
 *
 * Errors (ApiError): 404 card-not-found / no-cloze-prompt (fall back to the
 * flashcard presentation), 409 stale `expected_version` (same posture as
 * `submitReview` conflicts), 400 validation, 502 Kiwi outage (retryable —
 * the card is untouched, no half-state).
 */
export async function gradeCloze(
  cardId: number,
  body: ClozeGradeRequest,
): Promise<ClozeGradeResponse> {
  return api.post<ClozeGradeResponse>(
    `/vocab/cards/${String(cardId)}/cloze/grade`,
    stripUndef({ ...body }),
  );
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

/**
 * DELETE /vocab/cards/:cardId — remove ONE card from the review queue.
 *
 * SOFT delete server-side: the card leaves the due queue but the saved WORD
 * is untouched (`vocab_entries`, list memberships, and upload provenance all
 * survive — removal is about the review card, never the word). Idempotent:
 * re-removing an already-removed card is a 204, not an error. The server
 * scopes the write to the session user — a card that isn't the caller's own
 * 404s (`ApiError(status: 404)`) and is never touched.
 */
export async function removeCard(cardId: number): Promise<void> {
  await api.delete<void>(`/vocab/cards/${String(cardId)}`);
}

/**
 * POST /vocab/cards/clear — remove EVERY card from the user's vocab review
 * queue (due, future-scheduled, and suspended alike). Returns how many were
 * removed. Soft delete server-side: the user's saved words, lists, and
 * upload provenance are all kept — only the review cards go. Hanja and
 * grammar cards are NOT cleared (their decks are owned by their own
 * surfaces). Idempotent: a repeat call returns `{ cleared: 0 }`.
 *
 * Bulk-destructive by the user's standards even though it's soft — callers
 * MUST gate this behind an explicit confirmation UI; the server additionally
 * scopes the write to the session user, so a crafted request can never clear
 * someone else's queue.
 */
export async function clearDueCards(): Promise<ClearCardsResult> {
  return api.post<ClearCardsResult>('/vocab/cards/clear', {});
}

/**
 * Result of one `POST /vocab/cloze/seed` run (F-208 follow-up — the cloze
 * toggle's auto-seed). Snake_case mirrors the wire verbatim.
 */
export interface ClozeSeedResult {
  /** Total not-yet-seeded eligible entries (unbounded, not just this run). */
  eligible: number;
  examined: number;
  seeded: number;
  skipped_no_span: number;
  /** eligible − examined: how many entries a follow-up run would tackle. */
  remaining: number;
  /** Kiwi outage — the run stopped early with honest partial counts. */
  aborted_upstream: boolean;
}

/**
 * POST /vocab/cloze/seed — compute + persist cloze prompts for the entries
 * backing this user's live recognition cards (F-208 seeder). Idempotent and
 * resumable: already-seeded entries are excluded, so re-running seeds the
 * NEXT batch — callers loop until `remaining` hits 0 (or `aborted_upstream`
 * reports a Kiwi outage; everything seeded so far is committed either way).
 * The Review page's cloze-drills toggle drives this on enable.
 */
export async function seedClozePrompts(
  limit?: number,
  signal?: AbortSignal,
): Promise<ClozeSeedResult> {
  return api.post<ClozeSeedResult>(
    '/vocab/cloze/seed',
    limit !== undefined ? { limit } : {},
    signal !== undefined ? { signal } : undefined,
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

/** `PUT /vocab/gloss-override` response — the server's normalized echo. */
export interface GlossOverrideResult {
  lemma: string;
  gloss: string;
}

/**
 * PUT /vocab/gloss-override — set (or replace) the caller's OWN English
 * gloss for a Korean word (Phase 2.8). `lemma` is the tapped word's own `kr`
 * field (the WordPopover headword) — the server normalizes it (trim + NFC)
 * before writing, so the corpus-wide read-overlay join can never miss on a
 * normalization mismatch. Writes ONLY the caller's private override row;
 * the shared corpus gloss every other user sees is untouched.
 */
export async function putGlossOverride(
  lemma: string,
  gloss: string,
  signal?: AbortSignal,
): Promise<GlossOverrideResult> {
  return api.put<GlossOverrideResult>(
    '/vocab/gloss-override',
    { lemma, gloss },
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * DELETE /vocab/gloss-override — clear the caller's own override for a word,
 * reverting every gloss surface back to the shared default. `cleared: false`
 * when there was nothing to clear (not an error — the Reset control treats
 * either outcome as success).
 */
export async function deleteGlossOverride(
  lemma: string,
  signal?: AbortSignal,
): Promise<{ cleared: boolean }> {
  return api.delete<{ cleared: boolean }>('/vocab/gloss-override', {
    data: { lemma },
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * GET /vocab/saved-from-uploads — the user's saved vocab that carries upload
 * provenance, grouped by source upload (F-107; feeds the F-053 "My Uploads"
 * section on Review→Vocabulary).
 *
 * "Saved" = the user kept the word via either save path (a card bank — e.g.
 * `mineWord` with `source_upload_id` — or a list add of an upload-tagged
 * entry); each word appears once with its earliest save time. The server
 * scopes everything to the session user, so only the caller's own uploads
 * (and titles) can ever appear. Returns the full envelope: `groups` (empty =
 * the honest "nothing saved from uploads yet" state the F-053 section hides
 * itself on) plus `total`/`truncated`, which say when the server's 500-row
 * cap trimmed the response — the server drops (never splits) a group the
 * cap would cut mid-group, so the flag is the only sign more saves exist.
 */
export async function fetchSavedFromUploads(
  signal?: AbortSignal,
): Promise<SavedFromUploadsResponse> {
  return api.get<SavedFromUploadsResponse>(
    '/vocab/saved-from-uploads',
    signal !== undefined ? { signal } : undefined,
  );
}

// ── Vocab lists (migration 012) ────────────────────────────────────────

/**
 * GET /vocab/lists — the user's lists (soft-deleted excluded server-side).
 *
 * `kind` narrows the query server-side via `?kind=` (`server/src/routes/
 * vocabLists.ts`'s `IndexQuerySchema`, same route family `services/hanja.ts`'s
 * `fetchHanjaLists` already uses for the hanja kind) — omit it to get every
 * kind (the pre-existing, backward-compatible default every caller before
 * this got). Filtering server-side, not just client-side after the fact,
 * matters for two reasons: (1) it's the only way to keep a non-vocab list
 * from ever reaching a vocab-scoped picker in the first place, and (2) the
 * route's `limit` defaults to 20 rows ordered by `updated_at DESC` — a
 * client-side `.filter()` after an unscoped fetch can only ever see whatever
 * mixed-kind slice of 20 the server happened to return, so a real vocab list
 * outside that window would silently never appear. Passing `kind` applies the
 * `LIMIT` AFTER the kind predicate server-side, so up to 20 real `vocab` (or
 * whichever kind) lists come back, not up to 20 lists-of-any-kind.
 */
export async function listLists(params?: {
  kind?: VocabListKind;
}): Promise<ServerVocabList[]> {
  const res = await api.get<ListListsResponse>('/vocab/lists', {
    params: stripUndef({ kind: params?.kind }),
  });
  // BIGINT `id` arrives as a JSON string — coerce to match the declared type.
  return res.lists.map(numericId);
}

/** POST /vocab/lists — create a list. Returns the row + seed-append count. */
export async function createList(
  body: CreateListBody,
): Promise<CreateListResponse> {
  const res = await api.post<CreateListResponse>(
    '/vocab/lists',
    stripUndef({ ...body }),
  );
  // BIGINT `id` arrives as a JSON string — coerce to match the declared type.
  return { ...res, list: numericId(res.list) };
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
  const res = await api.get<VocabListDetailResponse>(
    `/vocab/lists/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  // BIGINT ids (list `id`, joined `entry_id`) arrive as JSON strings —
  // coerce onto the numeric client contract so strict `===` cross-refs
  // against genuinely-numeric sibling ids can't silently miss.
  return {
    ...res,
    list: numericId(res.list),
    entries: res.entries.map((e) => ({ ...e, entry_id: coerceId(e.entry_id) })),
  };
}

/** PATCH /vocab/lists/:id — rename / re-caption / re-kind. */
export async function patchList(
  id: number,
  body: PatchListBody,
): Promise<PatchListResponse> {
  const res = await api.patch<PatchListResponse>(
    `/vocab/lists/${String(id)}`,
    body,
  );
  // BIGINT `id` arrives as a JSON string — coerce to match the declared type.
  return { ...res, list: numericId(res.list) };
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

/**
 * DELETE /vocab/lists/:id/entries/:entryId — F-091: `itemType` selects WHICH
 * target column the server deletes against (`?type=`). Defaults to `'vocab'`
 * for back-compat with every caller before this — that was the only target
 * type any live UI could add, so an unqualified call keeps its exact
 * pre-091 behavior. Callers rendering a multitype list (migration 049 — a
 * list can hold vocab AND grammar AND hanja rows whose numeric ids may
 * collide) MUST pass the row's real `item_type`, or a grammar/hanja removal
 * either 404s (nothing to delete in the vocab column) or — worse — deletes
 * an unrelated vocab row that happens to share the same numeric id.
 */
export async function removeListEntry(
  id: number,
  entryId: number,
  itemType: ListEntryItemType = 'vocab',
): Promise<void> {
  await api.delete<void>(
    `/vocab/lists/${String(id)}/entries/${String(entryId)}`,
    { params: { type: itemType } },
  );
}

/**
 * GET /vocab/lists/:id/cards/due — F-113: the due-aware twin of
 * `getDueCardsPage`, scoped to one list's vocab memberships. Reuses the exact
 * same wire shape (`DueCardWire`/`normalizeDueCard`) as the global due queue,
 * so a list-study session persists ratings through the SAME server-
 * authoritative `submitReview` path — no parallel FSRS write path.
 */
export async function getListDueCards(
  listId: number,
  limit?: number,
  signal?: AbortSignal,
): Promise<{ cards: DueCard[]; total: number }> {
  const params = limit !== undefined ? { limit } : undefined;
  const res = await api.get<{ cards: DueCardWire[]; total: number }>(
    `/vocab/lists/${String(listId)}/cards/due`,
    {
      ...(params !== undefined ? { params } : {}),
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return { cards: res.cards.map(normalizeDueCard), total: res.total };
}

/**
 * POST /vocab/lists/:id/cards/seed — F-113 bulk "add all to review": seeds a
 * recognition card for every vocab entry in the list that doesn't already
 * have one. Idempotent server-side (NOT EXISTS-gated, same convention as
 * `initCards`/`bankEntry`) — safe to call repeatedly; already-carded entries
 * are silently skipped and `inserted` only counts the new ones.
 */
export async function seedListCards(
  listId: number,
  signal?: AbortSignal,
): Promise<{ inserted: number }> {
  return api.post<{ inserted: number }>(
    `/vocab/lists/${String(listId)}/cards/seed`,
    {},
    signal !== undefined ? { signal } : undefined,
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
