-- =============================================================================
-- Migration 025 — mfa_login_challenges (Pass Login, two-step login, D2)
--   UP — adds `mfa_login_challenges`: the short-lived, single-use, DB-backed
--        pending tokens that bridge the two login steps. Step 1 (password)
--        issues a challenge; step 2 (TOTP code or enrollment-confirm) consumes
--        it and issues the real session. The challenge is the bearer of step-1
--        success; the password is NOT re-checked at step 2.
--   Reverse: 025_mfa_login_challenges.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES (PASS_LOGIN_CONTRACT PART A / D2)
--   * `token_hash` is the SHA-256 hex of the raw 32-byte (base64url) pending
--     token — same opaque-token, hashed-at-rest pattern as sessions.token_hash.
--     The raw token is returned to the client once (in the login response body,
--     held in memory only) and NEVER stored. A DB read yields hashes, not usable
--     challenge tokens.
--   * `purpose` scopes the challenge ('totp' for a confirmed-factor login,
--     'enroll' for a forced first-time enrollment). A challenge minted for one
--     purpose can NEVER be consumed by the other endpoint (the lookup predicates
--     on purpose), so an enrollment challenge confers no power to bypass the
--     code step and vice-versa.
--   * Single-use: success sets `consumed_at` via an atomic
--     `UPDATE … SET consumed_at = now() WHERE id = $ AND consumed_at IS NULL`
--     rowCount gate (mirrors the sessions revoke pattern) — a racing double
--     submit consumes at most once, so no double session issue.
--   * `expires_at` bounds the window (default 5 min). The active-lookup predicate
--     requires consumed_at IS NULL AND expires_at > now(), so an expired or
--     consumed token is simply not found → rejected. A challenge confers NO
--     session powers — it can ONLY advance its own one step.
--   * `attempts` is a per-challenge bad-code counter (defense-in-depth alongside
--     the per-account lockout); bumped on each failed verify.
--   * Hard delete via the user FK CASCADE: challenges are transient.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS mfa_login_challenges (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    token_hash  TEXT         NOT NULL,                  -- SHA-256 hex of raw pending token
    purpose     TEXT         NOT NULL,                  -- 'totp' | 'enroll'
    expires_at  TIMESTAMPTZ  NOT NULL,
    consumed_at TIMESTAMPTZ,                            -- single-use: set on success
    attempts    INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_mfa_chal_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_mfa_chal_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_mfa_chal_purpose CHECK (purpose IN ('totp','enroll')),
    CONSTRAINT ck_mfa_chal_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_mfa_chal_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_mfa_chal_attempts_nonneg CHECK (attempts >= 0)
);

COMMENT ON TABLE  mfa_login_challenges IS
    'Short-lived, single-use, hashed-at-rest pending tokens bridging the two '
    'login steps (D2). purpose-scoped (totp|enroll); consumed_at set atomically '
    'on success. Confers NO session powers — only advances its own one step. '
    'See PASS_LOGIN_CONTRACT PART A / server SECURITY.md §18.';
COMMENT ON COLUMN mfa_login_challenges.token_hash IS
    'SHA-256 hex of the raw 32-byte (base64url) pending token. The raw token is '
    'returned to the client once (memory only) and NEVER stored here.';
COMMENT ON COLUMN mfa_login_challenges.purpose IS
    'Scope of the challenge: ''totp'' (confirmed-factor login) or ''enroll'' '
    '(forced first-time enrollment). A challenge can only be consumed by the '
    'endpoint matching its purpose.';
COMMENT ON COLUMN mfa_login_challenges.consumed_at IS
    'Single-use marker. Set via the atomic gate UPDATE … WHERE consumed_at IS '
    'NULL so a racing double-submit consumes at most once.';

-- Active-lookup: validate a presented token. Partial on consumed_at IS NULL so
-- the index stays compact as consumed/expired challenges accumulate before purge.
CREATE INDEX IF NOT EXISTS ix_mfa_chal_active_lookup
    ON mfa_login_challenges (token_hash) WHERE consumed_at IS NULL;
COMMENT ON INDEX ix_mfa_chal_active_lookup IS
    'Hot path: validate a presented pending token by hash, only if not yet '
    'consumed. Partial on consumed_at IS NULL.';

-- Scheduled purge of expired challenges: DELETE … WHERE expires_at < now().
CREATE INDEX IF NOT EXISTS ix_mfa_chal_expires
    ON mfa_login_challenges (expires_at);
COMMENT ON INDEX ix_mfa_chal_expires IS
    'Used by the periodic cleanup job: DELETE … WHERE expires_at < now().';

-- End of 025_mfa_login_challenges.up.sql — runner owns the transaction (ADR-013).
