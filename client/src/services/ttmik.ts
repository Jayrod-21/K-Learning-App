/**
 * /ttmik + /iyagi — TTMIK lesson / Iyagi episode audio + transcripts (F-012).
 *
 * Read-only browse + detail endpoints for the Listen screen. The detail
 * responses carry an app-relative `audioUrl` (`/ttmik/lessons/2/21/audio`,
 * `/iyagi/episodes/143/audio`) that streams `audio/mpeg` with HTTP Range
 * support, or `null` when no audio file is mapped.
 *
 * Also covers listening-completion attempts (F-172; `listening_attempts`,
 * migration 061) — the one WRITE surface on this otherwise read-only module:
 * `POST /ttmik/attempts`, `POST /iyagi/attempts`, `GET /ttmik/attempts`.
 *
 * Threat model:
 *   - Browse/detail routes are GET — no CSRF surface. The cookie session
 *     rides via `withCredentials` on the shared axios instance for the JSON
 *     calls.
 *   - The `<audio>` element cannot use axios; {@link buildAudioSrc} joins the
 *     SAME base URL the axios instance uses (`getApiBaseUrl()`), so in prod
 *     (empty base → page origin, served same-origin via the LB) and in dev
 *     (`http://localhost:4000` from Vite on `localhost:5173` — same-site, so
 *     `SameSite=Strict` still attaches) the browser sends the session cookie
 *     on the media request without any credentials plumbing here.
 *   - Path construction: `level`/`number` are `number`-typed and stringified
 *     via `String()`; `audioUrl` comes from the server (never free-form user
 *     text) and is only accepted when it is an absolute app path (`/…`) — a
 *     protocol-relative or absolute-URL value is rejected so a compromised
 *     response body cannot point the player at a third-party origin.
 *   - Body validation: server validates. We trust TS types client-side and
 *     the page renders every string through React text children.
 *   - Listening attempts (F-172): both POST calls are plain, cheap writes (no
 *     Claude call). A garbage (level, number)/episode number 404s (as
 *     `ApiError`) — `ttmik_lessons`/`iyagi_episodes` are public corpus
 *     content, so the server's only gate is existence, not per-user
 *     ownership. `titleSnapshot` in the response is server-derived; this
 *     client never sends free-text "history" copy.
 */
import { api, getApiBaseUrl } from './api';
import type {
  IyagiEpisode,
  IyagiEpisodeDetail,
  IyagiEpisodesResponse,
  TtmikLesson,
  TtmikLessonDetail,
  TtmikLessonsResponse,
} from '../types/domain';

/** GET /ttmik/lessons — every lesson row, ordered by level then number. */
export async function getTtmikLessons(
  signal?: AbortSignal,
): Promise<TtmikLesson[]> {
  const res = await api.get<TtmikLessonsResponse>(
    '/ttmik/lessons',
    signal !== undefined ? { signal } : undefined,
  );
  return res.lessons;
}

/** GET /ttmik/lessons/:level/:number — meta + transcript + audio path. */
export async function getTtmikLesson(
  level: number,
  number: number,
  signal?: AbortSignal,
): Promise<TtmikLessonDetail> {
  return api.get<TtmikLessonDetail>(
    `/ttmik/lessons/${String(level)}/${String(number)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/** GET /iyagi/episodes — every episode row, ordered by number. */
export async function getIyagiEpisodes(
  signal?: AbortSignal,
): Promise<IyagiEpisode[]> {
  const res = await api.get<IyagiEpisodesResponse>(
    '/iyagi/episodes',
    signal !== undefined ? { signal } : undefined,
  );
  return res.episodes;
}

/** GET /iyagi/episodes/:number — meta + transcript + audio path. */
export async function getIyagiEpisode(
  number: number,
  signal?: AbortSignal,
): Promise<IyagiEpisodeDetail> {
  return api.get<IyagiEpisodeDetail>(
    `/iyagi/episodes/${String(number)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * The ONLY four app-relative shapes the server emits for a playable audio
 * path: the TTMIK/Iyagi corpus `audioUrl`s, the My Audio track
 * `streamUrl` (`/audio/tracks/:id/stream`, Track A A-4b — routes/audio.ts),
 * and the TOPIK mock exam's whole-section listening file
 * (`/topik/audio/:testNumber/:level`, F-119 — the `level` segment is exactly
 * `1` or `2`, the `GET /topik/audio` route's own contract).
 * A prefix heuristic ("starts with `/` but not `//`") is bypassable — the
 * browser and the URL parser normalize a leading backslash or an embedded
 * tab/newline into `//`, so e.g. `"/\\evil.example/a.mp3"` would slip
 * through and resolve to an attacker origin. Anchoring to the exact route
 * shapes (digits + literal segments only) makes any off-origin / tampered
 * value impossible to smuggle through.
 */
const AUDIO_URL_ALLOW =
  /^\/(?:ttmik\/lessons\/\d+\/\d+\/audio|iyagi\/episodes\/\d+\/audio|audio\/tracks\/\d+\/stream|topik\/audio\/\d+\/[12])$/;

/**
 * Resolve a detail response's `audioUrl` into a playable `<audio src>`.
 *
 * Joins the SAME API base the axios instance uses (single source of truth —
 * `getApiBaseUrl()`), so the player works in dev (Vite on :5173, API on
 * :4000 — same-site, cookie attaches) and in prod (empty base → same-origin
 * relative path through the LB).
 *
 * Returns `null` for a `null` input (no audio mapped → the page renders the
 * transcript-only state) AND for any value that does not match the strict
 * allow-list above — defending against a tampered response body steering the
 * media element to an attacker origin. We only ever concatenate `base + path`.
 *
 * `base` is injectable for tests; production callers use the default.
 */
export function buildAudioSrc(
  audioUrl: string | null,
  base: string = getApiBaseUrl(),
): string | null {
  if (audioUrl === null) return null;
  if (!AUDIO_URL_ALLOW.test(audioUrl)) return null;
  return base === '' ? audioUrl : `${base}${audioUrl}`;
}

/**
 * The ONLY app-relative shape the server emits for a story-illustration
 * blob (F-211 — routes/reading.ts `GET /reading/generated/:id/image/:n/blob`,
 * the byte-serve sibling of the images-status envelope). Same anchored
 * digits-and-literals stance as {@link buildAudioSrc}'s allow-list — a
 * prefix heuristic is bypassable via backslash/whitespace normalization,
 * an exact shape is not.
 */
const STORY_IMAGE_URL_ALLOW = /^\/reading\/generated\/\d+\/image\/\d+\/blob$/;

/**
 * Resolve a story-images envelope's `blobUrl` into an `<img src>` (F-211).
 *
 * The `<img>` element cannot use axios; this joins the SAME API base the
 * axios instance uses (`getApiBaseUrl()`), so the cookie-auth blob route
 * works in dev (Vite on :5173, API on :4000 — same-site) and in prod
 * (empty base → same-origin relative path through the LB).
 *
 * Returns `null` for any value that does not match the strict allow-list —
 * a tampered response body cannot steer the image element to an attacker
 * origin; the caller simply renders no `<img>` for a rejected value.
 *
 * `base` is injectable for tests; production callers use the default.
 */
export function buildStoryImageSrc(
  blobUrl: string,
  base: string = getApiBaseUrl(),
): string | null {
  if (!STORY_IMAGE_URL_ALLOW.test(blobUrl)) return null;
  return base === '' ? blobUrl : `${base}${blobUrl}`;
}

// ─────────────────────────────────────────────────────────────
// Listening attempts (F-172 — listening_attempts, migration 061)
// ─────────────────────────────────────────────────────────────

/**
 * One logged listening-completion event. `lessonId`/`episodeId` mirror
 * whichever target `sourceKind` names; the other is always null.
 * `titleSnapshot` is server-derived (never round-tripped from client input).
 */
export interface ListeningAttempt {
  id: number;
  sourceKind: 'ttmik_lesson' | 'iyagi_episode';
  lessonId: number | null;
  episodeId: number | null;
  titleSnapshot: string;
  completedAt: string;
}

interface ListeningAttemptEnvelope {
  attempt: ListeningAttempt;
}

/**
 * POST /ttmik/attempts — log a completed TTMIK lesson listen (F-172). Fired
 * once from the detail view's `<audio>` `ended` event (or an explicit "mark
 * listened" affordance) — this file previously wrote no user state at all.
 * 404s (as `ApiError`) for a (level, number) pair that doesn't exist.
 */
export async function logTtmikAttempt(
  level: number,
  number: number,
  signal?: AbortSignal,
): Promise<ListeningAttempt> {
  const res = await api.post<ListeningAttemptEnvelope>(
    '/ttmik/attempts',
    { level, number },
    signal !== undefined ? { signal } : undefined,
  );
  return res.attempt;
}

/**
 * POST /iyagi/attempts — log a completed Iyagi episode listen (F-172). Same
 * trigger + IDOR posture as the TTMIK lesson leg above.
 */
export async function logIyagiAttempt(
  number: number,
  signal?: AbortSignal,
): Promise<ListeningAttempt> {
  const res = await api.post<ListeningAttemptEnvelope>(
    '/iyagi/attempts',
    { number },
    signal !== undefined ? { signal } : undefined,
  );
  return res.attempt;
}

/** Envelope from `GET /ttmik/attempts` — a page of history + the total. */
export interface ListeningAttemptsPage {
  attempts: ListeningAttempt[];
  total: number;
  limit: number;
  offset: number;
}

/** Query options for `GET /ttmik/attempts`. */
export interface ListListeningAttemptsOptions {
  limit?: number;
  offset?: number;
}

/**
 * GET /ttmik/attempts — the caller's own listening-completion history, newest
 * first (paged), across BOTH TTMIK lessons and Iyagi episodes. Consumed by
 * Today.tsx's Listening "done today" row (F-172 wires the write path + this
 * history read together, in the same commit).
 */
export async function listListeningAttempts(
  opts: ListListeningAttemptsOptions = {},
  signal?: AbortSignal,
): Promise<ListeningAttemptsPage> {
  const params: Record<string, number> = {};
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<ListeningAttemptsPage>('/ttmik/attempts', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
}
