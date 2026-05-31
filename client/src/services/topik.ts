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
  MockResult,
  MockSection,
  MockSubmitBody,
  MockTest,
  TopikAnswerResult,
  TopikItem,
} from '../types/domain';

/** Filter for `POST /topik/study`. All fields optional → whole-pool draw. */
export interface StudyDrawOptions {
  /** TOPIK section (Korean label). Omit to draw across all sections. */
  section?: TopikItem['section'];
  /** Proficiency band the server filters on (e.g. `'L3'`/`'L4'`/`'L5+'`). */
  level?: string;
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
 * pass-through; an empty filter draws from the whole pool.
 */
export async function fetchStudyDraw(
  opts: StudyDrawOptions,
  signal?: AbortSignal,
): Promise<TopikItem[]> {
  // Only forward fields the caller set so the server applies its own defaults
  // for the rest (e.g. limit) rather than receiving an explicit `undefined`.
  const body: StudyDrawOptions = {};
  if (opts.section !== undefined) body.section = opts.section;
  if (opts.level !== undefined) body.level = opts.level;
  if (opts.limit !== undefined) body.limit = opts.limit;

  const res = await api.post<StudyDrawEnvelope>(
    '/topik/study',
    body,
    signal !== undefined ? { signal } : undefined,
  );
  return res.items;
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
 * Typed pass-through: the server's answer-stripped DTO matches `MockTest`
 * field-for-field, so this returns the envelope as-is (no per-field mapping).
 */
export async function fetchMockTest(
  section: MockSection,
  signal?: AbortSignal,
): Promise<MockTest> {
  return api.post<MockTest>(
    '/topik/mock',
    { section },
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
