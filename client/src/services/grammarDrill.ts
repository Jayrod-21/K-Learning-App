/**
 * /grammar-drill — generate + submit grammar production drills.
 *
 * Two-step Claude flow (both legs are expensive-bucket on the server):
 *   - `POST /grammar-drill`            → `GeneratedDrill`. The server picks the
 *     `DrillType` by per-pattern history rotation, generates an item, persists
 *     the attempt (incl. the reference model), and returns the attempt id +
 *     the ANSWER-STRIPPED item (`DrillItemPublic`).
 *   - `POST /grammar-drill/:id/submit` → `DrillScore`. The server scores the
 *     learner's Korean production with Claude and reveals the reference model.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: both routes are POST (state-changing); defended by the session
 *     cookie's `SameSite=Strict` posture (see api.ts).
 *   - Answer leakage: the generate response carries NO `referenceModel*` — that
 *     is the model answer, stripped server-side and only revealed in the submit
 *     response. The client types (`DrillItemPublic`) enforce the same omission.
 *   - IDOR / replay: the submit route is user-scoped on the server (a wrong
 *     owner 404s) and single-shot (a re-submit of an already-scored attempt
 *     409s). This module surfaces both as `ApiError` for the screen to handle.
 *   - Timeout: both legs wrap Claude, so a cold start can exceed the 10s axios
 *     default that `api.ts` documents Claude routes MUST override (a 12s cold
 *     generate would otherwise reject as a misleading `code: 'timeout'`, drop
 *     the screen into a mock fallback, and — on submit — surface a phantom
 *     "scoring failed" whose Retry then 409s an already-scored attempt). Both
 *     calls therefore pass an explicit `DRILL_CLAUDE_TIMEOUT_MS` ceiling. A
 *     genuine timeout past that ceiling still surfaces as `ApiError(code:
 *     'timeout')` for the screen to offer a Retry.
 *   - Body size: the answer is soft-capped at the textarea (maxLength) and hard-
 *     capped by the server's Zod (1..600); the client trusts TS types here.
 */
import { api } from './api';
import type {
  DrillItemPublic,
  DrillScore,
  DrillType,
  DrillVerdict,
} from '../types/domain';

// Re-export the domain unions so callers can lean on the service module as the
// single import surface for the drill feature (mirrors how the screens already
// import service-adjacent types alongside the service functions).
export type { DrillType, DrillVerdict, DrillItemPublic, DrillScore };

/**
 * Per-call request ceiling for the two Claude-backed drill legs.
 *
 * `api.ts` sizes its default `timeout` (10s) for synchronous JSON endpoints and
 * is explicit that Claude-wrapping routes MUST pass their own override, else a
 * cold model start surfaces as a misleading `code: 'timeout'`. Generate and
 * score are both expensive-bucket Claude calls on the server, so they adopt the
 * 30s ceiling `enrich.ts` documents as the recommended Claude override — long
 * enough to absorb a cold start, short enough to bound a wedged request.
 */
const DRILL_CLAUDE_TIMEOUT_MS = 30_000;

/** Body for `POST /grammar-drill`. The server derives `drillType` from history. */
export interface GenerateDrillBody {
  patternKey: string;
  patternDisplay: string;
  /** EN meaning / title of the pattern — seeds Claude's generation. */
  meaning?: string;
  exampleKr?: string;
  exampleEn?: string;
}

/** Envelope from `POST /grammar-drill` — the attempt id + answer-stripped item. */
export interface GeneratedDrill {
  attemptId: number;
  item: DrillItemPublic;
}

/**
 * POST /grammar-drill → generate a drill for the given pattern.
 *
 * Resolves with the attempt id (needed to submit) and the public item. Rejects
 * with `ApiError` on a Claude/upstream failure (the server returns 502 and
 * writes no attempt row, so a Retry re-generates cleanly).
 */
export async function generateDrill(
  body: GenerateDrillBody,
  signal?: AbortSignal,
): Promise<GeneratedDrill> {
  return api.post<GeneratedDrill>('/grammar-drill', body, {
    timeout: DRILL_CLAUDE_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * POST /grammar-drill/:attemptId/submit → score the learner's answer.
 *
 * Resolves with the Claude grade + the now-revealed reference model. Rejects
 * with `ApiError`:
 *   - 404 — attempt not found / not owned by the caller.
 *   - 409 — attempt already scored (single-shot); the reveal is already known.
 *   - 502 — Claude/upstream failure; the attempt stays unscored and is retryable.
 */
export async function submitDrill(
  attemptId: number,
  answer: string,
  signal?: AbortSignal,
): Promise<DrillScore> {
  return api.post<DrillScore>(
    `/grammar-drill/${String(attemptId)}/submit`,
    { answer },
    {
      timeout: DRILL_CLAUDE_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
}
