-- =============================================================================
-- Migration: 004_claude_cache_and_usage (up)
-- =============================================================================
-- Owner:        Agent B4 (Claude proxy module)
-- Target:       PostgreSQL 16+
-- Depends on:   001_core_schema (provides set_updated_at(); users table for the
--               optional user_id FK on claude_usage).
-- Sibling migs: 002_darakwon_corpora (A2), 003_krdict (B2). 003 owned by B2 —
--               THIS file MUST NOT redefine anything 003 owns.
-- Contract:     See Repository/db/docs/ADR-020-claude-proxy-architecture.md
--               (caching strategy, model rationale, prompt-injection defenses)
--
-- What this migration creates:
--   1. Enum types: claude_model, claude_route
--   2. Table claude_cache  — prompt_hash → response JSONB, TTL via expires_at
--   3. Table claude_usage  — per-call cost / latency / token accounting
--   4. Helper view claude_usage_daily (aggregates by day × route × model)
--
-- Idempotency:
--   - All CREATEs use IF NOT EXISTS or DO-block guards (for enums).
--   - Triggers use CREATE OR REPLACE TRIGGER (PG 14+).
--   - Re-applying after partial failure is safe.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   The runner (migrate.py) wraps each migration body in a single transaction
--   together with the schema_migrations bookkeeping write.
--
-- Manual application (NOT recommended in production):
--   psql -v ON_ERROR_STOP=1 -1 -f 004_claude_cache_and_usage.up.sql
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. Enum types
-- -----------------------------------------------------------------------------
-- Closed value set for routes (matches the public TS API surface). Adding a new
-- route requires a forward-only migration to extend the enum (ALTER TYPE …
-- ADD VALUE), which is intentional friction — every new Claude-touching route
-- gets reviewed.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claude_route') THEN
        CREATE TYPE claude_route AS ENUM (
            'enrich',
            'recognize_grammar',
            'grade_writing',
            'generate_conversation'
        );
    END IF;
END $$;

-- Closed value set for model IDs. Stored as enum so a malformed model string
-- never reaches the cost table. New model defaults require a migration —
-- desired; surprise model migrations are how cost bills explode.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claude_model') THEN
        CREATE TYPE claude_model AS ENUM (
            'claude-haiku-4-5',
            'claude-sonnet-4-6',
            'claude-opus-4-7'
        );
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. claude_cache — keyed response cache
-- -----------------------------------------------------------------------------
-- Why this exists: the same (lemma, source_sentence) tap is repeated dozens of
-- times across a study session and re-issuing the same prompt to Anthropic is
-- pure waste. We hash the (route, model, prompt-canonical-form) into a 64-hex
-- digest and key the cache on that + model. Hash collisions are not a
-- correctness concern at SHA-256 strength.
--
-- Note vs Anthropic's built-in prompt caching: that caches the SYSTEM prompt
-- and large static blocks server-side at Anthropic (5-min TTL). It still costs
-- per request (just cheaper). This table caches the entire RESPONSE locally
-- so a repeat lookup is free and offline-tolerant.
CREATE TABLE IF NOT EXISTS claude_cache (
    -- Surrogate PK (ADR-001 D2). prompt_hash is the natural key but we keep
    -- id for stable FK references from logs and for ORDER BY stability.
    id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- SHA-256 hex digest of the canonical prompt form (route + model + system
    -- + user content with whitespace normalized). 64 lowercase hex chars,
    -- enforced by CHECK so a malformed hash never reaches the lookup path.
    prompt_hash     TEXT         NOT NULL,

    -- Which model produced this response. Part of the cache key because
    -- responses from different models must not be cross-served.
    model           claude_model NOT NULL,

    -- The route that produced this response. Not part of the key (it's
    -- already baked into prompt_hash) but kept for diagnostics — "which
    -- route is bloating the cache?".
    route           claude_route NOT NULL,

    -- Cached response payload. JSONB (ADR-001 D5) so we can introspect later
    -- without parsing. Shape is per-route (EnrichmentResult, PatternResult,
    -- GradeResult, ConversationTurn[]). Validation lives at the app layer;
    -- DB does shape-of-text checks only.
    response        JSONB        NOT NULL,

    -- TTL. NULL = no expiry (used for long-stable system prompts; not used
    -- by current routes but present for forward compat). Otherwise the
    -- cache layer treats a row with now() >= expires_at as a miss and
    -- background-evicts it. (ADR-020 §3.)
    expires_at      TIMESTAMPTZ  NULL,

    -- Observability.
    hit_count       BIGINT       NOT NULL DEFAULT 0,
    last_hit_at     TIMESTAMPTZ  NULL,

    -- Audit (ADR-001 D6). No version column: cache rows are immutable
    -- modulo the hit_count counter; optimistic concurrency does not apply.
    -- No soft delete (ADR-001 D7): cache is transient, hard-delete is fine.
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_claude_cache_hash_model
        UNIQUE (prompt_hash, model),
    CONSTRAINT ck_claude_cache_hash_shape
        CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_claude_cache_hit_count_nonneg
        CHECK (hit_count >= 0),
    CONSTRAINT ck_claude_cache_last_hit_after_created
        CHECK (last_hit_at IS NULL OR last_hit_at >= created_at)
);

COMMENT ON TABLE claude_cache IS
    'Local response cache for Claude API calls. Key: (prompt_hash, model). '
    'Avoids re-charging for repeat (lemma, sentence) taps. Distinct from '
    'Anthropic''s server-side prompt cache: that reduces per-call cost; this '
    'eliminates the call entirely. See ADR-020.';

COMMENT ON COLUMN claude_cache.prompt_hash IS
    'SHA-256 hex of the canonical prompt form (route|model|system|user, '
    'whitespace-normalized). Verified by ck_claude_cache_hash_shape.';
COMMENT ON COLUMN claude_cache.model IS
    'Part of the cache key — same prompt to different models must not collide.';
COMMENT ON COLUMN claude_cache.route IS
    'Diagnostic only (already baked into prompt_hash). Filterable for "which '
    'route fills the cache?" queries.';
COMMENT ON COLUMN claude_cache.response IS
    'Per-route response payload (JSONB). Shape validated at the app layer '
    'against the route''s Zod schema before being served from cache.';
COMMENT ON COLUMN claude_cache.expires_at IS
    'NULL = no expiry. Otherwise the cache layer treats now() >= expires_at '
    'as a miss. Background eviction in claude/cache.ts.';
COMMENT ON COLUMN claude_cache.hit_count IS
    'Incremented on each cache hit. Drives "hottest cache entries" reports.';

-- Indexes
-- Lookup is `WHERE prompt_hash = $1 AND model = $2` — the unique constraint
-- already provides the index. The partial below filters expired rows out of
-- the eviction sweep.
CREATE INDEX IF NOT EXISTS ix_claude_cache_expired
    ON claude_cache (expires_at)
    WHERE expires_at IS NOT NULL;
COMMENT ON INDEX ix_claude_cache_expired IS
    'Supports the periodic eviction job: DELETE FROM claude_cache WHERE '
    'expires_at < now(). Partial because most-cached entries do expire.';

-- Routes-by-volume diagnostic.
CREATE INDEX IF NOT EXISTS ix_claude_cache_route_created
    ON claude_cache (route, created_at DESC);
COMMENT ON INDEX ix_claude_cache_route_created IS
    'Supports "last N entries cached per route" and "cache growth by route" '
    'reports.';

-- updated_at trigger.
CREATE OR REPLACE TRIGGER trg_claude_cache_updated_at
    BEFORE UPDATE ON claude_cache
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. claude_usage — per-call cost / token / latency accounting
-- -----------------------------------------------------------------------------
-- Why this exists: cost visibility. A single dashboard query of the form
-- `SELECT date_trunc('day', occurred_at), SUM(cost_estimate_usd) FROM
-- claude_usage GROUP BY 1 ORDER BY 1 DESC` answers "how much did I spend
-- yesterday?" without scraping Anthropic's console.
--
-- request_id is the correlation ID propagated from the Express edge through
-- this module to the response. It is a TEXT (UUID v4 or similar) rather than
-- an FK because there is no central request-log table yet (and may never be —
-- pino logs ARE the audit trail). Keeping it text lets the request log live
-- in any backend.
CREATE TABLE IF NOT EXISTS claude_usage (
    id                      BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Correlation ID propagated from the Express edge. Plain TEXT (not UUID)
    -- because the format is the edge's choice. We index it for forensic
    -- lookups: "show me everything that request did".
    request_id              TEXT          NOT NULL,

    -- Optional FK to users. NULL when the call is system-initiated (e.g., a
    -- nightly TOPIK-prep pre-warm job). SET NULL on user delete so historical
    -- cost data survives a user purge (auditors care, cost analysts care).
    user_id                 BIGINT        NULL,

    -- Which route was called. Constrained enum so a typo'd route never lands
    -- in the cost report.
    route                   claude_route  NOT NULL,

    -- Which model served the call.
    model                   claude_model  NOT NULL,

    -- Whether the call hit our LOCAL Postgres cache (was_cache_hit = true →
    -- no Anthropic call was made; input/output tokens are 0; cost is 0).
    -- Kept in the same table so cache hit rate computes trivially:
    --   SUM(was_cache_hit::int)::numeric / COUNT(*).
    was_cache_hit           BOOLEAN       NOT NULL DEFAULT FALSE,

    -- Token counts as reported by Anthropic. NUMERIC (not BIGINT) because
    -- aggregation produces fractional cost; NUMERIC is exact and we never
    -- want a rounding error in a billing report.
    input_tokens            NUMERIC(18,0) NOT NULL DEFAULT 0,
    output_tokens           NUMERIC(18,0) NOT NULL DEFAULT 0,

    -- Tokens served from Anthropic's prompt cache (counted toward usage at
    -- a discounted rate). Reported separately so we can verify cache_control
    -- is actually working.
    cached_input_tokens     NUMERIC(18,0) NOT NULL DEFAULT 0,

    -- Tokens WRITTEN to Anthropic's prompt cache on this call
    -- (usage.cache_creation_input_tokens off the wire). Billed at a premium
    -- over the full input rate (commonly 1.25× for ephemeral cache). Tracked
    -- separately so the dashboard can answer "are cache writes paying off?".
    cache_creation_input_tokens NUMERIC(18,0) NOT NULL DEFAULT 0,

    -- Cost in USD, computed at write time from the model's rate card and
    -- the token counts. NUMERIC(12,6) — 6 decimal places handles a tenth
    -- of a cent precisely, 12 digits covers any plausible single call.
    cost_estimate_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,

    -- Wall-clock latency to first response (non-streaming) or to completion
    -- (streaming). Milliseconds, INT is enough (24 days).
    latency_ms              INTEGER       NOT NULL,

    -- When the call landed. TIMESTAMPTZ (ADR-001 D3).
    occurred_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- Audit. No updated_at trigger here: usage rows are append-only and
    -- never edited. version stays for ADR-001 D6 conformance.
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    version                 INTEGER       NOT NULL DEFAULT 1,

    CONSTRAINT ck_claude_usage_input_tokens_nonneg
        CHECK (input_tokens >= 0),
    CONSTRAINT ck_claude_usage_output_tokens_nonneg
        CHECK (output_tokens >= 0),
    CONSTRAINT ck_claude_usage_cached_input_tokens_nonneg
        CHECK (cached_input_tokens >= 0),
    CONSTRAINT ck_claude_usage_cache_creation_tokens_nonneg
        CHECK (cache_creation_input_tokens >= 0),
    CONSTRAINT ck_claude_usage_cost_nonneg
        CHECK (cost_estimate_usd >= 0),
    CONSTRAINT ck_claude_usage_latency_nonneg
        CHECK (latency_ms >= 0),
    CONSTRAINT ck_claude_usage_request_id_nonempty
        CHECK (length(request_id) BETWEEN 1 AND 128),
    -- A cache hit should have zero billable tokens. Defense in depth against
    -- writer bugs that would double-count cost on a cache hit.
    CONSTRAINT ck_claude_usage_cache_hit_zero_cost
        CHECK (NOT was_cache_hit
               OR (input_tokens = 0
                   AND output_tokens = 0
                   AND cached_input_tokens = 0
                   AND cache_creation_input_tokens = 0
                   AND cost_estimate_usd = 0)),
    CONSTRAINT fk_claude_usage_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE SET NULL
        ON UPDATE RESTRICT
);

COMMENT ON TABLE claude_usage IS
    'Per-call accounting for Claude API. Append-only. Drives cost dashboards '
    'and rate-limit analytics. cache_hit rows are zero-cost markers so cache '
    'effectiveness can be computed without a join.';

COMMENT ON COLUMN claude_usage.request_id IS
    'Correlation ID from the Express edge. Plain TEXT, not FK — the request '
    'log lives in pino, not in a DB table.';
COMMENT ON COLUMN claude_usage.user_id IS
    'NULL = system-initiated call (e.g., pre-warm job). FK SET NULL on user '
    'delete so cost history survives a user purge.';
COMMENT ON COLUMN claude_usage.was_cache_hit IS
    'TRUE when served from local claude_cache. token / cost columns must be '
    '0 in that case (enforced by ck_claude_usage_cache_hit_zero_cost).';
COMMENT ON COLUMN claude_usage.input_tokens IS
    'Tokens charged at the full input rate. NUMERIC for exact aggregation.';
COMMENT ON COLUMN claude_usage.cached_input_tokens IS
    'Tokens served from Anthropic''s prompt cache at a discounted rate. '
    'Separately tracked to verify cache_control is hitting.';
COMMENT ON COLUMN claude_usage.cache_creation_input_tokens IS
    'Tokens written to Anthropic''s prompt cache on this call. Billed at '
    'a premium over standard input (~1.25x for ephemeral cache). Watching '
    'this column tells you whether cache writes are paying off vs cached '
    'reads on subsequent calls.';
COMMENT ON COLUMN claude_usage.cost_estimate_usd IS
    'Computed at write time from the model rate card. Estimate only — the '
    'authoritative bill is Anthropic''s monthly invoice.';

-- Indexes
-- Cost-by-day dashboard: range scan on occurred_at + grouping on route, model.
CREATE INDEX IF NOT EXISTS ix_claude_usage_occurred_at
    ON claude_usage (occurred_at DESC);
COMMENT ON INDEX ix_claude_usage_occurred_at IS
    'Supports cost-by-day dashboards: range scan on occurred_at then group.';

-- Forensic lookup by correlation ID.
CREATE INDEX IF NOT EXISTS ix_claude_usage_request_id
    ON claude_usage (request_id);
COMMENT ON INDEX ix_claude_usage_request_id IS
    'Supports "show me everything request X did" forensic queries.';

-- Per-user cost queries.
CREATE INDEX IF NOT EXISTS ix_claude_usage_user_day
    ON claude_usage (user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;
COMMENT ON INDEX ix_claude_usage_user_day IS
    'Supports per-user cost rollups. Partial because system calls (NULL '
    'user) are aggregated separately.';

-- updated_at trigger (for ADR-001 D6 conformance even though rows are
-- append-only in practice).
CREATE OR REPLACE TRIGGER trg_claude_usage_updated_at
    BEFORE UPDATE ON claude_usage
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. claude_usage_daily — convenience view
-- -----------------------------------------------------------------------------
-- The dashboard query, materialized as a view for ergonomics. Not a
-- materialized view: the data volume is small and the freshness requirement
-- is "live". Promote to MATERIALIZED VIEW + REFRESH if it becomes a hot path.
CREATE OR REPLACE VIEW claude_usage_daily AS
SELECT
    date_trunc('day', occurred_at)            AS day,
    route,
    model,
    COUNT(*)                                  AS call_count,
    SUM((was_cache_hit)::int)                 AS cache_hits,
    SUM(input_tokens)                         AS total_input_tokens,
    SUM(output_tokens)                        AS total_output_tokens,
    SUM(cached_input_tokens)                  AS total_cached_input_tokens,
    SUM(cache_creation_input_tokens)          AS total_cache_creation_input_tokens,
    SUM(cost_estimate_usd)                    AS total_cost_usd,
    AVG(latency_ms)::INTEGER                  AS avg_latency_ms,
    MAX(latency_ms)                           AS max_latency_ms
FROM claude_usage
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

COMMENT ON VIEW claude_usage_daily IS
    'Daily cost rollup by route and model. Powers the cost dashboard. Not '
    'materialized — volume is small and freshness is required. Promote to '
    'MATERIALIZED VIEW if it becomes a hot path.';
