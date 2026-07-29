/**
 * /audio — the Track A "My Audio" client service (A-4b). Talks to the merged
 * A-3/A-4a server routes (server/src/routes/audio.ts):
 *
 *   POST /audio             — upload one mp3/m4a (multipart `file` + optional
 *                             `title`); the server sniffs, caps, stores the
 *                             blob and enqueues a Whisper transcription job.
 *                             201 → { sourceId, trackId, jobId,
 *                             transcriptStatus: 'pending' }.
 *   GET  /audio             — this user's audio sources (newest first) with
 *                             per-track `transcript_status` — the surface the
 *                             Listen page's My Audio listing POLLS while any
 *                             track is pending/running.
 *   GET  /audio/shared      — the F-207 curated shared corpus: the same DTO
 *                             shape as GET /audio (no owner PII on the wire),
 *                             visible to every account, read-only. `slug` is
 *                             kept here (the curated tile manifest's key).
 *   GET  /audio/tracks/:id  — one readable (owned or shared-source) track +
 *                             ordered transcript segments. `streamUrl` is the
 *                             app-relative sibling stream path the `<audio>`
 *                             element plays (resolved via services/ttmik.ts's
 *                             `buildAudioSrc` allow-list).
 *
 * Threat model (mirrors services/uploads.ts — the multipart posture is
 * deliberately identical, boundary handling included):
 *   - Auth/session: every route is `requireAuth`; the cookie rides via
 *     `withCredentials` on the shared axios instance for the JSON calls. The
 *     `<audio src>` media request is same-origin (prod) / same-site (dev) so
 *     the `SameSite=Strict` cookie attaches with no plumbing here — see
 *     `buildAudioSrc`'s own doc in services/ttmik.ts.
 *   - CSRF: `uploadAudio` is the one state-changing POST — defended by the
 *     `SameSite=Strict` session cookie (ADR-002). The GETs are read-only.
 *   - IDOR: every row is server-scoped to the session user; a foreign or
 *     missing track id is a UNIFORM 404 (`ApiError`) — the client never has
 *     to (and never can) distinguish "deleted" from "not yours".
 *   - Upload validation is server-authoritative: the magic-byte sniff
 *     (ID3/MPEG frame sync for mp3, ftyp audio brand for m4a), the per-file
 *     size cap, and the per-user daily bytes/count caps all run on every
 *     request. `checkAudioFile` below is a CONVENIENCE pre-check only — it
 *     spares the user a doomed slow upload for an obviously-wrong file.
 *   - Multipart boundary: reuses `buildMultipartConfig` (services/images.ts),
 *     which clears the JSON `Content-Type` default so the browser sets the
 *     `multipart/form-data; boundary=…` header itself.
 *   - Error copy: failures surface as `ApiError`; callers map to fixed copy
 *     via `lib/errorCopy.audioUploadErrorMessage` — server prose is never
 *     echoed.
 *
 * Signal note: every call takes an `AbortSignal` (trailing param / opts
 * field) so callers can cancel on unmount — mirrors every other service.
 */
import type { AxiosProgressEvent } from 'axios';
import { api } from './api';
import { buildMultipartConfig } from './images';
import type {
  AudioSource,
  AudioSourceKind,
  AudioTrackDetail,
  AudioTrackSummary,
  AudioTranscriptStatus,
  AudioUploadResponse,
  SharedAudioSource,
} from '../types/domain';

/**
 * Max upload size the client pre-checks before touching the network —
 * mirrors the server's `AUDIO_UPLOAD_MAX_BYTES` default (100 MiB,
 * server/src/config/index.ts). The server remains authoritative (413); this
 * only avoids a doomed slow upload.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * A 100 MiB audio file on a slow connection genuinely takes minutes — the
 * app-wide axios default (services/api.ts, 10 s, sized for synchronous JSON
 * endpoints) would misfire as `code: 'timeout'` well before a real transfer
 * completes. Same per-call override pattern as `UPLOAD_TIMEOUT_MS` in
 * services/uploads.ts, sized generously against `MAX_AUDIO_UPLOAD_BYTES`.
 */
const AUDIO_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Wire shape of one track inside `GET /audio`'s source rows (snake_case —
 *  `AudioTrackDTO` in server/src/routes/audio.ts). */
interface AudioTrackWire {
  id: number;
  track_number: number;
  title: string | null;
  byte_size: number;
  duration_ms: number | null;
  transcript_status: AudioTranscriptStatus;
}

/** Wire shape of one `GET /audio` / `GET /audio/shared` source row
 *  (`AudioSourceDTO`). `slug` is an internal server key: `listMyAudio`'s
 *  mapper drops it (the ExtractionRun field-dropping precedent,
 *  services/uploads.ts), while the shared mapper KEEPS it as the curated
 *  tile manifest's join key (F-207 — see {@link toSharedAudioSource}). */
interface AudioSourceWire {
  id: number;
  slug: string;
  title: string;
  kind: AudioSourceKind;
  created_at: string;
  tracks: AudioTrackWire[];
}

/** Envelope returned by `GET /audio`. */
interface AudioSourcesEnvelope {
  sources: AudioSourceWire[];
}

function toAudioTrackSummary(wire: AudioTrackWire): AudioTrackSummary {
  return {
    id: wire.id,
    trackNumber: wire.track_number,
    title: wire.title,
    byteSize: wire.byte_size,
    durationMs: wire.duration_ms,
    transcriptStatus: wire.transcript_status,
  };
}

function toAudioSource(wire: AudioSourceWire): AudioSource {
  return {
    id: wire.id,
    title: wire.title,
    kind: wire.kind,
    createdAt: wire.created_at,
    tracks: wire.tracks.map(toAudioTrackSummary),
  };
}

/** Unlike {@link toAudioSource}, the `slug` is KEPT here — it is the join
 *  key the Listen page's curated tile manifest matches shared sets on
 *  (F-207); for the user's own uploads it stays a server-internal detail. */
function toSharedAudioSource(wire: AudioSourceWire): SharedAudioSource {
  return {
    ...toAudioSource(wire),
    slug: wire.slug,
  };
}

/** Options for {@link uploadAudio}. */
export interface UploadAudioOptions {
  /** Display title (server caps at 500 chars; falls back to a server-derived
   *  date title when omitted — the client filename is never used server-side). */
  title?: string;
  /** Called with an integer 0-100 as the browser reports real upload bytes
   *  sent (axios's native `onUploadProgress` — never a simulated ramp). */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * POST /audio — upload one mp3/m4a and enqueue its transcription job.
 * Resolves with the fresh `{ sourceId, trackId, jobId, transcriptStatus }`
 * (camelCase on the wire already — no mapping needed). Server failures the
 * caller must map to fixed copy (never echo prose): 400 unrecognizable
 * audio / bad title, 413 over the per-file cap, 429 daily bytes/count cap
 * or the short-window limiter — see `audioUploadErrorMessage`.
 */
export async function uploadAudio(
  file: File,
  opts: UploadAudioOptions = {},
): Promise<AudioUploadResponse> {
  const form = new FormData();
  // Third arg pins the filename (uploadBook's convention); the server never
  // uses it for the title or any path — the body `title` field is the one
  // sanctioned display channel.
  form.append('file', file, file.name);
  // An empty-string title is meaningless — treat it like "omitted" so the
  // server derives its date-based fallback instead of receiving ''. (The
  // Listen page already guards this; kept here as defense-in-depth so no
  // future caller can regress it.)
  if (opts.title !== undefined && opts.title !== '') {
    form.append('title', opts.title);
  }

  const config = buildMultipartConfig(opts.signal);
  config.timeout = AUDIO_UPLOAD_TIMEOUT_MS;
  const onProgress = opts.onProgress;
  if (onProgress) {
    config.onUploadProgress = (event: AxiosProgressEvent) => {
      // `total` is absent when the browser can't determine content length up
      // front — defend rather than divide by undefined (uploadBook's stance).
      if (event.total) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
  }

  return api.post<AudioUploadResponse>('/audio', form, config);
}

/** GET /audio — this user's audio sources (newest first, server-bounded to
 *  the most recent 50), each with its tracks' transcript status. The My
 *  Audio listing re-calls this on an interval while any track is
 *  pending/running — the A-4b polling surface. */
export async function listMyAudio(signal?: AbortSignal): Promise<AudioSource[]> {
  const res = await api.get<AudioSourcesEnvelope>(
    '/audio',
    signal !== undefined ? { signal } : undefined,
  );
  return res.sources.map(toAudioSource);
}

/**
 * GET /audio/shared — the curated shared corpus (F-207): every account sees
 * the same operator-flagged sets, read-only. The envelope is the exact
 * `GET /audio` shape (server routes share one projection/grouping — no
 * owner identity on the wire), so the mapping reuses the same wire types;
 * only the `slug` is additionally retained (see {@link toSharedAudioSource}).
 */
export async function getSharedAudio(
  signal?: AbortSignal,
): Promise<SharedAudioSource[]> {
  const res = await api.get<AudioSourcesEnvelope>(
    '/audio/shared',
    signal !== undefined ? { signal } : undefined,
  );
  return res.sources.map(toSharedAudioSource);
}

/**
 * GET /audio/tracks/:id — one owned track + its ORDERED transcript segments.
 * Already camelCase on the wire (`SegmentDTO`/track block, routes/audio.ts).
 * A not-yet-transcribed track returns `segments: []` — a normal state the
 * detail view polls through. Any miss (no such track / not the caller's) is
 * a uniform 404 `ApiError`.
 */
export async function getAudioTrack(
  id: number,
  signal?: AbortSignal,
): Promise<AudioTrackDetail> {
  return api.get<AudioTrackDetail>(
    `/audio/tracks/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * Client-side pre-check ONLY — see the module threat model. Returns fixed
 * copy to show inline BEFORE hitting the network for an obviously-wrong
 * file; `null` when the file passes the (loose) client check. The server's
 * magic-byte sniff + size cap are the real authority and run regardless.
 */
export function checkAudioFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const looksLikeMp3 =
    file.type === 'audio/mpeg' || file.type === 'audio/mp3' || name.endsWith('.mp3');
  const looksLikeM4a =
    file.type === 'audio/mp4' ||
    file.type === 'audio/x-m4a' ||
    name.endsWith('.m4a');
  if (!looksLikeMp3 && !looksLikeM4a) {
    return 'That file isn’t an MP3 or M4A. Choose a .mp3 or .m4a file.';
  }
  if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
    return 'That file is too large. Pick one under 100 MB.';
  }
  return null;
}
