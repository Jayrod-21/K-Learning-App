-- migrate: non-destructive
-- =============================================================================
-- Migration 071 — email_verification_tokens (F-006, email verification)
--   UP — adds `email_verification_tokens`: the hashed-at-rest, expiring,
--        single-use tokens behind the signup email-verification flow, and
--        grandfathers every pre-existing account as verified (backfills
--        users.email_verified_at, which migration 001 created but nothing
--        wrote until now).
--   Reverse: 071_email_verification_tokens.down.sql
--   Depends on: 001_core_schema (users, users.email_verified_at).
--
-- DESIGN NOTES (mirrors 025_mfa_login_challenges — same token discipline)
--   * `token_hash` is the SHA-256 hex of the raw 32-byte (base64url) token.
--     The raw token exists ONLY inside the verification email (and transiently
--     in server memory while sending); it is NEVER stored or logged. A DB read
--     yields hashes, not clickable links.
--   * `email` is the address the link was MAILED TO — the address this token
--     attests. The consume path requires it to equal the user's CURRENT email,
--     so a live token issued for an OLD address can never stamp a NEW one
--     (e.g. after a PATCH /auth/me email change), even if its supersession
--     were somehow lost. citext to match users.email comparison semantics.
--   * Single-use: the verify endpoint consumes via an atomic
--     `UPDATE … SET consumed_at = now() WHERE id = $ AND consumed_at IS NULL`
--     rowCount gate — a racing double-click consumes at most once, and the
--     loser resolves to the friendly "already verified" success (idempotent).
--   * `invalidated_at` is the resend supersession marker: issuing a fresh
--     token stamps every prior live token for that user instead of deleting
--     it, so the audit trail of issued tokens survives (when it was issued,
--     when it was superseded) — same audit stance as user_recovery_codes
--     keeping used codes.
--   * `expires_at` bounds the window (config EMAIL_VERIFICATION_TOKEN_TTL_HOURS,
--     default 24 h). The consume path checks consumed_at / invalidated_at /
--     expiry server-side, so an expired, superseded, or spent token can never
--     redeem (it is looked up regardless, to distinguish the outcomes).
--   * A verification token confers NO session powers — consuming it only sets
--     users.email_verified_at. Login still requires the password (and MFA).
--   * Hard delete via the user FK CASCADE: tokens are transient.
--
-- WHY THE BACKFILL (grandfathering, one-way)
--   users.email_verified_at has existed since 001 but was never written, so
--   every pre-F-006 row is NULL. Those accounts were operator-provisioned
--   (self-signup is closed in production), and the login gate this feature
--   ships (EMAIL_VERIFICATION_REQUIRED, default ON) would lock ALL of them out
--   at their next login. Backfilling `email_verified_at = created_at` for the
--   NULL rows treats provisioning as the verification event, which is the
--   truthful reading for this deployment. The DOWN deliberately does NOT
--   reverse this: un-stamping rows would also un-verify accounts that verify
--   legitimately after this migration runs (indistinguishable once stamped
--   equal to created_at is not guaranteed), and destroying verification state
--   is exactly the kind of data loss a down must not smuggle in. The UPDATE
--   only fills NULLs — no existing value is modified — hence the
--   non-destructive classification.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT       NOT NULL,
    email          CITEXT       NOT NULL,       -- the address this token attests (mailed to)
    token_hash     TEXT         NOT NULL,       -- SHA-256 hex of raw token
    expires_at     TIMESTAMPTZ  NOT NULL,
    consumed_at    TIMESTAMPTZ,                 -- single-use: set on successful verify
    invalidated_at TIMESTAMPTZ,                 -- set when a resend supersedes this token
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_email_verif_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_email_verif_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_email_verif_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_email_verif_email_length CHECK (length(email) BETWEEN 3 AND 254),
    CONSTRAINT ck_email_verif_expiry CHECK (expires_at > created_at)
);

COMMENT ON TABLE  email_verification_tokens IS
    'Hashed-at-rest, expiring, single-use email-verification tokens (F-006). '
    'Consuming one sets users.email_verified_at; it confers NO session powers. '
    'consumed_at is set via an atomic rowCount-gated UPDATE (idempotent verify); '
    'invalidated_at marks supersession by a resend. See server SECURITY.md §19.';
COMMENT ON COLUMN email_verification_tokens.email IS
    'The address the verification link was mailed to — the address this token '
    'attests. Consume requires it to equal users.email at redemption time, so '
    'a token issued for an old address can never verify a changed one.';
COMMENT ON COLUMN email_verification_tokens.token_hash IS
    'SHA-256 hex of the raw 32-byte (base64url) token. The raw token exists '
    'only in the verification email and is NEVER stored or logged here.';
COMMENT ON COLUMN email_verification_tokens.consumed_at IS
    'Single-use marker. Set via the atomic gate UPDATE … WHERE consumed_at IS '
    'NULL so a racing double-click consumes at most once.';
COMMENT ON COLUMN email_verification_tokens.invalidated_at IS
    'Resend supersession marker: a fresh token stamps prior live tokens here '
    'instead of deleting them, preserving the issuance audit trail.';

-- NOTE: no partial "active-only" index on token_hash. The consume path
-- deliberately looks up by hash WITHOUT live-ness predicates (it must see
-- consumed/superseded rows to distinguish outcomes), so a partial index would
-- never be chosen by the planner; the uq_email_verif_token_hash UNIQUE index
-- above already serves the hash lookup. (An earlier draft carried an unusable
-- ix_email_verif_active_lookup, removed by the F-006 fix-pass.)

-- Resend path: invalidate a user''s prior live tokens + the per-user
-- issuance-cooldown probe (max(created_at) for the user).
CREATE INDEX IF NOT EXISTS ix_email_verif_user
    ON email_verification_tokens (user_id, created_at DESC);
COMMENT ON INDEX ix_email_verif_user IS
    'Resend path: supersede prior live tokens and probe the per-user issuance '
    'cooldown (latest created_at per user).';

-- Scheduled purge of expired tokens: DELETE … WHERE expires_at < now().
CREATE INDEX IF NOT EXISTS ix_email_verif_expires
    ON email_verification_tokens (expires_at);
COMMENT ON INDEX ix_email_verif_expires IS
    'Used by the periodic cleanup job: DELETE … WHERE expires_at < now().';

-- Grandfather pre-existing accounts (see header). Fills NULLs only; never
-- modifies an existing value — idempotent and non-destructive by construction.
UPDATE users
   SET email_verified_at = created_at
 WHERE email_verified_at IS NULL;

-- End of 071_email_verification_tokens.up.sql — runner owns the transaction (ADR-013).
