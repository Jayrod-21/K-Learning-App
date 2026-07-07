/**
 * Claude proxy configuration (12-factor / env-driven).
 *
 * All knobs that influence cost, latency, or security live here. Reading
 * the env at import time is deliberate: process restarts pick up new
 * settings; misconfiguration fails fast at boot, not on the first call.
 *
 * Secrets (ANTHROPIC_API_KEY, DATABASE_URL) are read here and exposed
 * ONLY through the `getApiKey()` and `getDatabaseUrl()` getters so they
 * never leak into structured logs (the config object itself is safe to
 * dump because the secrets aren't on it).
 */

import { z } from 'zod';

// --- Zod-validated env schema -----------------------------------------------

const ModelEnum = z.enum([
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
]);
export type ClaudeModelId = z.infer<typeof ModelEnum>;

const EnvSchema = z.object({
  // Secrets (handled separately — see getters below).
  ANTHROPIC_API_KEY: z.string().min(20, 'ANTHROPIC_API_KEY missing or too short'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL required for cache/usage tables'),

  // SDK behavior
  CLAUDE_BASE_URL: z.string().url().optional(),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // Retry
  CLAUDE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  CLAUDE_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  CLAUDE_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(8_000),

  // Model defaults (per-route, env-overridable).
  CLAUDE_DEFAULT_MODEL_ENRICH: ModelEnum.default('claude-haiku-4-5'),
  CLAUDE_DEFAULT_MODEL_RECOGNIZE_GRAMMAR: ModelEnum.default('claude-sonnet-4-6'),
  CLAUDE_DEFAULT_MODEL_GRADE_WRITING: ModelEnum.default('claude-sonnet-4-6'),
  CLAUDE_DEFAULT_MODEL_DIAGNOSTIC_ITEM: ModelEnum.default('claude-sonnet-4-6'),
  CLAUDE_DEFAULT_MODEL_CONVERSATION: ModelEnum.default('claude-sonnet-4-6'),
  // Image OCR is a vision task — sonnet tier (vision-capable) by default.
  CLAUDE_DEFAULT_MODEL_IMAGE_OCR: ModelEnum.default('claude-sonnet-4-6'),
  // Grammar production drills (Pass 9). Both gen + score want sonnet-grade
  // Korean reasoning (drill authoring + nuanced production grading).
  CLAUDE_DEFAULT_MODEL_GENERATE_GRAMMAR_DRILL: ModelEnum.default('claude-sonnet-4-6'),
  CLAUDE_DEFAULT_MODEL_SCORE_GRAMMAR_DRILL: ModelEnum.default('claude-sonnet-4-6'),

  // Input length caps (in characters) — prompt-injection defense.
  CLAUDE_MAX_INPUT_ENRICH: z.coerce.number().int().positive().default(2_000),
  CLAUDE_MAX_INPUT_RECOGNIZE_GRAMMAR: z.coerce.number().int().positive().default(4_000),
  CLAUDE_MAX_INPUT_GRADE_WRITING: z.coerce.number().int().positive().default(16_000),
  // Seeds are short corpus terms (a word or a grammar pattern + glosses), so a
  // tight cap is both sufficient and a prompt-injection ceiling.
  CLAUDE_MAX_INPUT_DIAGNOSTIC_ITEM: z.coerce.number().int().positive().default(1_000),
  CLAUDE_MAX_INPUT_CONVERSATION: z.coerce.number().int().positive().default(8_000),
  // Cap on the base64 image payload (characters). An 8 MiB blob is ~11.2M
  // base64 chars; 16M leaves headroom. The route's multer fileSize limit (8
  // MiB) is the primary cost/DoS cap — this is the secondary ceiling.
  CLAUDE_MAX_INPUT_IMAGE_OCR: z.coerce.number().int().positive().default(16_000_000),
  // Grammar drill: generation seeds are a short pattern + meaning + one example,
  // so a tight cap bounds the prompt and the injection surface. Scoring also
  // carries the rendered task text + the learner's answer, so it gets a larger
  // (but still bounded) ceiling.
  CLAUDE_MAX_INPUT_GENERATE_GRAMMAR_DRILL: z.coerce.number().int().positive().default(2_000),
  CLAUDE_MAX_INPUT_SCORE_GRAMMAR_DRILL: z.coerce.number().int().positive().default(4_000),

  // Cache TTLs (seconds). 0 = DO NOT cache (the CacheStore skips the write and
  // every lookup misses). Forever-caching requires the explicit
  // CACHE_TTL_FOREVER sentinel in cache.ts — no env value can express it.
  CLAUDE_CACHE_TTL_ENRICH_S: z.coerce.number().int().nonnegative().default(60 * 60 * 24 * 30),
  CLAUDE_CACHE_TTL_RECOGNIZE_GRAMMAR_S: z.coerce.number().int().nonnegative().default(60 * 60 * 24 * 30),
  CLAUDE_CACHE_TTL_GRADE_WRITING_S: z.coerce.number().int().nonnegative().default(60 * 60 * 24 * 7),
  // Diagnostic items are unique per seed AND we deliberately want variety on
  // re-runs over the same seed (so a user retaking the diagnostic doesn't see an
  // identical question). 0 = no caching. See ADR/contract §B.
  CLAUDE_CACHE_TTL_DIAGNOSTIC_ITEM_S: z.coerce.number().int().nonnegative().default(0),
  CLAUDE_CACHE_TTL_CONVERSATION_S: z.coerce.number().int().nonnegative().default(60 * 60 * 24),
  // Image OCR is keyed by image BYTES — caching is pointless (the same photo is
  // rarely re-uploaded) and would bloat the cache key. 0 = no caching. The
  // serializeMessages cache-key builder also substitutes a placeholder for the
  // base64 payload, but cacheTtl 0 means the row is never read back anyway.
  CLAUDE_CACHE_TTL_IMAGE_OCR_S: z.coerce.number().int().nonnegative().default(0),
  // Grammar drill GENERATION: 0 = no caching. We deliberately want variety on
  // re-drilling the same pattern (a learner shouldn't see the identical task
  // twice), exactly like diagnostic_item. SCORING: 0 — the result depends on the
  // learner's free-text answer, so the key is effectively unique per submit.
  CLAUDE_CACHE_TTL_GENERATE_GRAMMAR_DRILL_S: z.coerce.number().int().nonnegative().default(0),
  CLAUDE_CACHE_TTL_SCORE_GRAMMAR_DRILL_S: z.coerce.number().int().nonnegative().default(0),

  // Rate-limit (per-minute, per-bucket-key).
  CLAUDE_RATE_LIMIT_ENRICH: z.coerce.number().int().positive().default(60),
  CLAUDE_RATE_LIMIT_RECOGNIZE_GRAMMAR: z.coerce.number().int().positive().default(30),
  CLAUDE_RATE_LIMIT_GRADE_WRITING: z.coerce.number().int().positive().default(5),
  // Per run we generate at most 4 vocab/grammar items; this per-minute ceiling
  // comfortably bounds a single run while capping a runaway loop.
  CLAUDE_RATE_LIMIT_DIAGNOSTIC_ITEM: z.coerce.number().int().positive().default(20),
  CLAUDE_RATE_LIMIT_CONVERSATION: z.coerce.number().int().positive().default(10),
  // Image OCR is an expensive vision call. The per-user DAILY cap in the route
  // is the primary cost lever; this per-minute ceiling bounds a burst.
  CLAUDE_RATE_LIMIT_IMAGE_OCR: z.coerce.number().int().positive().default(10),
  // Grammar drill: a learner works one drill at a time (generate → answer →
  // submit), so 20/min per user comfortably covers normal pacing while capping a
  // runaway loop. Same ceiling for gen + score.
  CLAUDE_RATE_LIMIT_GENERATE_GRAMMAR_DRILL: z.coerce.number().int().positive().default(20),
  CLAUDE_RATE_LIMIT_SCORE_GRAMMAR_DRILL: z.coerce.number().int().positive().default(20),

  // Logging. 'silent' is a valid pino level (disables all output) and is what
  // the test harness sets; include it so loadConfig() accepts it rather than
  // throwing on an otherwise-legal pino level.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type RouteName =
  | 'enrich'
  | 'recognize_grammar'
  | 'grade_writing'
  | 'diagnostic_item'
  | 'generate_conversation'
  | 'image_ocr'
  | 'generate_grammar_drill'
  | 'score_grammar_drill';

/**
 * Every `RouteName`, as a runtime array — the canonical source of truth for the
 * routes the proxy writes to `claude_cache.route` / `claude_usage.route`.
 *
 * This array is pinned to the `RouteName` union at COMPILE time from both sides:
 *   - `satisfies readonly RouteName[]` rejects any entry that is NOT a RouteName
 *     (no bogus/extra routes may be listed here);
 *   - the `_routeNamesExhaustive` assertion below fails to compile if any
 *     RouteName is MISSING from this array.
 * Together they guarantee `ROUTE_NAMES` == `RouteName` exactly.
 *
 * The `claude_route` Postgres enum must in turn mirror this array; that DB-side
 * invariant is verified at runtime against a freshly-migrated database by
 * `server/tests/db/claude_route_enum.test.ts`. (Migrations 031/032 exist because
 * this enum silently drifted from `RouteName`; `'anon'` is deliberately absent —
 * it is a rate-limit bucket key, never a route written to the DB.)
 */
export const ROUTE_NAMES = [
  'enrich',
  'recognize_grammar',
  'grade_writing',
  'diagnostic_item',
  'generate_conversation',
  'image_ocr',
  'generate_grammar_drill',
  'score_grammar_drill',
] as const satisfies readonly RouteName[];

// Compile-time exhaustiveness: if a RouteName is added to the union above but
// not to ROUTE_NAMES, `Exclude<...>` is non-`never`, the conditional type
// resolves to `false`, and assigning `true` to it fails to compile.
const _routeNamesExhaustive: [
  Exclude<RouteName, (typeof ROUTE_NAMES)[number]>,
] extends [never]
  ? true
  : false = true;
void _routeNamesExhaustive;

export interface PublicClaudeConfig {
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;

  readonly retry: {
    readonly maxAttempts: number;
    readonly baseMs: number;
    readonly maxDelayMs: number;
  };

  readonly modelDefaults: Readonly<Record<RouteName, ClaudeModelId>>;
  readonly inputCaps: Readonly<Record<RouteName, number>>;
  readonly cacheTtlSeconds: Readonly<Record<RouteName, number>>;
  readonly rateLimitPerMinute: Readonly<Record<RouteName, number>>;

  readonly logLevel: string;
  readonly nodeEnv: 'development' | 'test' | 'production';
}

/**
 * Internal config — secrets live here and are only returned via getters.
 */
interface InternalClaudeConfig extends PublicClaudeConfig {
  readonly _apiKey: string;
  readonly _databaseUrl: string;
}

let cached: InternalClaudeConfig | null = null;

/**
 * Build the config object from process.env. Throws on validation failure.
 * Caches the result; tests can reset via `__resetConfigForTests()`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PublicClaudeConfig {
  if (cached !== null) {
    return publicView(cached);
  }
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Do NOT include env values in the error — they may contain secrets.
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid Claude proxy configuration: bad fields [${fields}]`);
  }
  const e = parsed.data;
  cached = {
    _apiKey: e.ANTHROPIC_API_KEY,
    _databaseUrl: e.DATABASE_URL,
    baseUrl: e.CLAUDE_BASE_URL,
    timeoutMs: e.CLAUDE_TIMEOUT_MS,
    retry: {
      maxAttempts: e.CLAUDE_RETRY_MAX_ATTEMPTS,
      baseMs: e.CLAUDE_RETRY_BASE_MS,
      maxDelayMs: e.CLAUDE_RETRY_MAX_DELAY_MS,
    },
    modelDefaults: {
      enrich: e.CLAUDE_DEFAULT_MODEL_ENRICH,
      recognize_grammar: e.CLAUDE_DEFAULT_MODEL_RECOGNIZE_GRAMMAR,
      grade_writing: e.CLAUDE_DEFAULT_MODEL_GRADE_WRITING,
      diagnostic_item: e.CLAUDE_DEFAULT_MODEL_DIAGNOSTIC_ITEM,
      generate_conversation: e.CLAUDE_DEFAULT_MODEL_CONVERSATION,
      image_ocr: e.CLAUDE_DEFAULT_MODEL_IMAGE_OCR,
      generate_grammar_drill: e.CLAUDE_DEFAULT_MODEL_GENERATE_GRAMMAR_DRILL,
      score_grammar_drill: e.CLAUDE_DEFAULT_MODEL_SCORE_GRAMMAR_DRILL,
    },
    inputCaps: {
      enrich: e.CLAUDE_MAX_INPUT_ENRICH,
      recognize_grammar: e.CLAUDE_MAX_INPUT_RECOGNIZE_GRAMMAR,
      grade_writing: e.CLAUDE_MAX_INPUT_GRADE_WRITING,
      diagnostic_item: e.CLAUDE_MAX_INPUT_DIAGNOSTIC_ITEM,
      generate_conversation: e.CLAUDE_MAX_INPUT_CONVERSATION,
      image_ocr: e.CLAUDE_MAX_INPUT_IMAGE_OCR,
      generate_grammar_drill: e.CLAUDE_MAX_INPUT_GENERATE_GRAMMAR_DRILL,
      score_grammar_drill: e.CLAUDE_MAX_INPUT_SCORE_GRAMMAR_DRILL,
    },
    cacheTtlSeconds: {
      enrich: e.CLAUDE_CACHE_TTL_ENRICH_S,
      recognize_grammar: e.CLAUDE_CACHE_TTL_RECOGNIZE_GRAMMAR_S,
      grade_writing: e.CLAUDE_CACHE_TTL_GRADE_WRITING_S,
      diagnostic_item: e.CLAUDE_CACHE_TTL_DIAGNOSTIC_ITEM_S,
      generate_conversation: e.CLAUDE_CACHE_TTL_CONVERSATION_S,
      image_ocr: e.CLAUDE_CACHE_TTL_IMAGE_OCR_S,
      generate_grammar_drill: e.CLAUDE_CACHE_TTL_GENERATE_GRAMMAR_DRILL_S,
      score_grammar_drill: e.CLAUDE_CACHE_TTL_SCORE_GRAMMAR_DRILL_S,
    },
    rateLimitPerMinute: {
      enrich: e.CLAUDE_RATE_LIMIT_ENRICH,
      recognize_grammar: e.CLAUDE_RATE_LIMIT_RECOGNIZE_GRAMMAR,
      grade_writing: e.CLAUDE_RATE_LIMIT_GRADE_WRITING,
      diagnostic_item: e.CLAUDE_RATE_LIMIT_DIAGNOSTIC_ITEM,
      generate_conversation: e.CLAUDE_RATE_LIMIT_CONVERSATION,
      image_ocr: e.CLAUDE_RATE_LIMIT_IMAGE_OCR,
      generate_grammar_drill: e.CLAUDE_RATE_LIMIT_GENERATE_GRAMMAR_DRILL,
      score_grammar_drill: e.CLAUDE_RATE_LIMIT_SCORE_GRAMMAR_DRILL,
    },
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
  };
  return publicView(cached);
}

function publicView(c: InternalClaudeConfig): PublicClaudeConfig {
  const { _apiKey: _a, _databaseUrl: _d, ...pub } = c;
  void _a;
  void _d;
  return pub;
}

/** Internal — used only by client.ts and cache.ts. NEVER logged. */
export function getApiKey(): string {
  if (cached === null) {
    loadConfig();
  }
  // Non-null assert: loadConfig() either populates cached or throws.
  return cached!._apiKey;
}

export function getDatabaseUrl(): string {
  if (cached === null) {
    loadConfig();
  }
  return cached!._databaseUrl;
}

/** Test-only: reset the memoized config so a new env can be loaded. */
export function __resetConfigForTests(): void {
  cached = null;
}
