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
 *   - AI-generated comprehension questions (F-205; `reading_questions`,
 *     migration 086): `GET /reading/chapters/:chapterId/questions` (stored
 *     questions, empty until generated) and
 *     `POST /reading/chapters/:chapterId/questions/generate` (owner-only,
 *     explicit generation — never fired on mount).
 *   - Story TTS audio (F-210; `story_audio_jobs` + audio tables, migration
 *     081): `POST`/`GET /reading/generated/:id/audio` — request narration,
 *     then poll the status envelope until done/failed — plus
 *     `GET /reading/generated/audio`, the voiced-story list the Listen tab's
 *     "Generated Audio" section renders.
 *   - Story illustrations (F-211; `story_image_jobs` + `story_images`):
 *     `POST`/`GET /reading/generated/:id/images` — the same request/poll
 *     envelope shape as F-210, with the byte-serve sibling
 *     `GET /reading/generated/:id/image/:n/blob` consumed via `<img>`
 *     through `buildStoryImageSrc` (services/ttmik.ts).
 *   - Public reuse library (#45; `generated_stories.is_shared` +
 *     `source_story_id`, migration 109): `listLibrary` (
 *     `GET /reading/generated/shared` — every account's PUBLISHED stories,
 *     no owner PII), `publishStory`/`unpublishStory` (owner-gated
 *     `is_shared` toggle), `cloneStory` (`POST /reading/generated/:id/clone`
 *     — copy a readable story into the caller's own library at $0
 *     incremental generation cost, referencing rather than regenerating any
 *     audio/images). `getGeneratedStory`/`GET /reading/generated/:id/images`
 *     are now widened (owned OR published) — see `GeneratedStory.isOwn`.
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
import { api, ApiError, GENERATION_TIMEOUT_MS } from './api';
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
 *
 * A 404 also resolves to null (F-217): the position routes are owner-ONLY
 * (migration 051's composite FK ties `reading_positions` to the OWNER's
 * upload — widening them needs a migration), so a NON-owner opening a
 * SHARED book (F-207/F-217) 404s here even though the book itself is
 * readable. That's "no saved position for you on this book", not a failure —
 * the chapter picker must render, just without a Resume button. A genuinely
 * missing/foreign-private upload id also 404s into null, which is safe: any
 * caller showing a book already fetched it via `getUpload`, and THAT 404
 * still fails the view. Every non-404 error propagates untouched.
 */
export async function getReadingPosition(
  uploadId: string,
  signal?: AbortSignal,
): Promise<ReadingPosition | null> {
  try {
    const res = await api.get<PositionEnvelope>(
      `/reading/position/${encodeURIComponent(uploadId)}`,
      signal !== undefined ? { signal } : undefined,
    );
    return res.position === null ? null : toPosition(res.position);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
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

/**
 * F-216 — the shared per-asset lifecycle both story assets report through
 * the library list (`GET /reading/generated` — `audioStatus`/`imageStatus`
 * per row). One state machine, two assets: the server's list aggregate
 * implements the same done-authority-beats-latest-job precedence as the
 * per-story DTO builders, so a row's pip and its reader envelope can never
 * disagree. `StoryAudioStatus`/`StoryImagesStatus` below are aliases of
 * this union — the per-story envelopes ride the identical machine.
 */
export type AssetStatus = 'none' | 'pending' | 'running' | 'failed' | 'done';

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
  /** F-216 — aggregate TTS-narration state for this story (the library
   *  badge pips), computed server-side with the same precedence as the
   *  per-story audio envelope. */
  audioStatus: AssetStatus;
  /** F-216 — aggregate illustration state (same contract as
   *  `audioStatus`, over the image tables). */
  imageStatus: AssetStatus;
  /** #45 (migration 109) — whether the OWNER has published this story to
   *  the public reuse library. This list is always the caller's OWN
   *  stories, so there is no accompanying `isOwn` here (it would be a
   *  constant `true` on every row) — OPTIONAL for backward compatibility
   *  with pre-#45 fixtures/servers; absent reads as "unknown," which the
   *  Library badge treats the same as `false` (no badge). */
  isShared?: boolean;
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
 *  pre-F-210 fixtures/consumers stay valid (the wire always carries it).
 *  The F-216 aggregate statuses are OMITTED here on purpose: only the
 *  library list computes them (the reader derives live state from the
 *  dedicated audio/images envelopes instead), so this type must not claim
 *  fields the single-story wire never carries.
 *
 *  #45 (migration 109): `isOwn` distinguishes the caller's OWN story from a
 *  PUBLISHED story they are viewing but do not own (this route now widens
 *  to `user_id = $me OR is_shared = true` server-side) — the reader uses it
 *  to decide between the owner-only Publish/Unpublish control and the
 *  non-owner "Save to my library" clone action. BOTH `isOwn` and `isShared`
 *  are OPTIONAL and treated as `true`/`false` respectively when absent —
 *  every fetch before #45 was implicitly the caller's own private story, so
 *  an older server (or an existing test fixture) that omits them is read
 *  exactly as that always-true history: `isOwn: true` by default, only an
 *  explicit `false` means "this is a shared story you don't own." */
export interface GeneratedStory
  extends Omit<GeneratedStorySummary, 'audioStatus' | 'imageStatus'> {
  bodyKo: string;
  turns?: StoryTurn[] | null;
  isOwn?: boolean;
}

interface StoryEnvelope {
  story: GeneratedStory;
}

/**
 * Envelope returned by `GET /reading/generated` — the row list plus the
 * F-216 top-level capability flags. `ttsConfigured`/`imageGenConfigured`
 * follow the established dormant-deploy posture (see `StoryAudio.
 * ttsConfigured`): OPTIONAL and default-TRUE at the call sites — only an
 * explicit `false` hides the matching badge pips; a server that omits the
 * flags keeps them visible (forward-compat).
 */
export interface GeneratedStoryLibrary {
  stories: GeneratedStorySummary[];
  ttsConfigured?: boolean;
  imageGenConfigured?: boolean;
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
    // Synchronous route: the server blocks until Claude authors the whole
    // story (well past the 10 s default), so allow a full generation window.
    { timeout: GENERATION_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
  );
  return res.story;
}

/** GET /reading/generated — the user's story library, newest first
 *  (metadata + F-216 per-row asset statuses; fetch a body via
 *  `getGeneratedStory`). Returns the whole envelope: rows under `stories`
 *  plus the top-level capability flags the badge pips gate on. */
export async function listGeneratedStories(
  signal?: AbortSignal,
): Promise<GeneratedStoryLibrary> {
  return api.get<GeneratedStoryLibrary>(
    '/reading/generated',
    signal !== undefined ? { signal } : undefined,
  );
}

/** GET /reading/generated/:id — one generated story, full body. Widened for
 *  #45: readable when the caller owns it OR it has been published
 *  (`isShared`) — see `GeneratedStory.isOwn`'s doc comment. 404s (as
 *  `ApiError`) for a missing id or a foreign PRIVATE story. */
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
// Public reuse library (#45 — generated_stories.is_shared, migration 109)
// ─────────────────────────────────────────────────────────────

/**
 * One row of the public library browse listing (`GET /reading/generated/
 * shared`) — metadata only (no `bodyKo`, same split as
 * `GeneratedStorySummary`), and DELIBERATELY carries NO owner-identifying
 * field of any kind (not even a boolean) — the server's DTO is a bespoke
 * projection built for exactly that reason.
 */
export interface LibraryStorySummary {
  id: number;
  title: string;
  level: string;
  prompt: string | null;
  createdAt: string;
  audioStatus: AssetStatus;
  imageStatus: AssetStatus;
}

interface LibraryEnvelope {
  stories: LibraryStorySummary[];
}

/**
 * GET /reading/generated/shared — the public reuse library: every account's
 * PUBLISHED stories, newest first. Empty array is the normal "nothing
 * published yet" state, not an error.
 */
export async function listLibrary(signal?: AbortSignal): Promise<LibraryStorySummary[]> {
  const res = await api.get<LibraryEnvelope>(
    '/reading/generated/shared',
    signal !== undefined ? { signal } : undefined,
  );
  return res.stories;
}

/**
 * POST /reading/generated/:id/publish — the owner opts their OWN story into
 * the public library (`is_shared: true`). Idempotent (publishing an
 * already-published story just re-affirms the state, 200). Owner-gated
 * server-side: 404s (as `ApiError`) for a missing id or a story the caller
 * does not own — this client never offers the control to a non-owner (see
 * `GeneratedStory.isOwn`), but the server enforces it regardless.
 */
export async function publishStory(id: number, signal?: AbortSignal): Promise<GeneratedStory> {
  const res = await api.post<StoryEnvelope>(
    `/reading/generated/${String(id)}/publish`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
  return res.story;
}

/**
 * POST /reading/generated/:id/unpublish — the owner withdraws their OWN
 * story from the public library (`is_shared: false`). Does NOT retract any
 * clone already made from it (a clone is a full independent copy from the
 * moment it is created). Same owner-gate/idempotency posture as
 * `publishStory`.
 */
export async function unpublishStory(id: number, signal?: AbortSignal): Promise<GeneratedStory> {
  const res = await api.post<StoryEnvelope>(
    `/reading/generated/${String(id)}/unpublish`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
  return res.story;
}

/**
 * POST /reading/generated/:id/clone — copy a READABLE story (owned by the
 * caller, or published by another account) into the caller's OWN private
 * library at ZERO incremental generation cost — the server references the
 * source's already-synthesized audio/images rather than regenerating them.
 * Returns the NEW story (201), always private (`isShared: false`) and
 * always `isOwn: true` — this is how a non-owner gets a listenable copy of
 * a published story (`GET /generated/:id/audio` stays owner-only; cloning
 * first, then playing through the caller's own copy, is the MVP listen
 * path for a shared story — see routes/reading.ts's clone route). 404s (as
 * `ApiError`) for a missing id or a foreign PRIVATE story.
 */
export async function cloneStory(id: number, signal?: AbortSignal): Promise<GeneratedStory> {
  const res = await api.post<StoryEnvelope>(
    `/reading/generated/${String(id)}/clone`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
  return res.story;
}

// ─────────────────────────────────────────────────────────────
// Story TTS audio (F-210 — story_audio_jobs + audio_* tables,
// migration 081)
// ─────────────────────────────────────────────────────────────

/** Lifecycle of a story's TTS narration (`story_audio_jobs` + the voiced
 *  `audio_sources` set — see routes/reading.ts's StoryAudioDto). Since
 *  F-216 an alias of the shared `AssetStatus` machine. */
export type StoryAudioStatus = AssetStatus;

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
 *
 * `ttsConfigured` — whether this server can synthesize at all (a dormant
 * deploy without a TTS key reports `false`, and the UI hides the audio
 * section entirely rather than offering a button that can only 503).
 * OPTIONAL and default-TRUE at the call sites: an older server that omits
 * the flag keeps the feature visible (forward-compat) — only an explicit
 * `false` hides it.
 */
export interface StoryAudio {
  status: StoryAudioStatus;
  jobId: number | null;
  error: string | null;
  track: StoryAudioTrack | null;
  segments: StoryAudioSegment[];
  ttsConfigured?: boolean;
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

/**
 * One row of the caller's VOICED story library (`GET /reading/generated/
 * audio` — the Listen tab's "Generated Audio" section). Only stories with a
 * COMPLETED narration appear, so `streamUrl` is always present: the same
 * app-relative byte route as `StoryAudioTrack.streamUrl`
 * (`/audio/tracks/:id/stream`) — resolve it through `buildAudioSrc`
 * (services/ttmik.ts) before handing it to an `<audio>` element, never raw.
 * `level` stays a plain display string (same stance as
 * `GeneratedStorySummary`).
 */
export interface GeneratedAudioItem {
  id: number;
  title: string;
  level: string;
  streamUrl: string;
  durationMs: number | null;
}

interface GeneratedAudioEnvelope {
  stories: GeneratedAudioItem[];
}

/**
 * GET /reading/generated/audio — the caller's voiced stories, newest first
 * (already camelCase on the wire — no mapping needed). Empty array is the
 * normal "nothing voiced yet" state, not an error.
 */
export async function listGeneratedAudio(
  signal?: AbortSignal,
): Promise<GeneratedAudioItem[]> {
  const res = await api.get<GeneratedAudioEnvelope>(
    '/reading/generated/audio',
    signal !== undefined ? { signal } : undefined,
  );
  return res.stories;
}

// ─────────────────────────────────────────────────────────────
// Story illustrations (F-211 — story_image_jobs + story_images)
// ─────────────────────────────────────────────────────────────

/** Lifecycle of a story's AI illustrations — same state machine as
 *  `StoryAudioStatus` (see routes/reading.ts's StoryImagesDto). Since
 *  F-216 an alias of the shared `AssetStatus` machine. */
export type StoryImagesStatus = AssetStatus;

/**
 * One scene illustration once a story is illustrated. `blobUrl` is the
 * app-relative byte route (`/reading/generated/:id/image/:n/blob` —
 * same-origin cookie auth, no Range) — resolve it through
 * `buildStoryImageSrc` (services/ttmik.ts) before handing it to an `<img>`
 * element, never raw. `prompt` is the English generation scaffolding, NOT
 * user-facing copy — it must never render as visible text or alt text.
 */
export interface StoryImage {
  imageNumber: number;
  blobUrl: string;
  prompt: string;
  width: number;
  height: number;
}

/**
 * The story-images status envelope both F-211 routes return (already
 * camelCase on the wire — no mapping needed).
 *   - `none`              — never illustrated (an old/pre-F-211 story); the
 *                           UI offers "Generate illustrations".
 *   - `pending`/`running` — a job is in flight; poll the GET every ~2–3s.
 *                           A NEWLY generated story auto-enqueues its batch
 *                           when the server is configured, so a fresh story
 *                           lands here with no click.
 *   - `failed`            — `error` carries server-authored WHITELISTED copy
 *                           (never raw upstream prose), sanctioned for
 *                           verbatim display; a new POST retries.
 *   - `done`              — `images` holds the 2–4 scene illustrations.
 *
 * `imageGenConfigured` — whether this server can generate images at all (a
 * dormant deploy without the OpenAI key reports `false`, and the UI hides
 * the illustration surface entirely rather than offering a button that can
 * only 503). Typed optional and default-TRUE at the call sites — only an
 * explicit `false` hides (the F-210 `ttsConfigured` posture).
 */
export interface StoryImagesEnvelope {
  status: StoryImagesStatus;
  jobId: number | null;
  error: string | null;
  images: StoryImage[];
  imageGenConfigured?: boolean;
}

interface StoryImagesWire {
  images: StoryImagesEnvelope;
}

/**
 * POST /reading/generated/:id/images — request the 2–4 scene illustrations
 * for an owned story (no body). Idempotent + illustrate-once server-side:
 * 200 with a `done` envelope when the story is already illustrated (or a
 * live job's envelope), 202 when a new job was queued — both resolve here;
 * callers branch on `status` alone.
 *
 * Failure paths (all `ApiError`):
 *   - 429 `rate_limited` with NO `retryAfter` — the per-user DAILY image
 *     cap (a cost control): `message` is server-authored whitelisted copy
 *     sanctioned for verbatim display (the F-210 daily-TTS-cap posture).
 *   - 429 WITH `retryAfter` — the generic short-window limiter; use
 *     `errorMessageFor`'s structured-seconds copy as usual.
 *   - 503 — image generation unconfigured on this deploy (the UI should
 *     never reach this: `imageGenConfigured:false` hides the affordance).
 *   - 404 — missing/foreign story id (uniform IDOR posture); 400 — bad id.
 *     All map to fixed copy at the call site, never echoed.
 */
export async function requestStoryImages(
  id: number,
  signal?: AbortSignal,
): Promise<StoryImagesEnvelope> {
  const res = await api.post<StoryImagesWire>(
    `/reading/generated/${String(id)}/images`,
    undefined,
    signal !== undefined ? { signal } : undefined,
  );
  return res.images;
}

/**
 * GET /reading/generated/:id/images — the story's current illustration
 * state (always 200 for an owned story, whatever the status). The polling
 * surface while a job is pending/running. 404s (as `ApiError`) for a
 * missing or foreign story id.
 */
export async function getStoryImages(
  id: number,
  signal?: AbortSignal,
): Promise<StoryImagesEnvelope> {
  const res = await api.get<StoryImagesWire>(
    `/reading/generated/${String(id)}/images`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.images;
}

// ─────────────────────────────────────────────────────────────
// Unified story experience (F-216 — audio + illustrations, one tap)
// ─────────────────────────────────────────────────────────────

/**
 * Why one half of a combined-experience request did NOT enqueue a job:
 *   - `'dormant'`   — that capability is unconfigured on this deploy (no
 *                     TTS / image key); the half's own capability flag also
 *                     reports `false`, so its UI surface hides itself.
 *   - `'daily_cap'` — the per-user daily cost cap for that asset is spent;
 *                     the other half is unaffected.
 *   - `null`        — the enqueue succeeded, a job was already live, or the
 *                     asset is already done (nothing to enqueue).
 */
export type EnqueueBlocked = null | 'dormant' | 'daily_cap';

/**
 * What `POST /reading/generated/:id/experience` resolves to: BOTH asset
 * envelopes (byte-identical to their dedicated GET routes' DTOs, built
 * AFTER the enqueue attempts so each reflects current state) plus the
 * per-half `enqueueBlocked` discriminator. The caller seeds these straight
 * into the audio/images state machines — a pending/running half starts its
 * poll exactly as its own POST's 202 would.
 */
export interface StoryExperienceResult {
  audio: StoryAudio & { enqueueBlocked: EnqueueBlocked };
  images: StoryImagesEnvelope & { enqueueBlocked: EnqueueBlocked };
}

interface StoryExperienceWire {
  experience: StoryExperienceResult;
}

/**
 * POST /reading/generated/:id/experience — one-tap combined generation:
 * the server attempts BOTH the audio and the illustration enqueue, each
 * independently caught, so a dormant or daily-capped half never blocks the
 * other. 202 when either half is left pending/running, 200 when both are
 * settled — both resolve here; callers branch on the per-half `status` +
 * `enqueueBlocked` alone.
 *
 * Failure paths (all `ApiError`) — WHOLE-call failures only (per-half
 * problems arrive as `enqueueBlocked`, never as a throw):
 *   - 429 WITH `retryAfter` — the generic expensive-route limiter; use
 *     `errorMessageFor`'s structured-seconds copy as usual.
 *   - 404 — missing/foreign story id (uniform IDOR posture); 400 — bad id.
 *     Both map to fixed copy at the call site, never echoed.
 */
export async function requestStoryExperience(
  storyId: number,
  signal?: AbortSignal,
): Promise<StoryExperienceResult> {
  const res = await api.post<StoryExperienceWire>(
    `/reading/generated/${String(storyId)}/experience`,
    undefined,
    signal !== undefined ? { signal } : undefined,
  );
  return res.experience;
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
    // Synchronous Claude call — give it the full generation window so a slow
    // (or cold-start) translation doesn't abort at the 10 s default.
    { timeout: GENERATION_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
  );
  return res.translation;
}

// ─────────────────────────────────────────────────────────────
// Comprehension questions (F-205 — reading_questions, migration 086)
// ─────────────────────────────────────────────────────────────

/**
 * One STORED AI-generated multiple-choice comprehension question for a
 * chapter (routes/reading.ts's `ReadingQuestionDto` — already camelCase, and
 * `id` already arrives as a JS number post-F-203 like every other id on this
 * surface, so no `coerceId` guard is needed here (this module's established
 * id posture — see the header above). `correct` flags + `explanation` ride
 * inline deliberately: this is self-assessment content, not a proctored
 * exam, so the client reveals on answer (Diagnostic study mode's model).
 */
export interface ReadingQuestion {
  id: number;
  questionNumber: number;
  questionText: string;
  options: Array<{ text: string; correct: boolean }>;
  explanation: string;
  kind: string;
}

interface QuestionsEnvelope {
  questions: ReadingQuestion[];
}

/**
 * GET /reading/chapters/:chapterId/questions — the chapter's STORED
 * comprehension questions, in `questionNumber` order. Empty array is the
 * normal "not generated yet" state, not an error (F-205 ships EMPTY-safe).
 * Rides the chapter-detail read gate (owned OR shared parent book); 404s (as
 * `ApiError`) for a missing/foreign chapter id.
 */
export async function getChapterQuestions(
  chapterId: number,
  signal?: AbortSignal,
): Promise<ReadingQuestion[]> {
  const res = await api.get<QuestionsEnvelope>(
    `/reading/chapters/${String(chapterId)}/questions`,
    signal !== undefined ? { signal } : undefined,
  );
  return res.questions;
}

/**
 * POST /reading/chapters/:chapterId/questions/generate — owner-only; Claude
 * authors a fresh MC comprehension check from the chapter's own prose, the
 * server persists it, and returns the full set. EXPLICIT generation only
 * (F-216's never-auto-generate-on-load posture) — this client never fires it
 * on mount, and never sends `?regenerate=true` in Phase 1 (stored questions
 * always short-circuit at $0 server-side). Expensive route: 429 is a
 * first-class failure — the short-window flavor carries `retryAfter`
 * (`errorMessageFor`'s structured copy), while the per-user DAILY cap
 * flavor carries NO `retryAfter` and a server-authored WHITELISTED message
 * sanctioned for verbatim display (the F-210/F-211 daily-cap posture); 502
 * covers an upstream Claude failure. Neither writes a row.
 */
export async function generateChapterQuestions(
  chapterId: number,
  signal?: AbortSignal,
): Promise<ReadingQuestion[]> {
  const res = await api.post<QuestionsEnvelope>(
    `/reading/chapters/${String(chapterId)}/questions/generate`,
    undefined,
    // Synchronous route: Claude authors the question set inline — allow the
    // full generation window instead of the 10 s default.
    { timeout: GENERATION_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
  );
  return res.questions;
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
