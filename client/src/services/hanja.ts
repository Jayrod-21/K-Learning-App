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
import type { Hanja, HanjaProgress, HanjaState } from '../types/domain';

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
