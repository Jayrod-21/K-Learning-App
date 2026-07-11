/**
 * /hanja — Hanja (한자) character study (Pass 7).
 *
 * The Hanja screen has two read surfaces and one write:
 *   GET  /hanja?filter=        → the character pool (LEFT JOINed with the
 *                                 user's per-character state), unwrapped from
 *                                 the `{ characters }` envelope.
 *   GET  /hanja/today          → one featured character the server weights
 *                                 toward the user's recently-mined words,
 *                                 unwrapped from `{ character }` (may be null
 *                                 on an empty corpus).
 *   GET  /hanja/progress       → the aggregate Encountered-band counts.
 *   POST /hanja/:char/state    → upsert this user's state for one character.
 *
 * Shape note: the server emits a DTO that matches the client `Hanja` domain
 * type field-for-field (id/ch/sound/gloss/en/level/strokes/state/note/
 * compounds[]), so `fetchHanjaList`/`fetchHanjaToday` are typed pass-throughs
 * that only unwrap the envelope — there is no per-field mapping. `HanjaProgress`
 * matches `GET /hanja/progress` verbatim, so that helper returns the body as-is.
 *
 * Threat model:
 *   - **Auth + session.** Every route is `requireAuth` + `cheapLimiter`
 *     server-side; the session cookie rides via `withCredentials` on the shared
 *     axios instance. No bearer token is read or echoed from JS.
 *   - **CSRF.** `setHanjaState` is a POST → a CSRF surface, defended by the
 *     `SameSite=Strict` session cookie. If the cookie ever relaxes to `Lax`
 *     (e.g. OAuth callbacks), a CSRF double-submit token MUST be added at the
 *     api layer (see `services/api.ts`). The three GETs are read-only — no CSRF
 *     surface of their own.
 *   - **Path-traversal / injection.** `setHanjaState` interpolates `char` into
 *     the path, but the screen only ever passes a `Hanja.ch` value that
 *     originated from the server pool (a single CJK glyph), not a free-form user
 *     string. The character is URL-encoded here as defence-in-depth, and the
 *     server re-validates it as exactly one hanja character and parameterises
 *     all SQL.
 *   - **IDOR.** `hanja_characters` / `hanja_compounds` are public reference data
 *     (no ownership to leak). `hanja_progress` is keyed `UNIQUE(user_id, char)`
 *     and stamped with the session `user_id` server-side, so a client cannot
 *     read or write another user's state regardless of what it sends.
 *   - **No answer-secret concern.** Hanja are public reference data; the gloss,
 *     sound, and compounds are served inline by design — there is nothing to
 *     strip or grade server-side.
 *   - **Rendered text is escaped.** Every Korean / CJK string (gloss, sound,
 *     etymology note, compound readings) renders as React children, so a
 *     malicious server payload becomes literal text, not markup.
 *
 * Signal note: the optional `signal` lets a direct caller cancel an in-flight
 * request. `fetchHanjaList` / `fetchHanjaToday` / `fetchHanjaProgress` are
 * consumed through `useEndpointOrMock`, whose `realFn` contract is no-arg and
 * which owns cancellation itself (it drops the resolution via `raceAgainstAbort`
 * on unmount) — the Hanja screen therefore calls them with no signal. The param
 * is kept for symmetry with the other services and for future direct callers.
 */
import { api } from './api';
import type {
  FsrsRating,
  Hanja,
  HanjaProgress,
  HanjaState,
  ListListsResponse,
  ServerVocabList,
} from '../types/domain';

/** Filter for `GET /hanja`. Omit (or `'all'`) to draw the whole pool. */
export type HanjaListFilter = 'all' | HanjaState;

/** Envelope returned by `GET /hanja`. */
interface HanjaListEnvelope {
  characters: Hanja[];
}

/** Envelope returned by `GET /hanja/today`. `character` is null on empty corpus. */
interface HanjaTodayEnvelope {
  character: Hanja | null;
}

/** Result returned by `POST /hanja/:char/state`. */
export interface HanjaStateResult {
  char: string;
  state: HanjaState;
}

/**
 * GET /hanja — the character pool with this user's per-character state.
 *
 * Returns the array unwrapped from the `{ characters }` envelope. The server
 * DTO already matches `Hanja` (including `id` and the nested `compounds`), so
 * this is a typed pass-through. The optional `filter` is forwarded only when it
 * narrows the draw — `undefined` / `'all'` requests the whole pool, letting the
 * server apply its own default rather than receiving an explicit `'all'` it
 * would have to special-case.
 */
export async function fetchHanjaList(
  filter?: HanjaListFilter,
  signal?: AbortSignal,
): Promise<Hanja[]> {
  const params =
    filter !== undefined && filter !== 'all' ? { filter } : undefined;
  const config =
    params !== undefined && signal !== undefined
      ? { params, signal }
      : params !== undefined
        ? { params }
        : signal !== undefined
          ? { signal }
          : undefined;

  const res = await api.get<HanjaListEnvelope>('/hanja', config);
  return res.characters;
}

/**
 * GET /hanja/today — the server-weighted featured character.
 *
 * The server owns the weighting (recently-mined words → highest-frequency
 * unbanked → deterministic-by-day) and returns `{ character: null }` on an
 * empty corpus. This helper unwraps the envelope and surfaces the `null`
 * straight through so the screen can paint an empty state instead of guessing
 * a featured character client-side.
 */
export async function fetchHanjaToday(
  signal?: AbortSignal,
): Promise<Hanja | null> {
  const res = await api.get<HanjaTodayEnvelope>(
    '/hanja/today',
    signal !== undefined ? { signal } : undefined,
  );
  return res.character;
}

/**
 * GET /hanja/progress — the aggregate Encountered-band counts.
 *
 * The server DTO maps 1:1 onto `HanjaProgress` (banked / practicing / new /
 * targetL4 / encountered / note), so this returns the body unchanged.
 */
export async function fetchHanjaProgress(
  signal?: AbortSignal,
): Promise<HanjaProgress> {
  return api.get<HanjaProgress>(
    '/hanja/progress',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /hanja/:char/state — set this user's state for one character.
 *
 * Upserts the `hanja_progress` row (keyed `UNIQUE(user_id, char)`) to `state`
 * and returns the confirmed `{ char, state }`. `char` is URL-encoded as
 * defence-in-depth (see threat model); the server re-validates it as a single
 * hanja character. The screen treats this as a state mutation it follows with a
 * list + progress refetch — a failed call must surface as an error and leave
 * the screen's data untouched (the refetch is gated on success).
 */
export async function setHanjaState(
  char: string,
  state: HanjaState,
  signal?: AbortSignal,
): Promise<HanjaStateResult> {
  return api.post<HanjaStateResult>(
    `/hanja/${encodeURIComponent(char)}/state`,
    { state },
    signal !== undefined ? { signal } : undefined,
  );
}

// ─────────────────────────────────────────────────────────────
// FSRS flashcards + lists (F-075 / B-028 — Phase 3C-1)
//
// The card routes ride the SHARED FSRS scheduler (migration 050 —
// `vocab_cards` rows with a `hanja_character_id` target); list membership
// rides the shared vocab-lists infra (migration 049 — the multitype
// `vocab_list_entries` XOR columns). Same threat posture as the routes
// above: cookie session (`requireAuth`), user-scoped reads/writes, the one
// path segment we interpolate (`char`) URL-encoded as defence-in-depth and
// re-validated server-side, all ids serialised via String() into fixed
// route templates. Scheduling is SERVER-authoritative — the client sends
// only its rating + `expected_version`; a 409 means the snapshot is stale
// and the caller must refetch before replaying.
// ─────────────────────────────────────────────────────────────

/**
 * One due hanja recognition card, as served by `GET /hanja/cards/due`.
 * `stability` / `difficulty` are NUMERIC → strings on the wire
 * (precision-safe, same convention as `/vocab/cards/due`); `due_at` is an
 * ISO timestamp string. `version` MUST be echoed back as
 * `expected_version` on the review submit (optimistic concurrency).
 */
export interface HanjaDueCard {
  id: number;
  face: string;
  due_at: string;
  fsrs_state: string;
  stability: string;
  difficulty: string;
  version: number;
  hanja_character_id: number;
  ch: string;
  sound: string;
  gloss: string;
  en: string;
  level: string;
  strokes: number;
}

/** Envelope returned by `GET /hanja/cards/due`. */
interface HanjaDueCardsEnvelope {
  cards: HanjaDueCard[];
}

/**
 * GET /hanja/cards/due — this user's due hanja cards, oldest-due first.
 * Server default page is 20; pass `limit` (1–200) to widen a session.
 */
export async function fetchHanjaDueCards(
  limit?: number,
  signal?: AbortSignal,
): Promise<HanjaDueCard[]> {
  const res = await api.get<HanjaDueCardsEnvelope>('/hanja/cards/due', {
    ...(limit !== undefined ? { params: { limit } } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.cards;
}

/** Result of `POST /hanja/:char/card`. `created` is false when the card
 *  already existed (the call is idempotent — 200 vs 201 server-side). */
export interface SeedHanjaCardResult {
  card_id: number;
  /** The numeric `hanja_characters.id` — the id list membership needs. */
  character_id: number;
  ch: string;
  face: string;
  due_at: string;
  version: number;
  created: boolean;
}

/**
 * POST /hanja/:char/card — seed a recognition card for one character.
 * Idempotent: a repeat call returns the existing live card with
 * `created: false`. A fresh card is immediately due. 404s when the
 * character is not in the corpus.
 */
export async function seedHanjaCard(
  char: string,
  signal?: AbortSignal,
): Promise<SeedHanjaCardResult> {
  return api.post<SeedHanjaCardResult>(
    `/hanja/${encodeURIComponent(char)}/card`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

/** Body for `POST /hanja/cards/:cardId/reviews`. */
export interface HanjaCardReviewBody {
  rating: FsrsRating;
  /** Milliseconds the card was on screen; server caps at INT4. */
  duration_ms?: number;
  /** The `version` from the due-card row — 409 when stale. */
  expected_version: number;
}

/** Result of `POST /hanja/cards/:cardId/reviews`. */
export interface HanjaCardReviewResult {
  version: number;
  due_at: string;
  scheduled_days: number;
}

/**
 * POST /hanja/cards/:cardId/reviews — self-rate a due hanja card. The
 * server locks the row, derives the FSRS transition, and reschedules; a
 * stale `expected_version` 409s (caller refetches the queue), an unknown /
 * cross-user / non-hanja card 404s.
 */
export async function submitHanjaCardReview(
  cardId: number,
  body: HanjaCardReviewBody,
  signal?: AbortSignal,
): Promise<HanjaCardReviewResult> {
  return api.post<HanjaCardReviewResult>(
    `/hanja/cards/${String(cardId)}/reviews`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * GET /vocab/lists?kind=hanja — this user's hanja-kind lists. Same route
 * family as `services/vocab.listLists`, narrowed server-side to the hanja
 * kind so the Hanja screen never pages through vocab/grammar lists.
 * BIGINT `id` arrives as a JSON string — coerced onto the numeric contract.
 */
export async function fetchHanjaLists(
  signal?: AbortSignal,
): Promise<ServerVocabList[]> {
  const res = await api.get<ListListsResponse>('/vocab/lists', {
    params: { kind: 'hanja', limit: 100 },
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.lists.map((l) => ({ ...l, id: Number(l.id) }));
}

/**
 * One joined membership row inside a list's detail, as the multitype
 * (migration 049) `GET /vocab/lists/:id` serves it. `entry_id` is the
 * TARGET id in the type's own table (for hanja rows: the numeric
 * `hanja_characters.id`); `item_type` says which of the joined column
 * families is populated — the hanja_* fields are null on non-hanja rows.
 */
export interface HanjaListEntryRow {
  entry_id: number;
  item_type: 'vocab' | 'grammar' | 'hanja';
  position: number;
  added_at: string;
  hanja_char: string | null;
  hanja_sound: string | null;
  hanja_gloss_en: string | null;
  hanja_level: string | null;
}

/** Envelope for the hanja-typed view of `GET /vocab/lists/:id`. */
export interface HanjaListDetail {
  list: ServerVocabList;
  entries: HanjaListEntryRow[];
}

/**
 * GET /vocab/lists/:id — list detail with the 049 multitype columns the
 * hanja screen renders (`item_type` + `hanja_*`). `services/vocab
 * .getListDetail` predates 049 and types only the vocab columns, so the
 * hanja surface fetches through this typed view instead. BIGINT ids are
 * coerced to numbers (node-postgres serialises int8 as strings).
 */
export async function fetchHanjaListDetail(
  id: number,
  signal?: AbortSignal,
): Promise<HanjaListDetail> {
  const res = await api.get<HanjaListDetail>(
    `/vocab/lists/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return {
    list: { ...res.list, id: Number(res.list.id) },
    entries: res.entries.map((e) => ({ ...e, entry_id: Number(e.entry_id) })),
  };
}

/**
 * POST /vocab/lists/:id/entries — append hanja characters (by numeric
 * `hanja_characters.id`) to a list via the 049 typed-items shape. The
 * server 409s on a duplicate membership (NOT a silent skip) — callers
 * treat `ApiError(status: 409)` as "already in this list".
 */
export async function addHanjaToList(
  listId: number,
  characterIds: number[],
  signal?: AbortSignal,
): Promise<void> {
  await api.post<unknown>(
    `/vocab/lists/${String(listId)}/entries`,
    { items: characterIds.map((id) => ({ type: 'hanja' as const, id })) },
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * DELETE /vocab/lists/:id/entries/:entryId?type=hanja — remove one hanja
 * membership. `type=hanja` addresses the 049 XOR column; without it the
 * server defaults to the legacy vocab column and 404s.
 */
export async function removeHanjaFromList(
  listId: number,
  characterId: number,
  signal?: AbortSignal,
): Promise<void> {
  await api.delete<void>(
    `/vocab/lists/${String(listId)}/entries/${String(characterId)}?type=hanja`,
    signal !== undefined ? { signal } : undefined,
  );
}
