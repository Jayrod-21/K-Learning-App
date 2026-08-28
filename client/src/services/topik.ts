/**
 * /topik — TOPIK Prep Study mode (Pass 6).
 *
 * Study mode serves a shuffled cross-test draw of public TOPIK reference items
 * with the correct answer + explanation inline (NOT answer-stripped — the
 * answer-stripped Mock-Test taking flow is deferred to FU-NF-39). The client
 * reveals correctness off the item itself; `recordTopikAnswer` is an analytics
 * write the screen fires-and-forgets after each submit.
 *
 * The DTO the server emits for `/topik/study` matches `TopikItem` field-for-
 * field (id/section/number/level/prompt/options/explanation, optional
 * passageRef), so `fetchStudyDraw` unwraps the `{ items }` envelope and returns
 * the array as-is — no per-field mapping needed.
 *
 * Threat model:
 *   - **Auth + session.** Every route is `requireAuth` + `cheapLimiter`
 *     server-side; the session cookie rides via `withCredentials` on the shared
 *     axios instance. No bearer token is read or echoed from JS.
 *   - **CSRF.** Both routes are POST → a CSRF surface, defended by the
 *     `SameSite=Strict` session cookie. If the cookie ever relaxes to `Lax`
 *     (e.g. OAuth callbacks), a CSRF double-submit token MUST be added at the
 *     api layer (see `services/api.ts`).
 *   - **Path-traversal / injection.** `itemId` is interpolated into the path
 *     but the screen only ever passes a `TopikItem.id` that originated from the
 *     server draw — no free-form user string is concatenated into the URL.
 *     The server re-validates `itemId` as an int and parameterises all SQL.
 *   - **IDOR.** `topik_items` are public reference data (no ownership to
 *     leak); the recorded response row is stamped with the session `user_id`
 *     server-side, so a client cannot write a response under another user.
 *   - **Answer leakage.** Intentional in Study mode — TOPIK items are public
 *     and the `correct` flag is served inline by design. The Mock-Test flow
 *     that strips answers and grades server-side is FU-NF-39, not this pass.
 *   - **Rendered text is escaped.** Prompts, choices, and explanations render
 *     as React children, so a malicious server payload becomes literal text,
 *     not markup.
 *
 * Signal note: the optional `signal` lets a direct caller cancel an in-flight
 * request. `fetchStudyDraw` is consumed through `useEndpointOrMock`, whose
 * `realFn` contract is no-arg and which owns cancellation itself — the Topik
 * screen therefore calls it with no signal. The param is kept for symmetry with
 * the other services and for future direct callers.
 */
import { api } from './api';
import type {
  ChoiceId,
  GeneratedMockAssembleResponse,
  GeneratedMockProgressBody,
  GeneratedMockSubmitBody,
  GeneratedMockSubmitResult,
  GeneratedMockTier,
  MockResult,
  MockSection,
  MockSubmitBody,
  MockTest,
  TopikAnswerResult,
  TopikItem,
  TopikLevel,
  TopikMockItem,
} from '../types/domain';

/** Filter for `POST /topik/study`. All fields optional → whole-pool draw. */
export interface StudyDrawOptions {
  /** TOPIK section (Korean label). Omit to draw across all sections. */
  section?: TopikItem['section'];
  /** Cap on the draw size (server default 10, max 50). */
  limit?: number;
}

/** Envelope returned by `POST /topik/study`. */
interface StudyDrawEnvelope {
  items: TopikItem[];
}

/** Body for `POST /topik/:itemId/answer`. */
export interface RecordAnswerBody {
  /** The choice id the user submitted (`'a'|'b'|'c'|'d'`). */
  picked: string;
  /** Time-on-item in milliseconds, if the caller measured it. */
  timeMs?: number;
  /** Which flow the answer came from — Study mode passes `'study'`. */
  mode?: 'study' | 'mock';
}

/**
 * POST /topik/study — a shuffled cross-test draw matching the filter.
 *
 * Returns the items array unwrapped from the `{ items }` envelope. The server
 * DTO already matches `TopikItem` (including `id`), so this is a typed
 * pass-through EXCEPT the F-206 audio fields, which are normalized through
 * `normalizeStudyItemAudio` below (the study sibling of `normalizeMockAudio`:
 * they steer a real `<audio>` element's seek/clamp, so a malformed value must
 * degrade to "no audio" rather than reach the player). An empty filter draws
 * from the whole pool.
 */
export async function fetchStudyDraw(
  opts: StudyDrawOptions,
  signal?: AbortSignal,
): Promise<TopikItem[]> {
  // Only forward fields the caller set so the server applies its own defaults
  // for the rest (e.g. limit) rather than receiving an explicit `undefined`.
  const body: StudyDrawOptions = {};
  if (opts.section !== undefined) body.section = opts.section;
  if (opts.limit !== undefined) body.limit = opts.limit;

  const res = await api.post<StudyDrawEnvelope>(
    '/topik/study',
    body,
    signal !== undefined ? { signal } : undefined,
  );
  return res.items.map(normalizeStudyItemAudio);
}

/**
 * Normalize one study item's F-206 audio fields off the wire, mirroring
 * `normalizeMockAudio` below: the span must satisfy `readAudioSpan`
 * (both-or-neither, finite non-negative ints, end > start — a half/invalid
 * window is stripped entirely) and `audioUrl` must be a string (any other
 * shape is stripped; the strict route-shape allow-list check lives in
 * `buildAudioSrc`, which the study player calls on this value). These fields
 * steer a real `<audio>` element's seek/clamp, so a malformed value must
 * degrade to the honest "no audio" rendering rather than reach the player.
 * Everything else passes through untouched.
 */
function normalizeStudyItemAudio(item: TopikItem): TopikItem {
  const next = { ...item };
  const span = readAudioSpan(item);
  if (span !== null) {
    // Re-assign the validated pair so a valid span survives verbatim.
    next.audioStartMs = span.audioStartMs;
    next.audioEndMs = span.audioEndMs;
  } else {
    delete next.audioStartMs;
    delete next.audioEndMs;
  }
  // The wire type SAYS string-or-absent, but this came off the network —
  // re-check at runtime like the span above.
  if (typeof next.audioUrl !== 'string') {
    delete next.audioUrl;
  }
  // F-120: same posture for the exam-figure URL — anything non-string is
  // stripped (the strict route-shape allow-list check lives in
  // `buildTopikImageSrc`, which the renderer calls on this value).
  if (typeof next.imageUrl !== 'string') {
    delete next.imageUrl;
  }
  return next;
}

/**
 * POST /topik/:itemId/answer — record one study answer.
 *
 * The server grades `picked` against the item's stored answer, appends a
 * `topik_responses` row scoped to the session user, and returns the reveal
 * (`correct` + `correctChoiceId` + `explanation`). In Study mode this is an
 * analytics write the screen fires-and-forgets — the reveal is driven off the
 * inline `correct` flag, so a failed record must NOT break the study flow.
 */
export async function recordTopikAnswer(
  itemId: string,
  body: RecordAnswerBody,
  signal?: AbortSignal,
): Promise<TopikAnswerResult> {
  return api.post<TopikAnswerResult>(
    `/topik/${itemId}/answer`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /topik/mock — start a section-scoped Mock-Test (FU-NF-39).
 *
 * Sends only `{ section }`; the server PICKS a `sourceTest` that has a complete
 * set of items for that section and echoes it back so `submitMockTest` can
 * reference the same assembly. The returned items are ANSWER-STRIPPED
 * (`TopikMockItem` carries no `correct` flag and no `explanation`) — the exam
 * is graded server-side on submit, never on the client.
 *
 * `topikLevel` (F-118 / D-1 / fix-pass S-1): when the caller picked a
 * SPECIFIC past paper from `GET /topik/tests`'s per-paper list, both
 * `sourceTest` AND `topikLevel` must be sent together — a `test_number` alone
 * names TWO exams (TOPIK I and TOPIK II share every test_number), so omitting
 * the level lets the server's `resolveMockTest` tie-break to TOPIK II
 * regardless of which row the user actually clicked. Omitted (never a bare
 * `sourceTest` with no level) unless the caller has a level to pin — the
 * "recommended exam" / resume paths, which only know a `sourceTest`, still
 * omit it and let the server resolve deterministically as before.
 *
 * Typed pass-through for the answer-stripped exam content (the server DTO
 * matches `MockTest` field-for-field), EXCEPT the F-119 audio fields, which
 * are normalized through `normalizeMockAudio` below: they steer a real
 * `<audio>` element and a seek/clamp loop, so a malformed value must degrade
 * to "no audio" (the transcript-only rendering) rather than reach the player.
 */
export async function fetchMockTest(
  section: MockSection,
  signal?: AbortSignal,
  sourceTest?: number,
  topikLevel?: TopikLevel,
): Promise<MockTest> {
  const body: { section: MockSection; sourceTest?: number; topikLevel?: TopikLevel } =
    { section };
  if (sourceTest !== undefined) body.sourceTest = sourceTest;
  if (topikLevel !== undefined) body.topikLevel = topikLevel;
  const res = await api.post<MockTest>(
    '/topik/mock',
    body,
    signal !== undefined ? { signal } : undefined,
  );
  return normalizeMockAudio(res);
}

/**
 * Validate one mock item's F-119 audio window against the SAME invariant the
 * DB enforces at rest (078's `ck_topik_items_audio_span`) and the server
 * re-asserts on emit: both bounds present, finite non-negative integers,
 * `end > start`. Anything else — a half window (only one bound), a
 * non-number, a negative/fractional value, an inverted or empty range —
 * yields `null` (no span): the item keeps its transcript-only fallback
 * instead of seeding `<audio>.currentTime` / the pause clamp with garbage
 * (an off-window seek would leak a DIFFERENT question's audio mid-exam).
 */
function readAudioSpan(
  // Structural pick, not `TopikMockItem`: the F-206 study items (`TopikItem`)
  // carry the same optional span fields and share this exact validation.
  item: { audioStartMs?: number; audioEndMs?: number },
): { audioStartMs: number; audioEndMs: number } | null {
  // The wire type SAYS number, but these came off the network — re-check at
  // runtime like the rest of the file's defensive parses.
  const start: unknown = item.audioStartMs;
  const end: unknown = item.audioEndMs;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;
  return { audioStartMs: start, audioEndMs: end };
}

/**
 * Normalize the F-119 audio fields on a `POST /topik/mock` envelope:
 * `audioUrl` must be a string or null (any other shape → null; the strict
 * route-shape allow-list check lives in `buildAudioSrc`, which the player
 * calls on this value), each item's span must satisfy `readAudioSpan`
 * (both-or-neither — a half/invalid window is dropped entirely), and the
 * decision-#2 `promptIsTranscript` flag must be a REAL boolean or absent
 * (fix-pass S-1) — any other wire shape is stripped to `undefined`, which
 * the runner treats as "not a transcript" (the prompt stays visible; hiding
 * is the dangerous direction, so junk must never truthy its way into a
 * hide). Everything else — notably the answer-strip contract — passes
 * through untouched.
 */
function normalizeMockAudio(test: MockTest): MockTest {
  const rawUrl: unknown = test.audioUrl;
  const audioUrl = typeof rawUrl === 'string' ? rawUrl : null;
  const items = test.items.map((item): TopikMockItem => {
    const next = { ...item };
    const span = readAudioSpan(item);
    if (span !== null) {
      // Re-assign the validated pair so a valid span survives verbatim.
      next.audioStartMs = span.audioStartMs;
      next.audioEndMs = span.audioEndMs;
    } else {
      // Invalid/half window → strip BOTH bounds (no-span, per the doc above).
      delete next.audioStartMs;
      delete next.audioEndMs;
    }
    // The wire type SAYS boolean-or-absent, but this came off the network —
    // re-check at runtime like the span above.
    if (typeof next.promptIsTranscript !== 'boolean') {
      delete next.promptIsTranscript;
    }
    // F-120: the exam-figure URL survives the answer strip (question content,
    // like hasImage/imageText) — normalize it here exactly like the study
    // items: non-string shapes are stripped; the strict route-shape
    // allow-list check lives in `buildTopikImageSrc` at render time.
    if (typeof next.imageUrl !== 'string') {
      delete next.imageUrl;
    }
    return next;
  });
  return { ...test, audioUrl, items };
}

/** A persisted in-progress mock attempt (F-007), as GET /topik/attempt returns it. */
export interface AttemptState {
  section: MockSection;
  sourceTest: number;
  /**
   * Best-effort re-derivation (F-173) — same posture as
   * `TopikAttemptHistoryEntry.topikLevel`: null on the rare case the backing
   * corpus paper is gone (see the route's `resolveServedTotal` doc). Optional
   * on the client type (not just the wire) so pre-F-173 fixtures/mocks that
   * predate this field keep typechecking — the real server always sends it.
   */
  topikLevel?: TopikLevel | null;
  currentIdx: number;
  /** { "<itemId>": choiceId } — the picks so far. */
  picks: Record<string, ChoiceId>;
  remainingMs: number;
  /** How many items are answered (server-computed, for the resume banner). */
  answered: number;
  /**
   * The exam's served item count (F-173), capped at the official mock size.
   * Falls back to `answered` when the backing paper can't be re-resolved —
   * a real lower bound, never a fabricated guess above what's known. Optional
   * on the client type for the same pre-F-173-fixture reason as `topikLevel`.
   */
  totalItems?: number;
  updatedAt: string;
}

/** The fields the client PUTs to save an attempt (server stamps user + timestamps). */
export interface AttemptSaveBody {
  section: MockSection;
  sourceTest: number;
  /**
   * OPTIONAL exam-paper discriminator (F-122 / migration 066) — a level the
   * SERVER already resolved and returned (e.g. `MockTest.topikLevel` from
   * `POST /topik/mock`), never a client-invented value. Omit only for a
   * caller with no resolved test in hand; the server then persists no level
   * for this save (falling back to its pre-066 best-effort re-derivation on
   * read).
   */
  topikLevel?: TopikLevel;
  currentIdx: number;
  picks: Record<string, ChoiceId>;
  remainingMs: number;
}

/** GET /topik/attempt — the caller's single in-progress mock attempt, or null. */
export async function fetchAttempt(
  signal?: AbortSignal,
): Promise<AttemptState | null> {
  const res = await api.get<{ attempt: AttemptState | null }>(
    '/topik/attempt',
    signal !== undefined ? { signal } : undefined,
  );
  return res.attempt;
}

/** PUT /topik/attempt — save (upsert) the in-progress attempt. */
export async function saveAttempt(
  body: AttemptSaveBody,
  signal?: AbortSignal,
): Promise<void> {
  await api.put<void>(
    '/topik/attempt',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/** DELETE /topik/attempt — discard the in-progress attempt (abandon / start fresh). */
export async function clearAttempt(signal?: AbortSignal): Promise<void> {
  await api.delete<void>(
    '/topik/attempt',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /topik/mock/submit — submit a finished Mock-Test for server grading.
 *
 * The server re-loads the section's items for `sourceTest`, grades each
 * `picked` against the DB answer (items not in `answers` count as skipped /
 * incorrect), appends one `topik_responses` row per answer scoped to the
 * session user, and returns the score (`percentage` + `band`), the
 * correct/total tallies, and a per-item `MockReveal[]` with explanations now
 * revealed. The client never had the key, so it cannot self-grade.
 */
export async function submitMockTest(
  body: MockSubmitBody,
  signal?: AbortSignal,
): Promise<MockResult> {
  return api.post<MockResult>(
    '/topik/mock/submit',
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

// ─────────────────────────────────────────────────────────────
// F-220 P3 — the generated-bank MOCK-EXAM surface (default-off
// TOPIK_MOCK_USE_GENERATED_BANK server flag). When the flag is off, every
// route below 404s — `fetchGeneratedMock` surfaces that as a normal
// `ApiError` the caller can degrade on (e.g. hide the "generated mock"
// entry point), exactly like any other disabled/absent surface. This is a
// SEPARATE, PARALLEL flow from the real mock's above (`fetchMockTest`/
// `submitMockTest`/`saveAttempt`) — see the `GeneratedMock*` types' doc in
// types/domain.ts for why the two are kept structurally distinct rather than
// widened unions on the real mock's shapes.
// ─────────────────────────────────────────────────────────────

/**
 * POST /topik/mock/generated — assemble a generated mock section, or RESUME
 * the caller's already-in-progress one for the SAME `(tier, section)`
 * (folds resume into the same call — there is no separate GET on this
 * surface, unlike the real mock's F-007 `/topik/attempt`).
 *
 * `attemptId: null` + `items: []` is a valid response (a thin bank had
 * nothing to assemble for this slot yet) — not thrown as an error.
 */
export async function fetchGeneratedMock(
  tier: GeneratedMockTier,
  section: MockSection,
  signal?: AbortSignal,
): Promise<GeneratedMockAssembleResponse> {
  return api.post<GeneratedMockAssembleResponse>(
    '/topik/mock/generated',
    { tier, section },
    signal !== undefined ? { signal } : undefined,
  );
}

/** PUT /topik/mock/generated/:id — save progress on the caller's own attempt. */
export async function saveGeneratedMockProgress(
  attemptId: string,
  body: GeneratedMockProgressBody,
  signal?: AbortSignal,
): Promise<void> {
  await api.put<void>(
    `/topik/mock/generated/${encodeURIComponent(attemptId)}`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /topik/mock/generated/:id/submit — submit a generated mock for
 * server-side grading. `picks` is OPTIONAL: omit it to grade from whatever
 * progress was last saved via `saveGeneratedMockProgress`, or send the
 * final picks map in one shot. The server never trusts a client-asserted
 * correctness — grading reads the attempt's own stored answer key.
 */
export async function submitGeneratedMock(
  attemptId: string,
  body: GeneratedMockSubmitBody,
  signal?: AbortSignal,
): Promise<GeneratedMockSubmitResult> {
  return api.post<GeneratedMockSubmitResult>(
    `/topik/mock/generated/${encodeURIComponent(attemptId)}/submit`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/** One incorrectly-answered TOPIK item, for the mistakes-review screen (F-021). */
export interface Mistake {
  responseId: string;
  /** The choice id the user picked (wrong). */
  picked: string;
  /** ISO timestamp of when it was answered. */
  answeredAt: string;
  mode: string;
  /**
   * The `topik_attempts` sitting this mistake was graded under (F-105), or
   * `null` — a study-mode miss belongs to no attempt (only mock mode stamps
   * `attempt_id`, at submit time), and a pre-046 response predates the
   * column. Lets a consumer link a mistake back to its exam attempt (F-104's
   * history) instead of the page's own (local-day, mode) grouping heuristic.
   */
  attemptId: string | null;
  /** The full item — carries the inline `correct` flag + `explanation` (review). */
  item: TopikItem;
}

interface MistakesEnvelope {
  mistakes: Mistake[];
}

/**
 * GET /topik/mistakes — the caller's recent WRONG answers for review (F-021).
 *
 * Returns TOPIK items the session user missed within the last `days` (server
 * default 30 — a rolling window), newest first, each with the FULL item (options
 * + inline `correct` flag + `explanation`) plus the user's wrong `picked` choice.
 * Because these are items the user already attempted, this surface intentionally
 * carries the answer key inline (as /items + /study also do for authenticated
 * reads — only the exam-taking /mock flow withholds it until submit).
 */
export async function fetchMistakes(
  opts: { days?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<Mistake[]> {
  const params: Record<string, number> = {};
  if (opts.days !== undefined) params.days = opts.days;
  if (opts.limit !== undefined) params.limit = opts.limit;
  const res = await api.get<MistakesEnvelope>('/topik/mistakes', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.mistakes;
}

// ── Attempt history (F-104 / A1) — GET /topik/attempts ────────────────────

/**
 * One completed mock-attempt history entry, as `GET /topik/attempts` serves
 * it. `topikLevel` is a best-effort server re-derivation (`topik_attempts`
 * doesn't store it — see the route's `resolveServedTotal` doc) and is `null`
 * on the rare case the backing corpus paper is gone; `totalItems` falls back
 * to the actual answered count in that same case (a real, non-fabricated
 * lower bound, never a guess).
 */
export interface TopikAttemptHistoryEntry {
  attemptId: string;
  /** Korean section label (`TopikItem['section']`'s enum) — matches the wire. */
  section: TopikItem['section'];
  sourceTest: number;
  topikLevel: TopikLevel | null;
  correct: number;
  totalItems: number;
  /** ISO timestamp of when the attempt was graded. */
  completedAt: string;
}

/** Envelope returned by `GET /topik/attempts`. */
export interface AttemptHistoryResult {
  attempts: TopikAttemptHistoryEntry[];
  /** Total completed attempts matching the (unfiltered) query — for paging. */
  total: number;
}

/**
 * GET /topik/attempts — the caller's completed mock-attempt history
 * (F-104 / A1). Newest-first; `status='active'`/`'abandoned'` attempts are
 * excluded — only graded sittings are history. Feeds F-078's daily total,
 * F-079's per-exam completion checkmarks + grade, and F-082's "Previous
 * attempts" review list.
 */
export async function fetchAttemptHistory(
  opts: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AttemptHistoryResult> {
  const params: Record<string, number> = {};
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<AttemptHistoryResult>('/topik/attempts', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
}

// ── Available-papers enumeration (F-118) — GET /topik/tests ───────────────

/** One TOPIK paper summary, as `GET /topik/tests` serves it. */
export interface TopikTestSummary {
  testNumber: number;
  topikLevel: TopikLevel;
  section: TopikItem['section'];
  /**
   * The paper's answerable item count for this section, capped at the
   * official mock size (50) — matches EXACTLY what `POST /topik/mock` would
   * serve for this paper, so a chooser built from this never advertises a
   * count the exam itself would not deliver.
   */
  itemCount: number;
}

/** Envelope returned by `GET /topik/tests`. */
export interface AvailableTestsResult {
  tests: TopikTestSummary[];
  /** Total matching papers (unfiltered by paging) — for paging. */
  total: number;
}

/**
 * GET /topik/tests — enumerate available TOPIK papers (F-118). Feeds the
 * F-079 Mock exam chooser's per-paper list. `section` narrows to one MCQ
 * section (the chooser is always entered already scoped to one); omit to
 * list every paper.
 */
export async function fetchAvailableTests(
  opts: { section?: MockSection; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AvailableTestsResult> {
  const params: Record<string, number | string> = {};
  if (opts.section !== undefined) params.section = opts.section;
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return api.get<AvailableTestsResult>('/topik/tests', {
    params,
    ...(signal !== undefined ? { signal } : {}),
  });
}
