/**
 * Cost-tracking writer for `claude_usage`.
 *
 * Every public-API call ends with a usage row write — cache hits too
 * (with was_cache_hit=true and all token/cost fields zero). The
 * dashboard query `SELECT SUM(cost_estimate_usd) FROM claude_usage
 * WHERE occurred_at::date = current_date` is the daily-spend answer.
 *
 * Rate card lives here. When Anthropic publishes a new price, only this
 * file changes. Historical rows are NOT retrofitted — the column is
 * `cost_estimate_usd` for a reason; the authoritative bill is
 * Anthropic's monthly invoice.
 *
 * Rates per 1M tokens. Verified against the public price list at the
 * date below; update CHANGELOG if you change these.
 *
 * Source: https://www.anthropic.com/pricing (verified 2026-05-28)
 */

import { type Pool, type PoolClient } from 'pg';
import type { Logger } from 'pino';

import type { ClaudeModelId, RouteName } from './config';
import { ClaudePersistenceError } from './errors';

export interface UsageRecord {
  readonly requestId: string;
  readonly userId: number | null;
  readonly route: RouteName;
  readonly model: ClaudeModelId;
  readonly wasCacheHit: boolean;
  /**
   * Non-cached input tokens as reported by Anthropic's `usage.input_tokens`.
   * Per the Messages API: `input_tokens` is already the count billed at the
   * full input rate; cached reads are NOT included in this number.
   */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tokens served from Anthropic's prompt cache
   * (`usage.cache_read_input_tokens`). Billed at the discounted cached rate.
   */
  readonly cachedInputTokens: number;
  /**
   * Tokens written into Anthropic's prompt cache
   * (`usage.cache_creation_input_tokens`). Billed at a premium over the
   * full input rate (commonly 1.25× for ephemeral cache).
   */
  readonly cacheCreationInputTokens: number;
  readonly latencyMs: number;
  /** If pre-computed (e.g., cache hit = 0); else computed here from rate card. */
  readonly costEstimateUsd?: number;
}

export interface UsageStore {
  record(rec: UsageRecord): Promise<void>;
  sumCostSince(since: Date): Promise<number>;
}

// ---- Rate card -------------------------------------------------------------

interface ModelRates {
  /** USD per 1M input tokens (full price). */
  readonly input: number;
  /** USD per 1M input tokens served from Anthropic's prompt cache (read). */
  readonly cachedInput: number;
  /**
   * USD per 1M input tokens WRITTEN to Anthropic's prompt cache (creation).
   * Anthropic bills cache writes at a premium over standard input — commonly
   * 1.25× for ephemeral 5-minute cache. Update if Anthropic changes pricing.
   */
  readonly cacheCreationInput: number;
  /** USD per 1M output tokens. */
  readonly output: number;
}

// Cache-creation multiplier vs. base input. Centralized so it's one knob
// when Anthropic publishes new pricing. 1.25× is the documented ephemeral
// rate as of 2026-05-28.
const CACHE_CREATION_MULTIPLIER = 1.25;

const RATE_CARD: Readonly<Record<ClaudeModelId, ModelRates>> = {
  // Haiku 4.5 — fastest / cheapest. Used for high-volume enrich.
  'claude-haiku-4-5': {
    input: 1.0,
    cachedInput: 0.1,
    cacheCreationInput: 1.0 * CACHE_CREATION_MULTIPLIER,
    output: 5.0,
  },
  // Sonnet 4.6 — default reasoning workhorse.
  'claude-sonnet-4-6': {
    input: 3.0,
    cachedInput: 0.3,
    cacheCreationInput: 3.0 * CACHE_CREATION_MULTIPLIER,
    output: 15.0,
  },
  // Opus 4.7 — opt-in for hard problems. Priced ~5× Sonnet.
  'claude-opus-4-7': {
    input: 15.0,
    cachedInput: 1.5,
    cacheCreationInput: 15.0 * CACHE_CREATION_MULTIPLIER,
    output: 75.0,
  },
};

/**
 * Pure helper; exported for unit tests.
 *
 * Anthropic's Messages API reports three input-token fields independently:
 *   - `input_tokens`            → already EXCLUDES cached reads; billed at full.
 *   - `cache_read_input_tokens` → billed at the (much cheaper) cached rate.
 *   - `cache_creation_input_tokens` → billed at a premium over full input.
 *
 * The previous implementation subtracted `cachedInputTokens` from
 * `inputTokens` before multiplying by the input rate — that double-discounted
 * cached tokens (they were never in `input_tokens` to begin with) and
 * silently treated cache creations as free.
 *
 * Trust the SDK fields as reported, multiply each by its own rate, sum.
 */
export function computeCostUsd(
  model: ClaudeModelId,
  inputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
): number {
  const rates = RATE_CARD[model];
  const cost =
    (inputTokens * rates.input +
      cachedInputTokens * rates.cachedInput +
      cacheCreationInputTokens * rates.cacheCreationInput +
      outputTokens * rates.output) /
    1_000_000;
  // Numeric safety: never report negative cost. Anthropic's SDK should never
  // report negative token counts, but if it ever does (observed once in 0.x),
  // clamp to zero rather than poison the cost table.
  return Math.max(0, cost);
}

// ---- Postgres implementation ----------------------------------------------

const INSERT_SQL = `
  INSERT INTO claude_usage (
    request_id, user_id, route, model,
    was_cache_hit,
    input_tokens, output_tokens,
    cached_input_tokens, cache_creation_input_tokens,
    cost_estimate_usd, latency_ms
  ) VALUES (
    $1, $2, $3::claude_route, $4::claude_model,
    $5,
    $6, $7,
    $8, $9,
    $10, $11
  )
`;

const SUM_SQL = `
  SELECT COALESCE(SUM(cost_estimate_usd), 0)::float8 AS total
    FROM claude_usage
   WHERE occurred_at >= $1
`;

export class PostgresUsageStore implements UsageStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async record(rec: UsageRecord): Promise<void> {
    const cost = rec.wasCacheHit
      ? 0
      : rec.costEstimateUsd ??
        computeCostUsd(
          rec.model,
          rec.inputTokens,
          rec.cachedInputTokens,
          rec.cacheCreationInputTokens,
          rec.outputTokens,
        );

    // Belt-and-suspenders: cache hit must have zero costs. The DB has a
    // CHECK constraint too, but failing here is a clearer error.
    const inputTokens = rec.wasCacheHit ? 0 : rec.inputTokens;
    const outputTokens = rec.wasCacheHit ? 0 : rec.outputTokens;
    const cachedInputTokens = rec.wasCacheHit ? 0 : rec.cachedInputTokens;
    const cacheCreationInputTokens = rec.wasCacheHit
      ? 0
      : rec.cacheCreationInputTokens;

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query(INSERT_SQL, [
        rec.requestId,
        rec.userId,
        rec.route,
        rec.model,
        rec.wasCacheHit,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        cost,
        rec.latencyMs,
      ]);
    } catch (e) {
      // Per ADR-020: cost-row write failure is a soft error; the model
      // already responded. Log and throw a typed error so the caller can
      // decide whether to surface it.
      this.logger.warn(
        {
          errMsg: errMessage(e),
          route: rec.route,
          requestId: rec.requestId,
        },
        'claude_usage insert failed',
      );
      throw new ClaudePersistenceError(
        'failed to write claude_usage row',
        e,
      );
    } finally {
      if (client) client.release();
    }
  }

  async sumCostSince(since: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ total: number }>(SUM_SQL, [since]);
      return res.rows[0]?.total ?? 0;
    } finally {
      client.release();
    }
  }
}

// ---- In-memory (for unit tests) -------------------------------------------

export class InMemoryUsageStore implements UsageStore {
  public readonly records: UsageRecord[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async record(rec: UsageRecord): Promise<void> {
    const cost = rec.wasCacheHit
      ? 0
      : rec.costEstimateUsd ??
        computeCostUsd(
          rec.model,
          rec.inputTokens,
          rec.cachedInputTokens,
          rec.cacheCreationInputTokens,
          rec.outputTokens,
        );
    this.records.push({ ...rec, costEstimateUsd: cost });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sumCostSince(since: Date): Promise<number> {
    return this.records
      .filter((r) => new Date().getTime() >= since.getTime())
      .reduce((acc, r) => acc + (r.costEstimateUsd ?? 0), 0);
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
