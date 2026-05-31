-- =============================================================================
-- Migration 023 — user_totp (Pass Login, TOTP 2FA)
--   UP — adds `user_totp`: the single TOTP authenticator factor per user
--        (1:1 with users). Stores the AES-256-GCM-encrypted base32 secret, the
--        replay-guard high-water-mark time-step, and the per-account lockout
--        counters that bound code brute-force (the IP authLimiter is the other
--        half of that defense). Re-enroll UPSERTs this row, resetting
--        confirmed_at to NULL until the new secret is confirmed.
--   Reverse: 023_user_totp.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES (PASS_LOGIN_CONTRACT PART A)
--   * `secret_encrypted` is AES-256-GCM over the base32 TOTP secret, stored as a
--     single base64(iv ‖ authTag ‖ ciphertext) string. The encryption key lives
--     in the env (`TOTP_SECRET_ENC_KEY`), NEVER in this column or the DB — a DB
--     read alone does not yield a usable factor secret (mirrors the SHA-256-at-
--     rest posture of sessions.token_hash).
--   * `confirmed_at IS NULL` is the canonical "pending enrollment" predicate: a
--     freshly-generated secret is unconfirmed until the enrolling user proves
--     possession by entering a live code. An unconfirmed row's secret is the
--     pending-enrollment secret; a confirmed row's secret is the live factor.
--   * `last_used_step` is the monotonic replay guard: every accepted TOTP code
--     advances it, and a code whose matched time-step is <= last_used_step is
--     rejected even if otplib would otherwise accept it within the skew window.
--     This closes the "replay the same code twice inside its 90s validity"
--     window that a stateless verify leaves open.
--   * `failed_attempts` / `locked_until` are the per-account lockout (B-LOCK):
--     TOTP_MAX_FAILED_ATTEMPTS consecutive bad codes set locked_until, and the
--     code-verify route 423s until it elapses. Reset to 0 / NULL on any success.
--   * One factor per user → user_id IS the PK (1:1, not a 1:N child table).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_totp (
    user_id          BIGINT       PRIMARY KEY,           -- 1:1 with users
    secret_encrypted TEXT         NOT NULL,              -- AES-256-GCM, base64(iv|tag|ct)
    confirmed_at     TIMESTAMPTZ,                        -- NULL = enrolled-not-yet-confirmed (pending secret)
    last_used_step   BIGINT,                             -- replay guard: highest accepted TOTP time-step
    failed_attempts  INTEGER      NOT NULL DEFAULT 0,    -- account-level lockout counter
    locked_until     TIMESTAMPTZ,                        -- NULL = not locked
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version          INTEGER      NOT NULL DEFAULT 1,
    CONSTRAINT fk_user_totp_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_user_totp_failed_nonneg CHECK (failed_attempts >= 0),
    CONSTRAINT ck_user_totp_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE  user_totp IS
    'One TOTP authenticator factor per user (1:1). Secret is AES-256-GCM '
    'encrypted at rest under TOTP_SECRET_ENC_KEY (env, not DB). confirmed_at '
    'NULL = pending enrollment; non-NULL = live factor. See PASS_LOGIN_CONTRACT '
    'PART A / server SECURITY.md §18.';
COMMENT ON COLUMN user_totp.secret_encrypted IS
    'AES-256-GCM ciphertext of the base32 TOTP secret, encoded base64(iv|tag|ct). '
    'NEVER log or ship this. The decryption key is env-only (TOTP_SECRET_ENC_KEY) '
    'so a DB read alone does not yield a usable factor secret.';
COMMENT ON COLUMN user_totp.confirmed_at IS
    'Timestamp the enrolling user proved possession with a live code. NULL = the '
    'secret is a pending enrollment secret (not yet a live factor).';
COMMENT ON COLUMN user_totp.last_used_step IS
    'Monotonic replay guard: the highest TOTP time-step ever accepted. A code '
    'whose matched step is <= this value is rejected (prevents same-code replay '
    'inside the skew window). NULL until the first accepted code.';
COMMENT ON COLUMN user_totp.failed_attempts IS
    'Consecutive failed code-verify count. Resets to 0 on any success. Drives the '
    'per-account lockout alongside locked_until.';
COMMENT ON COLUMN user_totp.locked_until IS
    'When set and in the future, code verification is rejected with 423 until it '
    'elapses (B-LOCK). NULL = not locked. Cleared on success.';

CREATE OR REPLACE TRIGGER trg_user_totp_updated_at
    BEFORE UPDATE ON user_totp FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 023_user_totp.up.sql — runner owns the transaction (ADR-013).
