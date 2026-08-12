/**
 * /reading — U3b digitized chapter reader client (server: routes/reading.ts,
 * `db/docs/U3_READER_DESIGN.md` §U3b). Mirrors `services/uploads.ts`'s shape
 * — typed wire↔domain boundary, `AbortSignal` on every call. Covers:
 *   - the two read-only chapter GETs (ordered chapter list for one owned
 *     literature `BookUpload`; one chapter's metadata + ordered passages);
 *   - the per-upload resume position (F-069; `reading_positions`, migration
 *     051): `GET`/`PUT /reading/position/:uploadId`;
 *   - AI-generated short stories (F-068; `generated_stories`, migration
 *     054): `POST /reading/generate`, `GET /reading/generated`,
 *     `GET /reading/generated/:id`.
 *   - Reading-completion attempts (F-172; `reading_attempts`, migration 060):
 *     `POST /reading/attempts`, `GET /reading/attempts`.
 *   - Story TTS audio (F-210; `story_audio_jobs` + audio tables, migration
 *     081): `POST`/`GET /reading/generated/:id/audio` — request narration,
 *     then poll the status envelope until done/failed.
 *
 * Threat model:
 *   - Auth + session: every route is `requireAuth` server-side; the session
 *     cookie rides via `withCredentials` on the shared axios instance
 *     (services/api.ts) — no extra plumbing needed here.
 *   - IDOR: every row is scoped server-side to the session `user_id`
 *     (routes/reading.ts's own header) — a foreign or missing
 *     `source_upload_id`/`chapterId`/story id uniformly 404s (never 403, so
 *     id-space probing reveals nothing). This client never has to reason
 *     about ownership; a failed lookup just surfaces as an `ApiError`.
 *   - Writes: `PUT /reading/position/:uploadId` and `POST /reading/generate`
 *     ride the `SameSite=Strict` cookie posture owned by `services/api.ts`
 *     (ADR-002). The generate route is in the server's EXPENSIVE rate-limit
 *     bucket — 429 (with `retryAfter`) is a first-class error path for the
 *     UI, not an exceptional one.
 *   - Free text: `topic` is this module's only user free text; the server
 *     bounds it (1..500) and the Claude proxy sanitizes + wraps it as
 *     untrusted data again. It is sent as a JSON body value — never
 *     interpolated into the URL.
 *   - Ids: unlike `services/uploads.ts` (whose BIGINT ids arrive as wire
 *     strings and get held as `string`), `routes/reading.ts` already
 *     converts every BIGINT id to a JSON number server-side (`Number(...)`
 *     — see its header), so no string/number split is needed on this side
 *     of the boundary. `uploadId` params take `BookUpload.id` (the wire
 *     string) — the server's Zod schemas coerce.
 *   - Display fields (`title`, `body`, `bodyKo`, `prompt`) render as React
 *     text children downstream (Reading.tsx / TapKorean) — escaped, never
 *     HTML. That includes Claude-authored story text: model output is
 *     untrusted display data like any other.
 *   - Reading attempts (F-172): `POST /reading/attempts` is a plain, cheap
 *     write (no Claude call) — a missing/foreign `chapterId`/`storyId` 404s,
 *     same IDOR posture as every other id on this surface. `titleSnapshot` in
 *     the response is server-derived; this client never sends free-text
 *     "history" copy.
 */
import { api, ApiError } from './api';
import type {
  ReadingChapter,
  ReadingChapterSummary,
  ReadingPassage,
} from '../types/domain';

/** Wire shape of one row in the chapter-list envelope. */
interface ChapterListRowWire {
  id: number;
  chapter_number: number;
  title: string | null;
  start_page: number | null;
  end_page: number | null;
}

/** Envelope returned by `GET /reading/chapters`. */
interface ChaptersListEnvelope {
  chapters: ChapterListRowWire[];
}

/** Wire shape of the chapter-detail endpoint's `chapter` field. */
interface ChapterWire {
  id: number;
  source_upload_id: number;
  chapter_number: number;
  title: string | null;
  start_page: number | null;
  end_page: number | null;
}

/** Wire shape of one row in the chapter-detail endpoint's `passages` field. */
interface PassageWire {
  id: number;
  passage_number: number;
  body: string;
  page_number: number | null;
}

/** Envelope returned by `GET /reading/chapters/:chapterId`. */
interface ChapterDetailEnvelope {
  chapter: ChapterWire;
  passages: PassageWire[];
}

function toChapterSummary(wire: ChapterListRowWire): ReadingChapterSummary {
  return {
    id: wire.id,
    chapterNumber: wire.chapter_number,
    title: wire.title,
    startPage: wire.start_page,
    endPage: wire.end_page,
  };
}

function toChapter(wire: ChapterWire): ReadingChapter {
  return {
    id: wire.id,
    sourceUploadId: wire.source_upload_id,
    chapterNumber: wire.chapter_number,
    title: wire.title,
    startPage: wire.start_page,
    endPage: wire.end_page,
  };
}

function toPassage(wire: PassageWire): ReadingPassage {
  return {
    id: wire.id,
    passageNumber: wire.passage_number,
    body: wire.body,
    pageNumber: wire.page_number,
  };
}

/**
 * GET /reading/chapters?source_upload_id= — the ordered chapter list for one
 * owned literature upload (the reader's chapter selector). `sourceUploadId`
 * takes `BookUpload.id` (the wire-string upload id) — the server's Zod query
 * schema coerces it to a number, so no client-side parse/validation is
 * needed here. 404s (as `ApiError`) if the upload isn't the caller's or
 * doesn't exist.
 */
export async function listChapters(
  sourceUploadId: string,
  signal?: AbortSignal,
): Promise<ReadingChapterSummary[]> {
  const res = await api.get<ChaptersListEnvelope>('/reading/chapters', {
    params: { source_upload_id: sourceUploadId },
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.chapters.map(toChapterSummary);
}

/**
 * GET /reading/chapters/:chapterId — one chapter's metadata plus its ordered
 * passages (the reader body). 404s (as `ApiError`) for a missing or
 * cross-user chapter id.
 */
export async function getChapter(
  chapterId: number,
  signal?: AbortSignal,
): Promise<{ chapter: ReadingChapter; passages: ReadingPassage[] }> {
  const res = await api.get<ChapterDetailEnvelope>(
    `/reading/chapters/${String(chapterId)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return {
    chapter: toChapter(res.chapter),
    passages: res.passages.map(toPassage),
  };
}

// ─────────────────────────────────────────────────────────────
// Resume position (F-069 — reading_positions, migration 051)
// ─────────────────────────────────────────────────────────────

/** Wire shape of a saved position (the route's PositionDto — snake_case,
 *  BIGINTs already coerced to numbers; `updated_at` is a serialized Date). */
interface PositionWire {
  source_upload_id: number;
  chapter_id: number | null;
  passage_number: number | null;
  page_number: number | null;
  updated_at: string;
}

/** Envelope shared by the position GET and PUT. */
interface PositionEnvelope {
  position: PositionWire | null;
}

/**
 * The user's saved resume spot for one upload. `chapterId` can be null for a
 * page-only position (or after a book re-load SET-NULLed it — the server
 * normalizes a fully-degraded row to `position: null`, so a non-null
 * position always points somewhere).
 */
export interface ReadingPosition {
  sourceUploadId: number;
  chapterId: number | null;
  passageNumber: number | null;
  pageNumber: number | null;
  updatedAt: string;
}

function toPosition(wire: PositionWire): ReadingPosition {
  return {
    sourceUploadId: wire.source_upload_id,
    chapterId: wire.chapter_id,
    passageNumber: wire.passage_number,
    pageNumber: wire.page_number,
    updatedAt: wire.updated_at,
  };
}

/**
 * GET /reading/position/:uploadId — the saved resume position for one owned
 * upload, or null when none is saved yet (a normal state, not an error).
 * 404s (as `ApiError`) for a missing/foreign upload.
 */
export async function getReadingPosition(
  uploadId: string,
  signal?: AbortSignal,
): Promise<ReadingPosition | null> {
  const res = await api.get<PositionEnvelope>(
    `/reading/position/${encodeURIComponent(uploadId)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.position === null ? null : toPosition(res.position);
}

/**
 * What a position save points at. PUT semantics server-side: this is a FULL
 * replace — fields left null clear to null. The server enforces the two
 * semantic invariants (must reference a chapter and/or a page;
 * `passageNumber` only within a chapter), so this client always sends all
 * three keys explicitly rather than relying on omission.
 */
export interface SaveReadingPositionInput {
  chapterId: number | null;
  passageNumber?: number | null;
  pageNumber?: number | null;
}

/**
 * PUT /reading/position/:uploadId — upsert the one-row-per-(user, book)
 * resume position. Returns the saved row as the server now holds it.
 */
export async function saveReadingPosition(
  uploadId: string,
  input: SaveReadingPositionInput,
  signal?: AbortSignal,
): Promise<ReadingPosition> {
  const res = await api.put<PositionEnvelope>(
    `/reading/position/${encodeURIComponent(uploadId)}`,
    {
      chapter_id: input.chapterId,
      passage_number: input.passageNumber ?? null,
      page_number: input.pageNumber ?? null,
    },
    signal !== undefined ? { signal } : undefined,
  );
  if (res.position === null) {
    // The PUT contract always returns the upserted row; a null here means
    // the server broke its own contract — fail loud rather than pretend.
    throw new ApiError('position save returned no position', {
      status: 500,
      code: 'server_error',
    });
  }
  return toPosition(res.position);
}

// ─────────────────────────────────────────────────────────────
// Generated stories (F-068 — generated_stories, migration 054)
// ─────────────────────────────────────────────────────────────

/** Story generation target bands (the server's StoryLevelBodySchema —
 *  'basic' is a legacy corpus tag, never a generation target). */
export type GeneratedStoryLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5+';

/** In display order, for level pickers. */
export const GENERATED_STORY_LEVELS: ReadonlyArray<GeneratedStoryLevel> = [
  'L1',
  'L2',
  'L3',
  'L4',
  'L5+',
];

/**
 * One list row of the user's generated-story library
 * (`GET /reading/generated` — metadata only, no body). The story routes
 * return camelCase directly (unlike the position DTO), so the wire shape IS
 * this shape with `createdAt` as a serialized Date string. `level` stays a
 * plain string on read: the column admits legacy values beyond the
 * generation enum, and the UI only displays it.
 */
export interface GeneratedStorySummary {
  id: number;
  title: string;
  level: string;
  /** The user's topic at generation time, when one was given. */
  prompt: string | null;
  createdAt: string;
}

/**
 * One narrated/dialogue line of a story's multi-voice split (F-210
 * groundwork — `generated_stories.turns`, migration 081). `speaker` is
 * `"narrator"` or a character label the model chose; `text` is that turn's
 * verbatim slice of the story. LATENT on this client: the wire carries it,
 * but every reader surface renders from `bodyKo` — do NOT build UI on
 * `turns` until the multi-voice phase lands.
 */
export interface StoryTurn {
  speaker: string;
  text: string;
}

/** One full generated story (`POST /reading/generate`,
 *  `GET /reading/generated/:id`). `turns` is null for stories generated
 *  before migration 081 or when the model emitted no split; optional so
 *  pre-F-210 fixtures/consumers stay valid (the wire always carries it). */
export interface GeneratedStory extends GeneratedStorySummary {
  bodyKo: string;
  turns?: StoryTurn[] | null;
}

interface StoryEnvelope {
  story: GeneratedStory;
}

interface StoriesEnvelope {
  stories: GeneratedStorySummary[];
}

/** What a generation request asks for. `topic` is optional free text —
 *  the server bounds it to 1..500 chars (Zod 400s an empty/overlong one). */
export interface GenerateStoryInput {
  level: GeneratedStoryLevel;
  topic?: string;
}

/**
 * POST /reading/generate — Claude authors a short Korean story at the given
 * level; the server persists it and returns the full story (201). Expensive
 * route: expect 429 (`ApiError.retryAfter`) as a first-class failure, plus
 * 502 for an upstream Claude failure — neither writes a story row.
 */
export async function generateStory(
  input: GenerateStoryInput,
  signal?: AbortSignal,
): Promise<GeneratedStory> {
  const res = await api.post<StoryEnvelope>(
    '/reading/generate',
    {
      level: input.level,
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
    },
    signal !== undefined ? { signal } : undefined,
  );
  return res.story;
}

/** GET /reading/generated — the user's story library, newest first
 *  (metadata only; fetch a body via `getGeneratedStory`). */
export async function listGeneratedStories(
  signal?: AbortSignal,
): Promise<GeneratedStorySummary[]> {
  const res = await api.get<StoriesEnvelope>(
    '/reading/generated',
    signal !== undefined ? { signal } : undefined,
  );
  return res.stories;
}

/** GET /reading/generated/:id — one generated story, full body. 404s (as
 *  `ApiError`) for a missing or foreign id. */
export async function getGeneratedStory(
  id: number,
  signal?: AbortSignal,
): Promise<GeneratedStory> {
  const res = await api.get<StoryEnvelope>(
    `/reading/generated/${String(id)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.story;
}

// ─────────────────────────────────────────────────────────────
// Story TTS audio (F-210 — story_audio_jobs + audio_* tables,
// migration 081)
// ─────────────────────────────────────────────────────────────

/** Lifecycle of a story's TTS narration (`story_audio_jobs` + the voiced
 *  `audio_sources` set — see routes/reading.ts's StoryAudioDto). */
export type StoryAudioStatus = 'none' | 'pending' | 'running' | 'failed' | 'done';

/**
 * One read-along unit: `body` is the sentence text, `[startMs, endMs)` its
 * window in the track. Ordered by `segmentNumber` (1-based). A track voiced
 * without usable timing carries all-zero windows — the reader plays audio
 * but skips highlighting in that case.
 */
export interface StoryAudioSegment {
  segmentNumber: number;
  startMs: number;
  endMs: number;
  body: string;
}

/** The playable artifact once a story is voiced. `streamUrl` is the
 *  app-relative byte route (`/audio/tracks/:id/stream` — Range-enabled,
 *  same-origin cookie); resolve it through `buildAudioSrc`
 *  (services/ttmik.ts) before handing it to an `<audio>` element. */
export interface StoryAudioTrack {
  id: number;
  streamUrl: string;
  durationMs: number | null;
}

/**
 * The story-audio status envelope both F-210 routes return (already
 * camelCase on the wire — no mapping needed).
 *   - `none`            — never voiced; the UI offers "Generate audio".
 *   - `pending`/`running` — a job is in flight; poll the GET every ~2s.
 *   - `failed`          — `error` carries server-authored WHITELISTED copy
 *                         (services/tts.ts / storyAudio.ts — never raw
 *                         upstream prose), sanctioned for verbatim display;
 *                         a new POST retries.
 *   - `done`            — `track` + ordered `segments` are populated.
 */
export interface StoryAudio {
  status: StoryAudioStatus;
  jobId: number | null;
  error: string | null;
  track: StoryAudioTrack | null;
  segments: StoryAudioSegment[];
}

interface StoryAudioEnvelope {
  audio: StoryAudio;
}

/**
 * POST /reading/generated/:id/audio — request TTS narration of an owned
 * story (no body; F-210 v1 is a single narrator voice over `bodyKo`).
 * Idempotent + voice-once server-side: 200 with a `done` envelope when the
 * story is already voiced, 202 with the live/new job's envelope otherwise —
 * both resolve here; callers branch on `status` alone.
 *
 * Failure paths (all `ApiError`):
 *   - 429 `rate_limited` with NO `retryAfter` — the per-user DAILY TTS cap
 *     (a cost control): `message` is server-authored whitelisted copy
 *     ("try again tomorrow") sanctioned for verbatim display, the one
 *     F-210 exception to the fixed-copy rule (same discriminator as
 *     `imageUploadErrorMessage`'s daily Vision cap).
 *   - 429 WITH `retryAfter` — the generic short-window limiter; use
 *     `errorMessageFor`'s structured-seconds copy as usual.
 *   - 404 — missing/foreign story id (uniform IDOR posture); 400 — bad id.
 *     Both map to fixed copy at the call site, never echoed.
 */
export async function requestStoryAudio(
  id: number,
  signal?: AbortSignal,
): Promise<StoryAudio> {
  const res = await api.post<StoryAudioEnvelope>(
    `/reading/generated/${String(id)}/audio`,
    undefined,
    signal !== undefined ? { signal } : undefined,
  );
  return res.audio;
}

/**
 * GET /reading/generated/:id/audio — the story's current audio state
 * (always 200 for an owned story, whatever the status). The polling surface
 * while a job is pending/running. 404s (as `ApiError`) for a missing or
 * foreign story id.
 */
export async function getStoryAudio(
  id: number,
  signal?: AbortSignal,
): Promise<StoryAudio> {
  const res = await api.get<StoryAudioEnvelope>(
    `/reading/generated/${String(id)}/audio`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.audio;
}

// ─────────────────────────────────────────────────────────────
// Passage translation (F-116 — replaces the F-070 honest stub)
// ─────────────────────────────────────────────────────────────

interface TranslatePassageEnvelope {
  translation: string;
}

/**
 * POST /reading/translate — Claude authors a natural-English translation of
 * the given Korean passage/paragraph. Expensive route: expect 429
 * (`ApiError.retryAfter`) as a first-class failure, plus 502 for an upstream
 * Claude failure. STATELESS — nothing is persisted server-side, so a failed
 * call leaves no half-state to worry about; the caller can retry freely.
 * `passage` is this module's only free text on this call — the server bounds
 * it (1..6000) and the Claude proxy sanitizes + wraps it as untrusted data
 * again. Sent as a JSON body value — never interpolated into the URL.
 */
export async function translatePassage(
  passage: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await api.post<TranslatePassageEnvelope>(
    '/reading/translate',
    { passage },
    signal !== undefined ? { signal } : undefined,
  );
  return res.translation;
}

// ─────────────────────────────────────────────────────────────
// Reading attempts (F-172 — reading_attempts, migration 060)
// ─────────────────────────────────────────────────────────────

/**
 * One logged reading-completion event. `chapterId`/`storyId` mirror
 * whichever target `sourceKind` names; the other is always null.
 * `titleSnapshot` is server-derived (never round-tripped from client input).
 */
export interface ReadingAttempt {
  id: number;
  sourceKind: 'chapter' | 'story';
  chapterId: number | null;
  storyId: number | null;
  titleSnapshot: string;
  passageNumber: number | null;
  completedAt: string;
}

interface ReadingAttemptEnvelope {
  attempt: ReadingAttempt;
}

/** What `POST /reading/attempts` logs: a finished chapter (optionally with
 *  how far — `passageNumber`) or a finished generated story. Mirrors the
 *  server's discriminated-union body schema exactly. */
export type LogReadingAttemptInput =
  | { sourceKind: 'chapter'; chapterId: number; passageNumber?: number }
  | { sourceKind: 'story'; storyId: number };

/**
 * POST /reading/attempts — log a completed reading action (F-172). Fired once
 * from an explicit "mark as read/finished" affordance (there is no scroll- or
 * position-derived auto-completion signal this phase — see Reading.tsx's
 * `MarkChapterReadButton`/`MarkStoryFinishedButton`). 404s (as `ApiError`) for
 * a missing or foreign chapter/story id.
 */
export async function logReadingAttempt(
  input: LogReadingAttemptInput,
  signal?: AbortSignal,
): Promise<ReadingAttempt> {
  const res = await api.post<ReadingAttemptEnvelope>(
    '/reading/attempts',
    input,
    signal !== undefined ? { signal } : undefined,
  );
  return res.attempt;
}

/** Envelope from `GET /reading/attempts` — a page of history + the total. */
export interface ReadingAttemptsPage {
  attempts: ReadingAttempt[];
  total: number;
  limit: number;
  offset: number;
}

/** Query options for `GET /reading/attempts`. */
export interface ListReadingAttemptsOptions {
  limit?: number;
  offset?: number;
}

/**
 * GET /reading/attempts — the caller's own reading-completion history, newest
 * first (paged). Consumed by Today.tsx's Reading "done today" row (F-172
 * wires the write path + this history read together, in the same commit).
 */
export async function listReadingAttempts(
  opts: ListReadingAttemptsOptions = {},
  signal?: AbortSignal,
): Promise<ReadingAttemptsPage> {
  const params: Record<string, number> = {};
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<ReadingAttemptsPage>('/reading/attempts', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
}
