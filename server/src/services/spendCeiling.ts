/**
 * Global daily spend ceiling (Phase 2.6) — a circuit breaker over COMBINED,
 * ALL-USERS spend across the three metered external APIs (Claude, ElevenLabs
 * TTS, OpenAI images) for the current UTC day. This is orthogonal to — layered
 * ON TOP OF, never instead of — the existing PER-USER daily caps
 * (STORY_TTS_DAILY_CAP, STORY_IMAGE_DAILY_CAP, IMAGE_OCR_DAILY_CAP, …): those
 * bound one account's request volume; this bounds the WHOLE deployment's
 * dollar spend, which per-user caps cannot see (many users each safely under
 * their own cap can still sum to a runaway bill). Protects a multi-user
 * launch from cost runaway (D3/F-220's public-eventually gate).
 *
 * SOURCES (four tables, summed for the current UTC day):
 *   - claude_usage.cost_estimate_usd (004) — one row per completed Claude
 *     call; cache hits are already written at $0 by the writer
 *     (services/claude/usage.ts), so they contribute nothing extra here.
 *   - story_audio_jobs.cost_estimate_usd (096) — populated ONLY at
 *     status = 'done' (096's design note: a pending/running/failed row's
 *     spend is either not-yet-incurred or not cleanly attributable to a
 *     single call count, so it is NULL and excluded by the WHERE clause).
 *   - story_image_jobs.cost_estimate_usd (096) — identical settle-only
 *     contract.
 *   - generated_items.audio_cost_estimate_usd (103, F-220 slice 3) —
 *     populated ONLY once `audio_synthesized_at` is set (the SAME settle-only
 *     contract as the two story job tables above): the offline, operator-run
 *     `scripts/synthesize-listening-audio.ts` CLI writes both columns in ONE
 *     UPDATE per item, so this WHERE clause (`audio_synthesized_at >= since`)
 *     never sums a not-yet-synthesized item's NULL cost.
 *
 * ENFORCEMENT (4 chokepoints, all calling `assertUnderSpendCeiling`):
 *   - services/claude/index.ts `runJsonRoute` + `generateConversation` — the
 *     SYNC path; a thrown SpendCeilingExceededError propagates to the route's
 *     error handler as a typed 503.
 *   - services/storyAudio.ts `runStoryAudioTick` — BACKGROUND; a claimed job
 *     that hits the ceiling settles 'failed' with a distinguishable reason
 *     (never spending past the ceiling), freeing its story's one-live-job
 *     slot so the user can retry once the day's total drops or an operator
 *     raises the ceiling.
 *   - services/storyImage.ts `runStoryImageTick` — BACKGROUND; same.
 *   - scripts/synthesize-listening-audio.ts — OFFLINE/OPERATOR-RUN, per item
 *     inside `--synth`; a ceiling hit stops that run before the item's
 *     ElevenLabs call (never spending past the ceiling) rather than settling
 *     any job state (this CLI has no job table — see its own module doc).
 *
 * DO NOT import the claude module from here (services/claude/**) — this file
 * is imported BY services/claude/index.ts, and a reverse import would form a
 * cycle. Every query here is raw parameterized SQL against `db/pool.ts`.
 *
 * ---------------------------------------------------------------------------
 * FAIL-SAFE POSTURE (a transient error computing the total must neither
 * silently allow unlimited spend NOR take the whole app down):
 *
 * `assertUnderSpendCeiling` FAILS OPEN on a sum-query error — it logs at
 * ERROR and returns normally (the call proceeds) rather than throwing.
 *
 * Reasoning: SPEND_CEILING_DAILY_USD is an OPT-IN cost backstop (default 0 =
 * disabled) layered on top of every OTHER guard that already exists (per-user
 * daily caps, per-route Claude rate limits, keyless-provider 503s). A
 * Postgres blip on THIS one auxiliary query must not turn into a hard outage
 * for every paid feature in the app (enrich, grade-writing, diagnostic,
 * writing-gen, conversation, OCR, story TTS, story images) simultaneously —
 * that would be a strictly WORSE outage than the runaway-cost scenario this
 * breaker defends against. It is also not much of a security tradeoff: every
 * other step in the same request path (the Claude cache lookup, the
 * per-route rate limiter's own state, the actual feature work) already
 * depends on the same Postgres connection — if Postgres is genuinely down,
 * the call was going to fail on its own merits a few lines later regardless
 * of what this gate decides.
 *
 * This single policy satisfies BOTH call-site shapes without a branch: the
 * SYNC Claude path simply proceeds (no 503 minted over an infra hiccup), and
 * the BACKGROUND job runners never see an error at all from this function on
 * a sum-query failure — `assertUnderSpendCeiling` only ever throws a REAL,
 * over-the-limit `SpendCeilingExceededError` or returns cleanly — so
 * runStoryAudioTick/runStoryImageTick's catch-and-settle-'failed' blocks are
 * never reached over a transient DB error; the job proceeds to spend exactly
 * as if the ceiling were disabled for that one check. If the blip is actually
 * a real outage, the job's own metered call fails on its own and the
 * existing stale-'running' reaper (STORY_TTS_STALE_RUN_MINUTES /
 * STORY_IMAGE_STALE_RUN_MINUTES) un-bricks it — this function does not need
 * to duplicate that protection.
 * ---------------------------------------------------------------------------
 */
import { query, type Querier } from '../db/pool.js';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { SpendCeilingExceededError } from '../middleware/errors.js';

export interface SpendBreakdown {
  readonly total: number;
  readonly claude: number;
  readonly tts: number;
  readonly images: number;
  /** F-220 slice 3 — ElevenLabs spend on generated LISTENING item audio
   *  (generated_items.audio_cost_estimate_usd, settled by the offline
   *  synthesize-listening-audio CLI). Distinct from `tts` (story audio,
   *  story_audio_jobs) — a different table/pipeline, summed separately so
   *  the admin readout can attribute spend to its actual source. */
  readonly listeningAudio: number;
}

export interface SpendCeilingStatus {
  readonly enabled: boolean;
  readonly ceiling_usd: number;
  readonly window: 'utc_day';
  readonly spent_usd: SpendBreakdown;
  readonly remaining_usd: number;
}

const CLAUDE_SUM_SQL = `
  SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM claude_usage
   WHERE occurred_at >= $1
`;

// Only 'done' rows carry a cost — 096's design (pending/running/failed leave
// the column NULL; NULL is never SUMmed, so this WHERE is technically
// redundant with that fact, but it is kept explicit so the query's intent
// ("settled spend only") reads correctly on its own and stays correct even
// if a future migration ever backfills a non-NULL value on another status).
const TTS_SUM_SQL = `
  SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM story_audio_jobs
   WHERE finished_at >= $1 AND status = 'done'
`;

const IMAGE_SUM_SQL = `
  SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM story_image_jobs
   WHERE finished_at >= $1 AND status = 'done'
`;

// F-220 slice 3 — settle-only contract (103's design note): a draft/
// not-yet-synthesized listening item has audio_cost_estimate_usd/
// audio_synthesized_at both NULL, so the WHERE clause naturally excludes it
// (mirrors TTS_SUM_SQL/IMAGE_SUM_SQL's status='done' guard, keyed on the
// settle timestamp instead of a status column since generated_items has no
// per-audio lifecycle status of its own).
const LISTENING_AUDIO_SUM_SQL = `
  SELECT COALESCE(SUM(audio_cost_estimate_usd), 0) AS total
    FROM generated_items
   WHERE audio_synthesized_at >= $1
`;

/** NUMERIC comes back from pg as a string (precision safety — the same
 *  reason claude_usage.ts's own sumCostSince coerces). Guard NaN (an
 *  unexpected null/shape) to 0 rather than letting it poison the ceiling
 *  comparison (NaN >= anything is false, which would silently disable
 *  enforcement). */
function toUsd(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 00:00:00.000 UTC of the calendar day `now` falls on. Pure — exported for
 * unit tests. Deliberately uses the UTC getters/`Date.UTC` (not local-time
 * ones): the ceiling window is defined as "the current UTC day" regardless
 * of the server host's local timezone.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Sum spend across all three metered sources since `since` (inclusive).
 * Exact/uncached — callers that want the memoized fast path use
 * `assertUnderSpendCeiling`; this is for the admin readout and the cache-miss
 * path. Runs the three SUMs concurrently (independent read-only queries, no
 * shared transaction needed — a `Querier` is passed so a test can inject a
 * transaction-bound querier or a stub, mirroring `consumeChallenge`'s
 * `exec: Querier = query` pattern).
 */
export async function getGlobalSpendUsdSince(
  since: Date,
  exec: Querier = query,
): Promise<SpendBreakdown> {
  const [claudeRes, ttsRes, imagesRes, listeningAudioRes] = await Promise.all([
    exec<{ total: unknown }>(CLAUDE_SUM_SQL, [since]),
    exec<{ total: unknown }>(TTS_SUM_SQL, [since]),
    exec<{ total: unknown }>(IMAGE_SUM_SQL, [since]),
    exec<{ total: unknown }>(LISTENING_AUDIO_SUM_SQL, [since]),
  ]);
  const claude = toUsd(claudeRes.rows[0]?.total);
  const tts = toUsd(ttsRes.rows[0]?.total);
  const images = toUsd(imagesRes.rows[0]?.total);
  const listeningAudio = toUsd(listeningAudioRes.rows[0]?.total);
  return {
    total: claude + tts + images + listeningAudio,
    claude,
    tts,
    images,
    listeningAudio,
  };
}

/**
 * Exact, uncached spend-ceiling snapshot for the admin readout
 * (GET /admin/spend). Never memoized — an operator checking this after
 * raising the ceiling (or investigating a live incident) must see the real
 * number, not a stale cached one.
 */
export async function getSpendCeilingStatus(): Promise<SpendCeilingStatus> {
  const cfg = loadConfig();
  const enabled = cfg.SPEND_CEILING_DAILY_USD > 0;
  const spent = await getGlobalSpendUsdSince(startOfUtcDay(new Date()));
  // Only meaningful when enabled — with the ceiling off (0), there is no cap
  // to have "remaining" room under, so this floors at 0 rather than reporting
  // a large negative number. Callers must check `enabled` first; this field
  // is informational, not authoritative.
  const remaining = enabled ? Math.max(0, cfg.SPEND_CEILING_DAILY_USD - spent.total) : 0;
  return {
    enabled,
    ceiling_usd: cfg.SPEND_CEILING_DAILY_USD,
    window: 'utc_day',
    spent_usd: spent,
    remaining_usd: remaining,
  };
}

// ---------------------------------------------------------------------------
// The enforcement gate — memoized total, see the module doc for fail-open.
// ---------------------------------------------------------------------------

interface SpendCacheEntry {
  readonly value: number;
  readonly computedAt: number;
}

let _cache: SpendCacheEntry | null = null;

/** Test-only: drop the memoized total so the next check recomputes. */
export function _resetSpendCeilingCacheForTesting(): void {
  _cache = null;
}

/**
 * Throws `SpendCeilingExceededError` when today's (UTC) combined spend has
 * reached SPEND_CEILING_DAILY_USD; otherwise returns. A no-op (zero overhead,
 * no query) when the ceiling is disabled (SPEND_CEILING_DAILY_USD <= 0 — the
 * default). See the module doc for the memoization TTL and the fail-open
 * posture on a sum-query error.
 */
export async function assertUnderSpendCeiling(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.SPEND_CEILING_DAILY_USD <= 0) return;

  const now = Date.now();
  const ttl = cfg.SPEND_CEILING_CACHE_TTL_MS;
  let total: number;

  if (_cache && ttl > 0 && now - _cache.computedAt < ttl) {
    total = _cache.value;
  } else {
    try {
      const spent = await getGlobalSpendUsdSince(startOfUtcDay(new Date(now)));
      total = spent.total;
      _cache = { value: total, computedAt: now };
    } catch (e) {
      // FAIL-OPEN — see the module doc's "FAIL-SAFE POSTURE" section. Never
      // let an infra blip on this auxiliary query take down every metered
      // route in the app.
      getLogger().error(
        { errMsg: e instanceof Error ? e.message : String(e) },
        'spendCeiling: sum query failed — failing open (call proceeds, ceiling not enforced this check)',
      );
      return;
    }
  }

  if (total >= cfg.SPEND_CEILING_DAILY_USD) {
    throw new SpendCeilingExceededError();
  }
}
