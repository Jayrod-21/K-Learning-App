-- =============================================================================
-- Migration: 001_core_schema (up)
-- =============================================================================
-- Owner:        Agent A1 (core schema)
-- Target:       PostgreSQL 16+
-- Sibling migs: 002_darakwon_corpora (A2) — adds corpus tables and back-references
--               FROM the corpus side to the user-facing tables defined here.
-- Contract:     See Repository/db/docs/ADR-001-database-choices.md (foundation)
--               See Repository/db/docs/ADR-002-auth-and-sessions.md
--               See Repository/db/docs/ADR-003-fsrs-storage.md
--               See Repository/db/docs/ADR-004-soft-fk-to-corpus.md
--
-- What this migration creates:
--   1. Extensions (citext, pgcrypto)
--   2. Shared trigger function set_updated_at()
--   3. Enum types (proficiency_level, register, topik_section, corpus, book_level)
--   4. Auth: users, sessions
--   5. User state: study_log, user_progress, diagnostic_snapshots, conversations
--   6. Grammar bank: grammar_entries (user-banked canonical patterns)
--   7. SRS (FSRS): vocab_cards, card_reviews
--
-- Out of scope (owned by A2):
--   - sources, source_units, sentences, vocab_occurrences
--   - krdict_cache, claude_enrichment_cache
--   - topik_tests, topik_items, topik_options, topik_attempts
--
-- Idempotency notes:
--   - Extensions and the trigger function use IF NOT EXISTS / CREATE OR REPLACE.
--   - Tables use CREATE TABLE IF NOT EXISTS so re-applying after a partial failure
--     is safe. Enum types do not support IF NOT EXISTS in PG 16; we DO block-guard
--     them via DO $$ … $$.
--   - Order: types → functions → tables → indexes → comments → triggers.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write. An inner COMMIT here would
--   end the runner's transaction early and break the atomicity guarantee.
--   `discover_migrations` enforces this rule at discovery time.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
-- citext: case-insensitive TEXT for email uniqueness without LOWER() everywhere.
-- pgcrypto: digest() for SHA-256-hashing the raw session token at lookup time
-- (sessions.token_hash = encode(digest($1, 'sha256'), 'hex')). Token generation
-- itself happens at the app layer (ADR-002 §D2 — `os.urandom` / `crypto.
-- randomBytes`), not in the DB.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 2. Shared trigger function: maintain updated_at on UPDATE
-- -----------------------------------------------------------------------------
-- One copy, reused by every entity table. Defined CREATE OR REPLACE so the
-- migration is idempotent and downstream migrations (e.g. 002) can rely on it
-- without redefining.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION set_updated_at() IS
    'Generic BEFORE UPDATE trigger function: stamps updated_at to now(). '
    'Reused by every entity table that has an updated_at audit column. '
    'No business logic — purely mechanical maintenance (ADR-001 D12).';

-- -----------------------------------------------------------------------------
-- 3. Enum types (closed value sets — ADR-001 D8)
-- -----------------------------------------------------------------------------
-- DO blocks guard creation so the migration is re-runnable; PG 16 does not
-- support CREATE TYPE IF NOT EXISTS for enums.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'proficiency_level') THEN
        CREATE TYPE proficiency_level AS ENUM ('basic', 'L3', 'L4', 'L5+');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'register_level') THEN
        -- Named register_level (not "register") because REGISTER is a SQL
        -- reserved-ish word in some dialects and a Postgres column/type named
        -- exactly "register" can produce surprising parser behavior in tooling.
        CREATE TYPE register_level AS ENUM ('반말', '해요체', '합쇼체', '문어체', '하오체', '하게체');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topik_section') THEN
        CREATE TYPE topik_section AS ENUM ('reading', 'listening', 'writing');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'corpus') THEN
        CREATE TYPE corpus AS ENUM (
            'ttmik',
            'iyagi',
            'topik',
            'kgiu_beginner',
            'kgiu_intermediate',
            'kgiu_advanced',
            'vocab_2000_beginner',
            'vocab_2000_intermediate'
        );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'book_level') THEN
        CREATE TYPE book_level AS ENUM ('beginner', 'intermediate', 'advanced');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'card_face') THEN
        -- Card direction in SRS. Drives which side is prompted on review.
        CREATE TYPE card_face AS ENUM ('recognition', 'production', 'cloze');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fsrs_rating') THEN
        -- FSRS canonical ratings: Again=1, Hard=2, Good=3, Easy=4 — stored as
        -- enum for type safety; the integer mapping is the app's concern.
        CREATE TYPE fsrs_rating AS ENUM ('again', 'hard', 'good', 'easy');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fsrs_state') THEN
        -- FSRS card lifecycle states. New → learning → review (relearning on lapse).
        CREATE TYPE fsrs_state AS ENUM ('new', 'learning', 'review', 'relearning');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_mode') THEN
        CREATE TYPE conversation_mode AS ENUM ('casual', 'business', 'research', 'topik_prep', 'register_drill');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. AUTH: users
-- -----------------------------------------------------------------------------
-- Single-user app today, multi-user shaped tomorrow. See ADR-002.
CREATE TABLE IF NOT EXISTS users (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    email           CITEXT      NOT NULL,
    -- Argon2id encoded string (includes algorithm, params, salt, hash).
    -- See ADR-002 for the choice rationale. Stored as TEXT; length capped at
    -- 255 chars which fits any argon2id encoding the app will produce.
    password_hash   TEXT        NOT NULL,

    -- Optional display name. Nullable: not required at signup; the app may
    -- prompt for it later. (ADR-001 §1: nullable must be justified.)
    display_name    TEXT,

    -- Email verification — a "deploy priority" per global standing orders.
    email_verified_at TIMESTAMPTZ,

    -- Last successful login. Nullable until first login. Used for stale-account
    -- detection and forensic timelines.
    last_login_at   TIMESTAMPTZ,

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    -- Soft delete: a user can be deactivated without losing their history.
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT uq_users_email          UNIQUE (email),
    CONSTRAINT ck_users_email_length   CHECK (length(email) BETWEEN 3 AND 254),
    CONSTRAINT ck_users_email_shape    CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- F2 (REVIEW_A1): the prior floor of 32 chars accepted bcrypt (60),
    -- raw SHA-256 hex (64), and other obvious regressions. Argon2id PHC
    -- strings start with `$argon2id$` and are ≥80 chars in any realistic
    -- parameterization (`$argon2id$v=19$m=…$…` baseline at m=64MiB t=3 p=1
    -- produces ~96 chars). The prefix check pins the hasher and the
    -- length range allows parameter upgrades.
    CONSTRAINT ck_users_password_hash_argon2id
        CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) BETWEEN 80 AND 255),
    CONSTRAINT ck_users_display_name_length  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
    CONSTRAINT ck_users_version_positive     CHECK (version >= 1)
);

COMMENT ON TABLE  users IS
    'Application user accounts. Replaces Supabase auth.users. Single-user today; '
    'designed multi-user. Authentication via password (Argon2id) + opaque session '
    'cookie (see sessions table). See ADR-002.';
COMMENT ON COLUMN users.email IS
    'Case-insensitive (citext) unique email. Local-part + domain validated by '
    'ck_users_email_shape; deeper RFC-5321 validation happens at the app layer.';
COMMENT ON COLUMN users.password_hash IS
    'Argon2id encoded string (PHC format). NEVER log this column. NEVER ship to '
    'the client. The hash includes algo+params+salt; rotation is by re-hashing on '
    'next successful login.';
COMMENT ON COLUMN users.display_name IS
    'Optional display name. Null until the user sets one — kept nullable to keep '
    'signup minimal.';
COMMENT ON COLUMN users.email_verified_at IS
    'Timestamp the verification link was clicked. NULL = unverified.';
COMMENT ON COLUMN users.last_login_at IS
    'Timestamp of the most recent successful login. NULL = never logged in '
    '(account just created).';
COMMENT ON COLUMN users.deleted_at IS
    'Soft delete. When set, the account is treated as deactivated. The unique '
    'email constraint still applies — to re-use an email after deletion the row '
    'must be hard-purged by an admin operation.';
COMMENT ON COLUMN users.version IS
    'Optimistic concurrency token. UPDATE … WHERE version = $expected — bump on write.';

-- Partial index: most queries care only about live users. The unique constraint
-- on email already creates a btree index that covers email lookups.
CREATE INDEX IF NOT EXISTS ix_users_live
    ON users (id)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_users_live IS
    'Partial index supporting "live users only" scans (admin dashboards, periodic '
    'jobs). Covers queries of the form: WHERE deleted_at IS NULL.';

CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4b. AUTH: sessions (server-side opaque tokens)
-- -----------------------------------------------------------------------------
-- Stateless JWTs were rejected — see ADR-002. Tokens are 32 random bytes (256-bit),
-- hashed with SHA-256 before storage so a DB read does not yield usable tokens.
CREATE TABLE IF NOT EXISTS sessions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- SHA-256 hex digest of the raw token. 64 hex chars. The raw token is
    -- delivered to the client in an HttpOnly+Secure+SameSite=Strict cookie and
    -- is NEVER stored in this table.
    token_hash      TEXT        NOT NULL,

    -- Browser fingerprint hints — used for anomaly detection, not authentication.
    user_agent      TEXT,
    ip_address      INET,

    -- Sessions expire absolutely (issued_at + lifetime). Rotation extends by
    -- minting a new row, never by mutating expires_at.
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Explicit logout / revocation. Hard-deleted on cleanup; revoked_at lets a
    -- short audit window still observe the revocation cause.
    revoked_at      TIMESTAMPTZ,
    revoked_reason  TEXT,

    -- Audit (no soft delete — sessions are transient per ADR-001 D7)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_sessions_token_hash   UNIQUE (token_hash),
    CONSTRAINT ck_sessions_token_hash_shape  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sessions_expires_after_issue CHECK (expires_at > issued_at),
    CONSTRAINT ck_sessions_revoked_reason_when_revoked CHECK (
        (revoked_at IS NULL AND revoked_reason IS NULL)
        OR (revoked_at IS NOT NULL)
    )
);

COMMENT ON TABLE  sessions IS
    'Server-side session store. One row per active token. Token in the DB is '
    'the SHA-256 of the raw bytes — DB compromise does not yield live tokens. '
    'Cookie is HttpOnly+Secure+SameSite=Strict. See ADR-002.';
COMMENT ON COLUMN sessions.token_hash IS
    'SHA-256 hex of the raw 32-byte session token. The raw token never lives '
    'in the database. Lookup pattern: SELECT … WHERE token_hash = digest($1, ''sha256'').';
COMMENT ON COLUMN sessions.user_agent IS
    'User-Agent string captured at session issue. For anomaly detection only — '
    'NEVER used as an auth factor.';
COMMENT ON COLUMN sessions.ip_address IS
    'IP address captured at session issue. Same caveat as user_agent.';
COMMENT ON COLUMN sessions.expires_at IS
    'Absolute expiry. Sessions are NOT extended in place; rotation = new row + '
    'cookie swap. Default lifetime is enforced by the app layer (see ADR-002).';
COMMENT ON COLUMN sessions.last_seen_at IS
    'Bumped on each authenticated request. Used for idle-timeout policies and '
    'forensic timelines.';
COMMENT ON COLUMN sessions.revoked_at IS
    'When the session was explicitly revoked (logout, password change, etc.). '
    'NULL = active. Revoked sessions are kept briefly for audit, then purged.';

-- Lookup pattern: "validate cookie token" — by token_hash, only if active and unexpired.
CREATE INDEX IF NOT EXISTS ix_sessions_active_lookup
    ON sessions (token_hash)
    WHERE revoked_at IS NULL;
COMMENT ON INDEX ix_sessions_active_lookup IS
    'Hot path: every authenticated request hits this. Partial-indexed on '
    'revoked_at IS NULL so the index stays compact as old sessions accumulate.';

-- Lookup pattern: list a user''s active sessions (UI: "sign me out everywhere").
CREATE INDEX IF NOT EXISTS ix_sessions_user_active
    ON sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;
COMMENT ON INDEX ix_sessions_user_active IS
    'Supports "list my active sessions" and bulk-revoke flows. Ordered by '
    'expires_at DESC for the typical "show newest first" UI.';

-- Lookup pattern: scheduled purge of expired/revoked sessions.
CREATE INDEX IF NOT EXISTS ix_sessions_expires_at
    ON sessions (expires_at);
COMMENT ON INDEX ix_sessions_expires_at IS
    'Used by the periodic cleanup job: DELETE … WHERE expires_at < now() - $retention.';

CREATE OR REPLACE TRIGGER trg_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. USER STATE: study_log
-- -----------------------------------------------------------------------------
-- One row per (user, calendar date) — the "did I study today" rollup that drives
-- the streak metric and 오늘 page heatmap.
CREATE TABLE IF NOT EXISTS study_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,
    study_date      DATE        NOT NULL,

    minutes_studied NUMERIC(6, 2) NOT NULL DEFAULT 0,
    -- Itemized activity list: [{kind: 'reading', source_unit_id: 12, ...}, …]
    -- JSONB so the app can evolve the activity shape without a migration. The
    -- *aggregate* (minutes_studied) is the source of truth for metrics.
    activities      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    goal_met        BOOLEAN     NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_study_log_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_study_log_user_date UNIQUE (user_id, study_date),
    CONSTRAINT ck_study_log_minutes_nonneg CHECK (minutes_studied >= 0),
    CONSTRAINT ck_study_log_activities_array CHECK (jsonb_typeof(activities) = 'array')
);

COMMENT ON TABLE  study_log IS
    'Per-day study rollup. One row per (user, study_date). Drives streak metric, '
    '오늘 page heatmap, and weekly summary.';
COMMENT ON COLUMN study_log.study_date IS
    'Calendar date in the user''s local timezone. The app is responsible for '
    'choosing the right day boundary (midnight in Asia/Seoul vs America/Denver).';
COMMENT ON COLUMN study_log.activities IS
    'Itemized list of activities completed that day. Shape evolves at the app '
    'layer without DB migration. Constraint: must be a JSON array.';

CREATE OR REPLACE TRIGGER trg_study_log_updated_at
    BEFORE UPDATE ON study_log
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. USER STATE: user_progress (named metric snapshots)
-- -----------------------------------------------------------------------------
-- One row per (user, metric_type, captured_at). Treated as a time-series — never
-- overwrite a snapshot; insert a new row. The "current value" is the most recent
-- row per (user, metric_type).
CREATE TABLE IF NOT EXISTS user_progress (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Open set: 'streak', 'vocab_mastered', 'reading_level', 'topik2_readiness',
    -- 'korean_age', 'grammar_banked', etc. CHECK enforces shape, not membership.
    metric_type     TEXT        NOT NULL,
    value           JSONB       NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_user_progress_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_user_progress_metric_type_shape
        CHECK (metric_type ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT ck_user_progress_value_object
        CHECK (jsonb_typeof(value) IN ('object', 'number', 'string'))
);

COMMENT ON TABLE  user_progress IS
    'Append-only metric history. Each (user, metric_type) is a time-series; the '
    'most-recent row is the current value. Never update value — write a new row.';
COMMENT ON COLUMN user_progress.metric_type IS
    'Snake-case metric identifier. Open set (no enum) — easier to add new metrics '
    'without migration. Shape validated by ck_user_progress_metric_type_shape.';

CREATE INDEX IF NOT EXISTS ix_user_progress_user_metric_time
    ON user_progress (user_id, metric_type, captured_at DESC);
COMMENT ON INDEX ix_user_progress_user_metric_time IS
    'Hot path: "current value of metric X for user Y" — ORDER BY captured_at DESC '
    'LIMIT 1. Composite ordered by (user, metric, time) matches that query exactly.';

CREATE OR REPLACE TRIGGER trg_user_progress_updated_at
    BEFORE UPDATE ON user_progress
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. USER STATE: diagnostic_snapshots
-- -----------------------------------------------------------------------------
-- Multi-dimensional adaptive diagnostic output. Each run produces one row with
-- per-dimension estimates and the underlying evidence. "Trajectory" is the series.
CREATE TABLE IF NOT EXISTS diagnostic_snapshots (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Dimension estimates (0.00 – 6.00 scale, TOPIK levels with sub-decimal).
    reading_estimate    NUMERIC(3, 2),
    listening_estimate  NUMERIC(3, 2),
    grammar_estimate    NUMERIC(3, 2),
    vocab_estimate      NUMERIC(3, 2),
    writing_estimate    NUMERIC(3, 2),
    register_estimate   NUMERIC(3, 2),

    -- Full diagnostic transcript: items shown, answers given, scoring rubric,
    -- Claude grading output for writing. Stored as JSONB because the rubric is
    -- versioned and we need to be able to re-grade old runs.
    evidence            JSONB       NOT NULL,

    -- Snapshot metadata
    rubric_version      TEXT        NOT NULL,
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT fk_diagnostic_snapshots_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_diagnostic_snapshots_estimates_range CHECK (
        (reading_estimate   IS NULL OR reading_estimate   BETWEEN 0 AND 6) AND
        (listening_estimate IS NULL OR listening_estimate BETWEEN 0 AND 6) AND
        (grammar_estimate   IS NULL OR grammar_estimate   BETWEEN 0 AND 6) AND
        (vocab_estimate     IS NULL OR vocab_estimate     BETWEEN 0 AND 6) AND
        (writing_estimate   IS NULL OR writing_estimate   BETWEEN 0 AND 6) AND
        (register_estimate  IS NULL OR register_estimate  BETWEEN 0 AND 6)
    ),
    CONSTRAINT ck_diagnostic_snapshots_evidence_object
        CHECK (jsonb_typeof(evidence) = 'object'),
    CONSTRAINT ck_diagnostic_snapshots_rubric_version_shape
        CHECK (rubric_version ~ '^v[0-9]+\.[0-9]+\.[0-9]+$')
);

COMMENT ON TABLE  diagnostic_snapshots IS
    'Multi-dimensional adaptive diagnostic results. Append-only; gap map = diff '
    'between consecutive snapshots. Soft-deleted (kept for historical trajectory).';
COMMENT ON COLUMN diagnostic_snapshots.evidence IS
    'Full transcript of the diagnostic run: items shown, user responses, scoring '
    'breakdown, Claude grading output. Lets us re-grade against newer rubric versions.';
COMMENT ON COLUMN diagnostic_snapshots.rubric_version IS
    'Semver of the scoring rubric used. Enables re-grading old runs after rubric '
    'updates. Shape validated by check constraint.';
COMMENT ON COLUMN diagnostic_snapshots.reading_estimate IS
    'TOPIK-aligned dimension estimate (0.00–6.00). NULL means this dimension was '
    'not exercised in this run.';

CREATE INDEX IF NOT EXISTS ix_diagnostic_snapshots_user_time
    ON diagnostic_snapshots (user_id, captured_at DESC)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_diagnostic_snapshots_user_time IS
    'Supports trajectory queries: "show me my last N diagnostics in order". '
    'Partial on deleted_at IS NULL — soft-deleted snapshots are hidden from UI.';

CREATE OR REPLACE TRIGGER trg_diagnostic_snapshots_updated_at
    BEFORE UPDATE ON diagnostic_snapshots
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 8. USER STATE: conversations (AI roleplay)
-- -----------------------------------------------------------------------------
-- One row per conversation session with the Claude-backed tutor.
CREATE TABLE IF NOT EXISTS conversations (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,
    mode            conversation_mode NOT NULL,
    -- The conversation's target register (e.g. drill 합쇼체). NULL = mixed/no target.
    target_register register_level,

    -- Message list: [{role: 'user'|'assistant', content: '…', sent_at: '…'}, …]
    -- JSONB to evolve without migration. Aggregate metrics (message_count,
    -- total_tokens) are derived at app layer when needed.
    messages        JSONB       NOT NULL DEFAULT '[]'::jsonb,

    -- Last AI grading pass over the user's production, if requested.
    last_grading    JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT fk_conversations_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_conversations_messages_array CHECK (jsonb_typeof(messages) = 'array'),
    CONSTRAINT ck_conversations_grading_object CHECK (
        last_grading IS NULL OR jsonb_typeof(last_grading) = 'object'
    )
);

COMMENT ON TABLE  conversations IS
    'AI tutor / roleplay sessions. Mode and target register drive the system prompt. '
    'Messages stored as JSONB array. Soft-deleted (history is valuable as evidence).';
COMMENT ON COLUMN conversations.target_register IS
    'Register the conversation is drilling, if any. NULL = mixed / no specific drill.';
COMMENT ON COLUMN conversations.last_grading IS
    'Most recent grading pass from the Claude grader over the user''s production. '
    'NULL until first grading is requested.';

CREATE INDEX IF NOT EXISTS ix_conversations_user_updated
    ON conversations (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_conversations_user_updated IS
    'Supports the "resume recent conversation" UI. Partial on deleted_at IS NULL.';

CREATE OR REPLACE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 9. GRAMMAR BANK: grammar_entries
-- -----------------------------------------------------------------------------
-- Canonical grammar patterns the user has banked. Highlights from reading get
-- mapped here (dedup by pattern_key). This is USER-FACING grammar bank state —
-- not the corpus-side KGIU reference (A2 may add a separate kgiu_entries table).
CREATE TABLE IF NOT EXISTS grammar_entries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Stable key used for dedup. e.g. 'GR-eo-yo', 'GR-neungeol', 'GR-myeon'.
    -- App layer assigns this from Claude's pattern recognition output.
    pattern_key     TEXT        NOT NULL,
    -- Hangul display form: '-아/어/여요', '-는걸', '-(으)면'.
    pattern_display TEXT        NOT NULL,
    -- One-line English gloss for list views.
    summary_en      TEXT        NOT NULL,

    proficiency     proficiency_level NOT NULL,
    -- Domain-extensible category. TEXT + CHECK per ADR-001 D8.
    category        TEXT        NOT NULL,
    -- Optional register if the pattern is register-specific (e.g. 합쇼체 only).
    register        register_level,

    -- Free-form structured fields (examples, tips, cross-refs, source notes).
    -- Stable scalar fields are columns above; variable-shape data is JSONB.
    notes           JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- How the user got this entry — origin trail for "where did I see this?"
    discovered_via  TEXT        NOT NULL DEFAULT 'manual',

    -- Production-drill mastery flag (FSRS-driven; mirrored here for fast filter).
    is_canonical    BOOLEAN     NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT fk_grammar_entries_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_grammar_entries_user_pattern UNIQUE (user_id, pattern_key),
    CONSTRAINT ck_grammar_entries_pattern_key_shape
        CHECK (pattern_key ~ '^GR-[a-z0-9_-]{1,64}$'),
    CONSTRAINT ck_grammar_entries_summary_length CHECK (length(summary_en) BETWEEN 1 AND 240),
    CONSTRAINT ck_grammar_entries_category_known CHECK (category IN (
        'particle', 'connective', 'ending', 'auxiliary', 'modal',
        'reason', 'condition', 'concession', 'time', 'comparison',
        'quotative', 'honorific', 'tense', 'aspect', 'register',
        'derivation', 'expression', 'other'
    )),
    CONSTRAINT ck_grammar_entries_discovered_via_known CHECK (discovered_via IN (
        'manual', 'reading_highlight', 'listening_highlight', 'topik_item',
        'diagnostic', 'conversation', 'import'
    )),
    CONSTRAINT ck_grammar_entries_notes_object CHECK (jsonb_typeof(notes) = 'object')
);

COMMENT ON TABLE  grammar_entries IS
    'User-banked canonical grammar patterns. Highlights from any source dedupe '
    'into this table by (user_id, pattern_key). Production drills are scheduled '
    'via vocab_cards rows that reference these entries (card_face = ''production'').';
COMMENT ON COLUMN grammar_entries.pattern_key IS
    'Stable, app-assigned identifier (e.g. GR-eo-yo). Used to dedupe across '
    'highlight sources. Shape validated by check constraint.';
COMMENT ON COLUMN grammar_entries.category IS
    'Open category set — TEXT + CHECK rather than enum so new categories ship '
    'without migration. Adding a category = update the CHECK constraint.';
COMMENT ON COLUMN grammar_entries.notes IS
    'Structured but evolving payload: examples[], tips[], cross_refs[], '
    'source_excerpts[]. JSONB object — variable shape lives here, stable fields '
    'live above.';
COMMENT ON COLUMN grammar_entries.discovered_via IS
    'How this entry entered the user''s bank. Used for "show me everything I '
    'banked from reading" filters.';

CREATE INDEX IF NOT EXISTS ix_grammar_entries_user_proficiency
    ON grammar_entries (user_id, proficiency)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_grammar_entries_user_proficiency IS
    'Filter pattern: "show me my L4 grammar entries". Partial — soft-deleted '
    'entries are excluded from all UI lists.';

CREATE INDEX IF NOT EXISTS ix_grammar_entries_notes_gin
    ON grammar_entries USING GIN (notes jsonb_path_ops);
COMMENT ON INDEX ix_grammar_entries_notes_gin IS
    'JSONB containment search over notes (e.g. find entries tagged in tips[]). '
    'jsonb_path_ops is smaller and faster than the default ops for @> queries.';

CREATE OR REPLACE TRIGGER trg_grammar_entries_updated_at
    BEFORE UPDATE ON grammar_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 10. SRS: vocab_cards (FSRS-native)
-- -----------------------------------------------------------------------------
-- One row per (user, face, target). The "target" is polymorphic: it can be a
-- vocab entry, a grammar entry, or a cloze on a source sentence. We model that
-- with a discriminator + mutually-exclusive FK columns and a CHECK that exactly
-- one is set. (Polymorphic FKs are awkward in any RDB; this is the cleanest of
-- the bad options. See ADR-003.)
--
-- The FK to sentences (source_sentence_id, vocab_entry_id, etc.) lives in the
-- corpus migration (002), which ALTER-adds it AFTER the corpus tables exist.
-- A1 declares the columns NOT NULL/NULL appropriately but does NOT declare the
-- FK; the constraint name is reserved for A2: fk_vocab_cards_source_sentence,
-- fk_vocab_cards_vocab_entry, fk_vocab_cards_topik_item.
-- See ADR-004.
CREATE TABLE IF NOT EXISTS vocab_cards (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    face            card_face   NOT NULL,

    -- Target discriminator + soft references. Exactly one of these is non-NULL.
    -- The actual FKs are added by migration 002 (corpus owner). A1 only declares
    -- the columns; the columns are explicitly nullable because of the XOR.
    vocab_entry_id      BIGINT,
    grammar_entry_id    BIGINT,
    source_sentence_id  BIGINT,
    topik_item_id       BIGINT,

    -- The cloze span (start, end) into source_sentence_id, when face = 'cloze'.
    cloze_start         INTEGER,
    cloze_end           INTEGER,

    -- FSRS state (https://github.com/open-spaced-repetition/fsrs4anki)
    -- Storing the canonical FSRS variables, not SM-2 fields. See ADR-003.
    fsrs_state          fsrs_state  NOT NULL DEFAULT 'new',
    -- Memory stability in days; NUMERIC because FSRS produces fractional days.
    stability           NUMERIC(10, 4) NOT NULL DEFAULT 0,
    -- Difficulty 1.0 – 10.0 (FSRS canonical range).
    difficulty          NUMERIC(4, 2) NOT NULL DEFAULT 5.0,
    -- Days since last review; -1 sentinel = never reviewed.
    elapsed_days        INTEGER     NOT NULL DEFAULT -1,
    scheduled_days      INTEGER     NOT NULL DEFAULT 0,
    reps                INTEGER     NOT NULL DEFAULT 0,
    lapses              INTEGER     NOT NULL DEFAULT 0,

    last_reviewed_at    TIMESTAMPTZ,
    due_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Tagging (mirrors corpus item tags so card-level filtering is fast).
    proficiency         proficiency_level NOT NULL DEFAULT 'L3',
    tags                TEXT[]      NOT NULL DEFAULT '{}',

    -- Suspension: card stays in DB but is excluded from queues.
    suspended_at        TIMESTAMPTZ,
    suspended_reason    TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT fk_vocab_cards_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- The grammar FK CAN be declared here — the table exists in this migration.
    -- F1 (REVIEW_A1): ON DELETE RESTRICT (not SET NULL). The XOR CHECK on
    -- the target columns below requires exactly one of the four target ids
    -- to be non-NULL; nulling grammar_entry_id on a hard delete would trip
    -- the CHECK and fail the parent DELETE with a confusing error.
    -- grammar_entries is soft-deleted (deleted_at) in normal use; hard
    -- deletes (admin purge) must explicitly cascade-soft-delete or hard-
    -- delete dependent cards first. Matches ADR-001 §D9 "RESTRICT for
    -- reference-data-like behavior".
    CONSTRAINT fk_vocab_cards_grammar_entry
        FOREIGN KEY (grammar_entry_id) REFERENCES grammar_entries(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,

    CONSTRAINT ck_vocab_cards_target_xor CHECK (
        (CASE WHEN vocab_entry_id     IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN grammar_entry_id   IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN source_sentence_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN topik_item_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    CONSTRAINT ck_vocab_cards_cloze_requires_sentence CHECK (
        (face <> 'cloze') OR (source_sentence_id IS NOT NULL AND cloze_start IS NOT NULL AND cloze_end IS NOT NULL)
    ),
    CONSTRAINT ck_vocab_cards_cloze_range CHECK (
        cloze_start IS NULL OR cloze_end IS NULL OR (cloze_start >= 0 AND cloze_end > cloze_start)
    ),
    CONSTRAINT ck_vocab_cards_stability_nonneg     CHECK (stability >= 0),
    CONSTRAINT ck_vocab_cards_difficulty_range     CHECK (difficulty BETWEEN 1.0 AND 10.0),
    CONSTRAINT ck_vocab_cards_elapsed_min          CHECK (elapsed_days >= -1),
    CONSTRAINT ck_vocab_cards_scheduled_nonneg     CHECK (scheduled_days >= 0),
    CONSTRAINT ck_vocab_cards_reps_nonneg          CHECK (reps >= 0),
    CONSTRAINT ck_vocab_cards_lapses_nonneg        CHECK (lapses >= 0),
    CONSTRAINT ck_vocab_cards_suspended_reason_when_suspended CHECK (
        (suspended_at IS NULL AND suspended_reason IS NULL)
        OR (suspended_at IS NOT NULL)
    )
);

COMMENT ON TABLE  vocab_cards IS
    'FSRS-native spaced-repetition cards. Polymorphic target (vocab / grammar / '
    'sentence cloze / topik item) — exactly one *_id is set per row. Corpus-side '
    'FKs (vocab_entry, source_sentence, topik_item) are added in migration 002 '
    'after the referenced tables exist. See ADR-003, ADR-004.';
COMMENT ON COLUMN vocab_cards.face IS
    'Which side of the card is prompted on review: recognition (KR→EN), '
    'production (EN→KR), or cloze (fill the blank in a source sentence).';
COMMENT ON COLUMN vocab_cards.vocab_entry_id IS
    'Soft reference to a corpus vocab entry. FK added by migration 002.';
COMMENT ON COLUMN vocab_cards.source_sentence_id IS
    'Soft reference to a corpus sentence (the "seen in" context). FK added by '
    'migration 002 with ON DELETE SET NULL (card persists if sentence is removed).';
COMMENT ON COLUMN vocab_cards.topik_item_id IS
    'Soft reference to a TOPIK item (for question-as-card review). FK added by '
    'migration 002.';
COMMENT ON COLUMN vocab_cards.stability IS
    'FSRS memory stability in days (NUMERIC because FSRS produces fractional values).';
COMMENT ON COLUMN vocab_cards.difficulty IS
    'FSRS difficulty score on the canonical 1.0–10.0 scale.';
COMMENT ON COLUMN vocab_cards.elapsed_days IS
    'Days since last review. -1 sentinel = never reviewed (first scheduling).';
COMMENT ON COLUMN vocab_cards.due_at IS
    'Next scheduled review timestamp. The review queue query is: '
    'WHERE due_at <= now() AND suspended_at IS NULL AND deleted_at IS NULL.';
COMMENT ON COLUMN vocab_cards.suspended_at IS
    'When set, the card is hidden from review queues. Lets the user pause a '
    'card without losing its FSRS state.';

-- Review-queue index — the hottest read path in the app.
CREATE INDEX IF NOT EXISTS ix_vocab_cards_due_queue
    ON vocab_cards (user_id, due_at)
    WHERE deleted_at IS NULL AND suspended_at IS NULL;
COMMENT ON INDEX ix_vocab_cards_due_queue IS
    'Hot path: review-queue scan. Partial on (deleted_at IS NULL AND suspended_at '
    'IS NULL) keeps the index small. Composite ordered by user then due_at.';

CREATE INDEX IF NOT EXISTS ix_vocab_cards_grammar_entry
    ON vocab_cards (grammar_entry_id)
    WHERE grammar_entry_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_cards_grammar_entry IS
    'Supports "list cards for grammar entry X" (grammar-entry detail page) '
    'and the orphan-check used before any hard DELETE on grammar_entries '
    '(FK is ON DELETE RESTRICT — see F1 in REVIEW_A1). Partial — most cards '
    'target other entity types.';

-- Tag-filtered review (e.g. "drill business-tagged cards").
CREATE INDEX IF NOT EXISTS ix_vocab_cards_tags_gin
    ON vocab_cards USING GIN (tags);
COMMENT ON INDEX ix_vocab_cards_tags_gin IS
    'GIN over tags[] for tag-filtered review queues (WHERE tags @> ARRAY[''business''])';

CREATE OR REPLACE TRIGGER trg_vocab_cards_updated_at
    BEFORE UPDATE ON vocab_cards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 11. SRS: card_reviews (immutable review log)
-- -----------------------------------------------------------------------------
-- One row per review event. NEVER updated — append-only. Lets FSRS re-tune
-- parameters retroactively from the full review history.
CREATE TABLE IF NOT EXISTS card_reviews (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id         BIGINT      NOT NULL,
    user_id         BIGINT      NOT NULL,

    rating          fsrs_rating NOT NULL,

    -- Snapshot of FSRS state BEFORE this review (for re-tuning).
    state_before        fsrs_state    NOT NULL,
    stability_before    NUMERIC(10, 4) NOT NULL,
    difficulty_before   NUMERIC(4, 2) NOT NULL,
    elapsed_days_before INTEGER       NOT NULL,

    -- Snapshot of FSRS state AFTER this review (computed by app).
    state_after         fsrs_state    NOT NULL,
    stability_after     NUMERIC(10, 4) NOT NULL,
    difficulty_after    NUMERIC(4, 2) NOT NULL,
    scheduled_days_after INTEGER      NOT NULL,

    -- How long the user spent on this review (ms). Used by FSRS for "time
    -- spent" heuristics and by the UI for "session pace" metrics.
    duration_ms     INTEGER,

    -- Append-only: only created_at — no updated_at, version, or soft delete.
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_card_reviews_card
        FOREIGN KEY (card_id) REFERENCES vocab_cards(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_card_reviews_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_card_reviews_stability_before_nonneg  CHECK (stability_before  >= 0),
    CONSTRAINT ck_card_reviews_stability_after_nonneg   CHECK (stability_after   >= 0),
    CONSTRAINT ck_card_reviews_difficulty_before_range  CHECK (difficulty_before BETWEEN 1.0 AND 10.0),
    CONSTRAINT ck_card_reviews_difficulty_after_range   CHECK (difficulty_after  BETWEEN 1.0 AND 10.0),
    CONSTRAINT ck_card_reviews_elapsed_before_min       CHECK (elapsed_days_before >= -1),
    CONSTRAINT ck_card_reviews_scheduled_after_nonneg   CHECK (scheduled_days_after >= 0),
    CONSTRAINT ck_card_reviews_duration_nonneg          CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

COMMENT ON TABLE  card_reviews IS
    'Append-only review log. One row per Again/Hard/Good/Easy press. Stores '
    'BEFORE and AFTER FSRS state so the algorithm can be re-tuned from history '
    'without losing fidelity. Never UPDATE — only INSERT.';
COMMENT ON COLUMN card_reviews.duration_ms IS
    'Milliseconds spent on this review. Nullable because some clients (e.g. CLI '
    'tools) may not measure it reliably.';

CREATE INDEX IF NOT EXISTS ix_card_reviews_card_time
    ON card_reviews (card_id, reviewed_at);
COMMENT ON INDEX ix_card_reviews_card_time IS
    'Chronological review history per card — feeds the card-detail "history" view '
    'and FSRS re-tuning runs.';

CREATE INDEX IF NOT EXISTS ix_card_reviews_user_time
    ON card_reviews (user_id, reviewed_at DESC);
COMMENT ON INDEX ix_card_reviews_user_time IS
    'Recent activity feed: "what did I review today / this week" — descending '
    'by time matches the typical query.';

-- No updated_at trigger — card_reviews is append-only by design.

-- End of 001_core_schema.up.sql — runner owns the transaction (ADR-013).
