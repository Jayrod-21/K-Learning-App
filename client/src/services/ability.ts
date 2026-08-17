/**
 * /ability — the F-212 live ability estimate (anchored-IRT EAP θ per
 * dimension, computed server-side from the Phase-1 evidence stream).
 *
 *   GET /ability/estimate → { estimates: AbilityEstimate[] }
 *
 * This is the CONTINUOUS estimate surface — a rough always-on signal that
 * updates as the user practices. It deliberately coexists with (and never
 * replaces) the F-011 diagnostic snapshot, which stays the authoritative
 * placement. The Progress page renders the two as separate blocks.
 *
 * Threat model:
 *   - **Auth + tenant scoping.** The route is `requireAuth` server-side and
 *     binds the user id from the session — no client-supplied identifier
 *     exists on this call at all (no IDOR surface). The session cookie rides
 *     via `withCredentials` on the shared axios instance.
 *   - **CSRF.** Read-only GET (no state change); the `SameSite=Strict`
 *     session cookie covers it regardless.
 *   - **Rendered text is escaped.** `band`, `estimatorVersion`,
 *     `rubricVersion`, `lastEvidenceAt` are server strings rendered as React
 *     children downstream — a malicious payload becomes literal text.
 *   - **Numeric honesty.** `theta`/`se`/`score` are structured numbers; the
 *     render path clamps derived 0–100 values through `clampScore` so
 *     malformed server data cannot draw an off-scale bar.
 *
 * Signal note: the optional `signal` lets a direct caller (the Progress
 * page's abortable effect) cancel an in-flight request — same threading
 * pattern as the sibling services.
 */
import { api } from './api';
import { clampScore } from '../lib/skillBand';

/** Dimensions the estimator can report. Writing is held behind a server-side
 *  flag and is absent by default — consumers must not assume it appears. */
export type AbilityDimension =
  | 'reading'
  | 'listening'
  | 'vocab'
  | 'grammar'
  | 'writing';

/**
 * One dimension's live estimate — mirrors the server contract verbatim
 * (`server/src/services/ability/estimate.ts`, `estimatorVersion
 * 'eap-1pl-1.0'`). When `insufficient` is true (min-evidence gate: too few
 * recent placed items), `theta`/`se`/`band`/`score` are all null.
 */
export interface AbilityEstimate {
  dimension: AbilityDimension;
  /** EAP person estimate on the anchored 1–6 θ scale, or null. */
  theta: number | null;
  /** Posterior SD of θ (honest uncertainty), or null. */
  se: number | null;
  /** Server-mapped band label (same rubric as the diagnostic), or null. */
  band: string | null;
  /** Server-mapped 0–100 score (same anchor table as the diagnostic), or null. */
  score: number | null;
  /** All evidence rows seen for this dimension in the window. */
  n: number;
  /** Rows with a placed difficulty that entered the likelihood. */
  nUsed: number;
  /** Recency-weighted effective evidence count (Σ w_i over placed items). */
  effN: number;
  /** ISO timestamp of the newest contributing evidence, or null. */
  lastEvidenceAt: string | null;
  /** True when the min-evidence gate held the estimate back. */
  insufficient: boolean;
  estimatorVersion: string;
  rubricVersion: string;
}

/** Envelope returned by `GET /ability/estimate`. */
export interface AbilityEstimateResponse {
  estimates: AbilityEstimate[];
}

/**
 * Fetch the per-dimension live ability estimates. Unwraps the `{ estimates }`
 * envelope; rethrows `ApiError` from the shared api layer on failure.
 */
export async function fetchAbilityEstimate(
  signal?: AbortSignal,
): Promise<AbilityEstimate[]> {
  const res = await api.get<AbilityEstimateResponse>(
    '/ability/estimate',
    signal !== undefined ? { signal } : undefined,
  );
  return res.estimates;
}

/**
 * θ-scale floor/ceiling the estimator can actually measure — the server
 * clamps every estimate into [1, 6] (`clampEstimate` in scoring.ts /
 * `clampTheta` in diagnostic/cat.ts) before mapping to a score, and the
 * band edges here do the same so a θ+se tail can never render a ~100
 * ("Native") band-high the estimator cannot claim.
 */
const THETA_MIN = 1;
const THETA_MAX = 6;

/** Mirror of the server's `clampEstimate` (scoring.ts): θ confined to [1, 6]. */
function clampTheta(value: number): number {
  if (value < THETA_MIN) return THETA_MIN;
  if (value > THETA_MAX) return THETA_MAX;
  return value;
}

/** Mirror of the server's private `clampScore` (scoring.ts): clamp to 0–100
 *  AND round to an integer — server scores are integers on the wire, so the
 *  client-derived values must be too (θ=3.5 → 48 on both sides, not 47.5). */
function toServerScore(value: number): number {
  return Math.round(clampScore(value));
}

/**
 * θ → 0–100 INTEGER score, mirroring the server's `estimateToScore`
 * (`server/src/services/diagnostic/scoring.ts`): the same piecewise-linear
 * [θ, score] anchor table, first-segment extrapolation below θ=1, clamped to
 * 0–100 and rounded to an integer exactly as the server's `clampScore` does.
 * The server already returns `score` for the point estimate; this client
 * mirror exists ONLY to derive the confidence-band edges from θ±se (the wire
 * contract carries `se` on the θ scale, not score-scale edges), so the
 * rendered band honestly reflects the posterior SD. If the server table or
 * rounding ever changes, this mirror must change with it — the service test
 * pins the anchor values so a drift fails loudly.
 */
export function thetaToScore(theta: number): number {
  // Anchor table: [θ, score], ascending by θ. θ=3 → 40 (TOPIK 3 threshold),
  // θ=4 → 55, θ=5 → 70, θ=6 → 85 — the same band values SkillsCompare's
  // reference lines use.
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [1, 10],
    [2, 25],
    [3, 40],
    [4, 55],
    [5, 70],
    [6, 85],
    [7, 100],
  ];

  const first = anchors[0];
  const second = anchors[1];
  if (first === undefined || second === undefined) return 0; // unreachable
  const [e0, s0] = first;
  const [e1, s1] = second;
  // Below the first anchor: extrapolate on the first segment's slope.
  if (theta <= e0) {
    const slope = (s1 - s0) / (e1 - e0);
    return toServerScore(s0 + slope * (theta - e0));
  }
  // Within the table: interpolate on the bracketing segment.
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const lo = anchors[i];
    const hi = anchors[i + 1];
    if (lo === undefined || hi === undefined) break; // unreachable
    if (theta <= hi[0]) {
      const slope = (hi[1] - lo[1]) / (hi[0] - lo[0]);
      return toServerScore(lo[1] + slope * (theta - lo[0]));
    }
  }
  // Above the last anchor.
  return toServerScore(100);
}

/**
 * Confidence-band edges (0–100 integers) for an estimate: θ−se / θ+se are
 * first clamped into [1, 6] (parity with the server diagnostic's
 * `clampEstimate` — the estimator cannot measure outside that range, so a
 * θ+se tail must not paint a ~100 "Native" band-high), then pushed through
 * the same monotone anchor map as the score itself, so the band brackets the
 * bar it decorates. Returns null when either input is null (insufficient
 * estimate — no bar, no band).
 */
export function estimateBandEdges(
  theta: number | null,
  se: number | null,
): { scoreLow: number; scoreHigh: number } | null {
  if (theta === null || se === null) return null;
  return {
    scoreLow: thetaToScore(clampTheta(theta - se)),
    scoreHigh: thetaToScore(clampTheta(theta + se)),
  };
}
