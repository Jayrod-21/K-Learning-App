/**
 * /diagnostic — the server-graded adaptive diagnostic (Pass 5).
 *
 * The diagnostic is a stateful, server-graded item-by-item flow:
 *   POST /diagnostic                  → start a run, serve item 1
 *   POST /diagnostic/:runId/answer    → grade the current item, serve the next
 *   POST /diagnostic/:runId/finish    → compute + persist the snapshot
 *   GET  /diagnostic/latest           → the user's most recent snapshot
 *   GET  /diagnostic/trajectory       → per-dimension score history
 *
 * Threat model:
 *   - **Answer-tampering / key leakage.** Grading is server-side. The live
 *     item (`DiagnosticLiveItem`) carries NO correct answer — the key lives in
 *     a column-private server field and only surfaces in the `/answer`
 *     response's `result` AFTER the user has answered. This service never
 *     receives or forwards a correct answer pre-reveal, so a tampered client
 *     cannot self-grade or read ahead.
 *   - **IDOR / run ownership.** `runId` is interpolated into the path but the
 *     server scopes every run to the session `user_id` and never trusts the
 *     id alone — a guessed `runId` belonging to another user 404s/403s. The
 *     client passes `runId` as a number (no string concatenation of free-form
 *     user input), so there is no path-traversal surface.
 *   - **CSRF.** State-changing routes are POST → CSRF surface, defended by the
 *     `SameSite=Strict` session cookie on the shared axios instance. If the
 *     cookie ever relaxes, a CSRF token must be added at the api layer.
 *   - **Replay / double-answer.** The server rejects an out-of-order or
 *     already-answered `responseId` with 409; the client surfaces that error
 *     rather than silently advancing.
 *   - **Claude cost.** Item generation runs server-side behind an expensive
 *     rate limiter; the client cannot trigger extra generations beyond the
 *     run's fixed item budget.
 *   - **Rendered text is escaped.** Every Korean string (prompt, passage,
 *     choices, explain, transcript) renders as React children, so a malicious
 *     server payload becomes literal text, not markup.
 *
 * Shape note: the server's SnapshotDTO maps 1:1 onto the client
 * `DiagnosticSnapshot` domain type (dimensions / references / defaultRef /
 * goals), so `finishDiagnostic` and `fetchLatestSnapshot` pass it through
 * unchanged. The live-item / answer / start envelopes also match their domain
 * types verbatim per the Pass 5 wire contract, so these helpers are typed
 * pass-throughs that exist to centralise the URL, the signal threading, and
 * the threat-model documentation in one place.
 *
 * Signal note: the optional `signal` lets a direct caller cancel an in-flight
 * request. `fetchLatestSnapshot` is also consumed through `useEndpointOrMock`,
 * whose `realFn` contract is no-arg and which owns cancellation itself; the
 * Diagnostic/Today screens therefore call it with no signal. The Taking flow
 * (start/answer/finish) is a local mutation flow that manages its own
 * `AbortController` and threads the signal through.
 */
import { api } from './api';
import type {
  DiagnosticAnswerResponse,
  DiagnosticSnapshot,
  DiagnosticStartResponse,
} from '../types/domain';

/** Body for `POST /diagnostic/:runId/answer`. `picked: null` = skip. */
export interface AnswerDiagnosticBody {
  responseId: number;
  picked: string | null;
  timeMs?: number;
}

/** Envelope returned by `POST /diagnostic/:runId/finish`. */
export interface FinishDiagnosticResponse {
  snapshot: DiagnosticSnapshot;
}

/** One point in the per-dimension trajectory, oldest→newest. */
export interface DiagnosticTrajectoryPoint {
  capturedAt: string;
  reading?: number;
  listening?: number;
  vocab?: number;
  grammar?: number;
}

/** Envelope returned by `GET /diagnostic/trajectory`. */
export interface DiagnosticTrajectoryResponse {
  points: DiagnosticTrajectoryPoint[];
}

/**
 * POST /diagnostic — start a run and serve the first item.
 *
 * May trigger Claude item generation server-side (behind the expensive rate
 * limiter), so the caller should expect this to be slower than a pure read.
 */
export async function startDiagnostic(
  signal?: AbortSignal,
): Promise<DiagnosticStartResponse> {
  return api.post<DiagnosticStartResponse>(
    '/diagnostic',
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /diagnostic/:runId/answer — grade the current item and serve the next.
 *
 * Returns the `result` reveal (correct + correctAnswer + explain), the `next`
 * live item (or `null` when the graded item was the last), and updated
 * progress. `picked: null` records a skip (graded as incorrect server-side).
 */
export async function answerDiagnostic(
  runId: number,
  body: AnswerDiagnosticBody,
  signal?: AbortSignal,
): Promise<DiagnosticAnswerResponse> {
  return api.post<DiagnosticAnswerResponse>(
    `/diagnostic/${String(runId)}/answer`,
    body,
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * POST /diagnostic/:runId/finish — compute + persist the snapshot.
 *
 * Idempotent server-side: finishing an already-finished run returns the
 * existing snapshot rather than re-scoring.
 */
export async function finishDiagnostic(
  runId: number,
  signal?: AbortSignal,
): Promise<FinishDiagnosticResponse> {
  return api.post<FinishDiagnosticResponse>(
    `/diagnostic/${String(runId)}/finish`,
    {},
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * GET /diagnostic/latest — the user's most recent diagnostic snapshot.
 *
 * The server returns a SnapshotDTO that maps 1:1 onto `DiagnosticSnapshot`.
 * When the user has never completed a run, the server returns a 200 with an
 * empty `dimensions` array (NOT a 404) — the screens treat empty dimensions as
 * "no prior run" and land on the Intro.
 */
export async function fetchLatestSnapshot(
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot> {
  return api.get<DiagnosticSnapshot>(
    '/diagnostic/latest',
    signal !== undefined ? { signal } : undefined,
  );
}

/**
 * GET /diagnostic/trajectory — per-dimension score history, oldest→newest.
 *
 * Typed for completeness; no screen renders it yet (Pass 5 ships the route +
 * service ahead of the UI that will chart it).
 */
export async function fetchTrajectory(
  signal?: AbortSignal,
): Promise<DiagnosticTrajectoryResponse> {
  return api.get<DiagnosticTrajectoryResponse>(
    '/diagnostic/trajectory',
    signal !== undefined ? { signal } : undefined,
  );
}
