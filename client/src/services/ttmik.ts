/**
 * /ttmik + /iyagi — TTMIK lesson / Iyagi episode audio + transcripts (F-012).
 *
 * Read-only browse + detail endpoints for the Listen screen. The detail
 * responses carry an app-relative `audioUrl` (`/ttmik/lessons/2/21/audio`,
 * `/iyagi/episodes/143/audio`) that streams `audio/mpeg` with HTTP Range
 * support, or `null` when no audio file is mapped.
 *
 * Threat model:
 *   - All routes are GET — no CSRF surface. The cookie session rides via
 *     `withCredentials` on the shared axios instance for the JSON calls.
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
 * The ONLY two app-relative shapes the server emits for `audioUrl`. A prefix
 * heuristic ("starts with `/` but not `//`") is bypassable — the browser and the
 * URL parser normalize a leading backslash or an embedded tab/newline into `//`,
 * so e.g. `"/\\evil.example/a.mp3"` would slip through and resolve to an attacker
 * origin. Anchoring to the exact route shapes (digits + literal segments only)
 * makes any off-origin / tampered `audioUrl` impossible to smuggle through.
 */
const AUDIO_URL_ALLOW = /^\/(?:ttmik\/lessons\/\d+\/\d+|iyagi\/episodes\/\d+)\/audio$/;

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
