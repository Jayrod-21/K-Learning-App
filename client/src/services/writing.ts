/**
 * /writing + /grade-writing — TOPIK writing prompts and the rubric grader.
 *
 * `GET /writing/prompts?rubric=…` (F-014) serves the curated task prompts for
 * one rubric from the DB (the screen's former hardcoded `WRITING_TASKS` list,
 * now server-owned so the Today tile and the screen can never diverge).
 *
 * `POST /grade-writing` sends the learner's Korean sample plus the task prompt
 * and returns the proxy envelope `{ result, metadata }` where `result` carries
 * the three official rubric dimensions (내용 및 과제수행 / 전개구조 / 언어사용),
 * the total, an estimated TOPIK II level, and an overall comment. The route is
 * authenticated + expensive-bucket rate-limited server-side. As of F-014 the
 * body may carry the graded prompt's `promptId` so the server can link the
 * persisted `writing_attempts` row back to its `writing_prompts` source.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: the grade route is a state-costing POST (it spends Claude budget);
 *     defended by the session cookie's `SameSite=Strict` posture (see api.ts).
 *     The prompts route is an auth'd GET (no state change).
 *   - Contract drift: the server's `GradeSchema` is `.strict()` — an extra
 *     body field is a hard 400, not an ignore. `GradeWritingBody` is therefore
 *     the ONLY shape this module sends; callers cannot smuggle fields through.
 *   - Rate limiting: the grade endpoint sits in the expensive bucket, so a
 *     burst of submits 429s. That surfaces as `ApiError(status: 429)` (with a
 *     structured `retryAfter` when the server provides one — live as of B-016)
 *     for the screen to render a fixed wait message — never echoed server
 *     prose. The prompts route rides the cheap bucket.
 *   - Injection: `rubric` is a closed client-side union serialized by axios
 *     into the query string — never interpolated into the path — and the
 *     server re-validates it against its own enum.
 *   - Timeout: the grade route wraps Claude, so it MUST override the 10s axios
 *     default that `api.ts` documents (see WRITING_CLAUDE_TIMEOUT_MS below).
 *     The prompts route is a synchronous DB read — the default applies.
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
 * One curated writing task, as `GET /writing/prompts` returns it (F-014).
 * Mirrors the server DTO field-for-field — `promptKr` is what the screen
 * shows AND what `gradeWriting` sends as `prompt`; `id` rides along as
 * `promptId` so the persisted attempt links back to its source row.
 */
export interface WritingPromptDTO {
  id: number;
  /** The Korean task text (1..2000 — the grade route's `prompt` bound). */
  promptKr: string;
  /** Optional English gloss of the task; `null` when none is authored. */
  promptEn: string | null;
  /** Proficiency band label (e.g. `'L4'`). */
  level: string;
  rubric: TopikWritingRubric;
  /** Suggested minutes for the task; `null` when unestimated. */
  estMinutes: number | null;
}

/** Envelope returned by `GET /writing/prompts`. */
interface WritingPromptsEnvelope {
  prompts: WritingPromptDTO[];
}

/**
 * GET /writing/prompts?rubric=… — the active curated prompts for one rubric.
 *
 * Returns the array unwrapped from the `{ prompts }` envelope, in the
 * server's stable (id-ascending) order. Rejects with `ApiError` (401 session
 * expired, 429 cheap-bucket limit, 5xx) for the screen's fixed-copy error
 * state — an empty rubric pool resolves as `[]`, not an error.
 */
export async function fetchWritingPrompts(
  rubric: TopikWritingRubric,
  signal?: AbortSignal,
): Promise<WritingPromptDTO[]> {
  const res = await api.get<WritingPromptsEnvelope>('/writing/prompts', {
    params: { rubric },
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.prompts;
}

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

// ─────────────────────────────────────────────────────────────
// POST /writing/generate — Claude-authored topic (F-027 / F-073)
// ─────────────────────────────────────────────────────────────

/** The two generation modes `POST /writing/generate` accepts. */
export type WritingGenerateMode = 'topik' | 'general';

/**
 * Body for `POST /writing/generate`. The server schema is `.strict()` with a
 * refine that rejects `rubric` unless `mode === 'topik'` — this type mirrors
 * that closed contract (both fields are closed enums; no free text rides
 * this route). Omitting `rubric` in topik mode defaults to Q54 server-side,
 * the same default `/grade-writing` uses.
 */
export interface GenerateWritingPromptBody {
  mode: WritingGenerateMode;
  rubric?: TopikWritingRubric;
}

/**
 * One Claude-authored writing topic, as `POST /writing/generate` returns it
 * (`{ prompt: … }` envelope, unwrapped by `generateWritingPrompt`). The
 * server persists NOTHING for this call — a generated topic is ephemeral
 * until the learner's graded attempt lands via `/grade-writing`.
 */
export interface GeneratedWritingPrompt {
  /** The Korean task text the learner writes toward. */
  promptKr: string;
  /** English gloss so the learner can confirm they understood the task. */
  promptEn: string;
  /** Target-length hint (e.g. `'600-700자'`); `null` when Claude gave none. */
  lengthHint: string | null;
  /** Echo of the mode that was generated. */
  mode: WritingGenerateMode;
  /** The rubric actually used (topik mode; server-defaulted), else `null`. */
  rubric: TopikWritingRubric | null;
}

/** Envelope returned by `POST /writing/generate`. */
interface GenerateWritingPromptEnvelope {
  prompt: GeneratedWritingPrompt;
}

/**
 * Per-call ceiling for the generate leg. Authoring ONE short prompt is the
 * lightest Claude call in the writing feature — drill-leg sized (the 30s the
 * grammar-drill legs use) plus headroom, well under the grade leg's 65s.
 * Still a deliberate override of api.ts's 10s synchronous default, per its
 * "Claude-wrapping routes MUST pass their own timeout" contract.
 */
const WRITING_GENERATE_TIMEOUT_MS = 35_000;

/**
 * POST /writing/generate → one fresh Claude-authored writing topic
 * (F-027 Today tile / F-073 Writing screen — build once, surface twice).
 *
 * Resolves with the unwrapped prompt. Rejects with `ApiError`:
 *   - 400 — body outside the closed schema (client bug, e.g. rubric with
 *     mode='general'; the type above makes that unrepresentable in practice).
 *   - 401 — session expired.
 *   - 429 — expensive-bucket rate limit; `retryAfter` may carry seconds —
 *     callers surface it via `errorMessageFor`, never dead-end the button.
 *   - 502/504 — Claude/upstream failure or timeout; nothing was persisted,
 *     so a retry regenerates cleanly.
 */
export async function generateWritingPrompt(
  body: GenerateWritingPromptBody,
  signal?: AbortSignal,
): Promise<GeneratedWritingPrompt> {
  const res = await api.post<GenerateWritingPromptEnvelope>(
    '/writing/generate',
    body,
    {
      timeout: WRITING_GENERATE_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return res.prompt;
}
