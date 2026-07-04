/**
 * /grade-writing — TOPIK-rubric writing grader (single Claude leg).
 *
 * `POST /grade-writing` sends the learner's Korean sample plus the task prompt
 * and returns the proxy envelope `{ result, metadata }` where `result` carries
 * the three official rubric dimensions (내용 및 과제수행 / 전개구조 / 언어사용),
 * the total, an estimated TOPIK II level, and an overall comment. The route is
 * authenticated + expensive-bucket rate-limited server-side.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: the route is a state-costing POST (it spends Claude budget);
 *     defended by the session cookie's `SameSite=Strict` posture (see api.ts).
 *   - Contract drift: the server's `GradeSchema` is `.strict()` — an extra
 *     body field is a hard 400, not an ignore. `GradeWritingBody` is therefore
 *     the ONLY shape this module sends; callers cannot smuggle fields through.
 *   - Rate limiting: the endpoint sits in the expensive bucket, so a burst of
 *     submits 429s. That surfaces as `ApiError(status: 429)` (with a structured
 *     `retryAfter` when the server provides one) for the screen to render a
 *     fixed wait message — never echoed server prose.
 *   - Timeout: the route wraps Claude, so it MUST override the 10s axios
 *     default that `api.ts` documents (see WRITING_CLAUDE_TIMEOUT_MS below).
 *   - Body size: the sample is soft-capped at the textarea (maxLength 5000)
 *     and hard-capped by the server's Zod (1..5000); prompt 1..2000.
 */
import { api } from './api';
import type {
  GradeWritingBody,
  GradeWritingResponse,
  TopikWritingRubric,
  WritingDimensionScore,
  WritingEstimatedLevel,
  WritingGradeResult,
} from '../types/domain';

// Re-export the domain types so screens can lean on the service module as the
// single import surface for the writing feature (mirrors grammarDrill.ts).
export type {
  GradeWritingBody,
  GradeWritingResponse,
  TopikWritingRubric,
  WritingDimensionScore,
  WritingEstimatedLevel,
  WritingGradeResult,
};

/**
 * Per-call request ceiling for the grade leg.
 *
 * `api.ts` sizes its default `timeout` (10s) for synchronous JSON endpoints
 * and is explicit that Claude-wrapping routes MUST pass their own override.
 * Grading a full Q54 essay (up to 5,000 chars in, three evidence-cited rubric
 * dimensions out) is the heaviest single Claude call the client makes — well
 * past the 30s ceiling the drill legs use. The server's own upstream ceiling
 * is `CLAUDE_TIMEOUT_MS` (default 60s; claude/config.ts), so the client waits
 * marginally PAST it (65s): a genuinely slow grade then surfaces as the
 * server's own 504/502 (`upstream_error`, retryable with context) instead of
 * a client-side `ECONNABORTED` that masks whether the server ever answered.
 */
const WRITING_CLAUDE_TIMEOUT_MS = 65_000;

/**
 * POST /grade-writing → grade a Korean writing sample against a TOPIK rubric.
 *
 * Resolves with the proxy envelope (`.result` is the grade). Rejects with
 * `ApiError`:
 *   - 400 — body outside the schema bounds (empty sample, oversize, bad rubric).
 *   - 401 — session expired (RequireAuth normally prevents reaching this).
 *   - 429 — expensive-bucket rate limit; `retryAfter` may carry seconds.
 *   - 502/504 — Claude/upstream failure or timeout; nothing was persisted, so
 *     a retry re-grades cleanly.
 */
export async function gradeWriting(
  body: GradeWritingBody,
  signal?: AbortSignal,
): Promise<GradeWritingResponse> {
  return api.post<GradeWritingResponse>('/grade-writing', body, {
    timeout: WRITING_CLAUDE_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
}
