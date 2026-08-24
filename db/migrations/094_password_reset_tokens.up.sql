-- migrate: non-destructive
-- =============================================================================
-- Migration 094 — password_reset_tokens (Phase 2.1, self-service account
-- recovery)
--   UP — adds `password_reset_tokens`: the hashed-at-rest, expiring,
--        single-use tokens behind the "forgot password" flow.
--   Reverse: 094_password_reset_tokens.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES (mirrors 071_email_verification_tokens — same token discipline)
--   * `token_hash` is the SHA-256 hex of the raw 32-byte (base64url) token.
--     The raw token exists ONLY inside the reset email (and transiently in
--     server memory while sending); it is NEVER stored or logged. A DB read
--     yields hashes, not clickable links.
--   * Unlike email_verification_tokens, there is deliberately NO `email`
--     column here. An email-verification token attests an ADDRESS (the link
--     was mailed to a specific address that must still be current at
--     consume-time); a password-reset token attests a USER — whoever holds
--     the raw token proves control of that user's inbox AT ISSUANCE, and the
--     consume path only ever needs `user_id` to know whose password_hash to
--     overwrite. Binding it to an address the account may no longer have
--     would be meaningless (there is nothing to compare it against — a
--     password reset doesn't touch users.email).
--   * Single-use: the confirm endpoint consumes via an atomic
--     `UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND
--     consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`
--     rowCount gate — a racing double-submit consumes at most once.
--   * `invalidated_at` is the resend/re-request supersession marker: issuing
--     a fresh token stamps every prior live token for that user instead of
--     deleting it, so the audit trail of issued tokens survives — same
--     stance as email_verification_tokens.
--   * `expires_at` bounds the window at ONE HOUR (see
--     server/src/auth/passwordReset.ts) — deliberately shorter than the 24h
--     email-verification window: a password-reset link is a much higher-
--     value credential (it grants a full account takeover, not just an
--     attestation), so its blast radius if intercepted (shared inbox, a
--     stale tab, a forwarded email) is bounded tighter.
--   * Consuming a token confers NO session powers by itself — the confirm
--     handler sets users.password_hash AND revokes every existing session in
--     the SAME transaction (a reset is a security event: any session that
--     might have been established by whoever locked the legitimate user out
--     must die, and the user proves the new password by signing in fresh).
--   * Hard delete via the user FK CASCADE: tokens are transient.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT       NOT NULL,
    token_hash     TEXT         NOT NULL,       -- SHA-256 hex of raw token
    expires_at     TIMESTAMPTZ  NOT NULL,
    consumed_at    TIMESTAMPTZ,                 -- single-use: set on successful confirm
    invalidated_at TIMESTAMPTZ,                 -- set when a fresh request supersedes this token
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_password_reset_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_password_reset_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_password_reset_expiry CHECK (expires_at > created_at)
);

COMMENT ON TABLE  password_reset_tokens IS
    'Hashed-at-rest, expiring, single-use password-reset tokens (Phase 2.1 '
    'account recovery). Consuming one lets the confirm handler overwrite '
    'users.password_hash and revokes every live session for the user in the '
    'SAME transaction. consumed_at is set via an atomic rowCount-gated '
    'UPDATE; invalidated_at marks supersession by a fresh request. See server '
    'SECURITY.md.';
COMMENT ON COLUMN password_reset_tokens.token_hash IS
    'SHA-256 hex of the raw 32-byte (base64url) token. The raw token exists '
    'only in the reset email (URL fragment) and is NEVER stored or logged here.';
COMMENT ON COLUMN password_reset_tokens.consumed_at IS
    'Single-use marker. Set via the atomic gate UPDATE … WHERE consumed_at IS '
    'NULL AND invalidated_at IS NULL AND expires_at > now() so a racing '
    'double-submit consumes at most once.';
COMMENT ON COLUMN password_reset_tokens.invalidated_at IS
    'Supersession marker: a fresh reset request stamps prior live tokens '
    'here instead of deleting them, preserving the issuance audit trail.';

-- Supersede lookups (a fresh request invalidates prior live tokens for the
-- user) + the per-user issuance-cooldown probe (max(created_at) for the user).
CREATE INDEX IF NOT EXISTS ix_password_reset_user
    ON password_reset_tokens (user_id, created_at DESC);
COMMENT ON INDEX ix_password_reset_user IS
    'Request path: supersede prior live tokens and probe the per-user issuance '
    'cooldown (latest created_at per user).';

-- Scheduled purge of expired tokens: DELETE … WHERE expires_at < now().
CREATE INDEX IF NOT EXISTS ix_password_reset_expires
    ON password_reset_tokens (expires_at);
COMMENT ON INDEX ix_password_reset_expires IS
    'Used by the periodic cleanup job: DELETE … WHERE expires_at < now().';

-- End of 094_password_reset_tokens.up.sql — runner owns the transaction (ADR-013).
