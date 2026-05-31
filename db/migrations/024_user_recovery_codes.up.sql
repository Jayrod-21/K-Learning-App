-- =============================================================================
-- Migration 024 — user_recovery_codes (Pass Login, TOTP 2FA)
--   UP — adds `user_recovery_codes`: single-use hashed backup codes for the
--        "lost authenticator but still have my codes" recovery path. One row per
--        issued code; `used_at IS NULL` = still spendable. A fresh set is issued
--        at enrollment-confirm and on explicit regenerate (which deletes the
--        prior unused codes first).
--   Reverse: 024_user_recovery_codes.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES (PASS_LOGIN_CONTRACT PART A)
--   * `code_hash` is the SHA-256 hex of the NORMALIZED plaintext code (uppercase,
--     dashes/space stripped). Recovery codes are high-entropy (>=50 bits,
--     Crockford-base32) so a plain SHA-256 store is sufficient — they are NOT
--     low-entropy passwords, so Argon2 would add login latency for no security
--     gain. Lookup-by-hash is O(1) (the UNIQUE index backs the equality probe),
--     and equality on the hash is the constant-time-enough secret comparison.
--   * Single-use is enforced at spend time by an atomic
--     `UPDATE … SET used_at = now() WHERE id = $ AND used_at IS NULL` rowCount
--     gate — a racing double-submit can mark a code used at most once.
--   * `uq_user_recovery_code_hash` is global UNIQUE (not per-user): code_hash is
--     a 256-bit digest of a high-entropy code, so a cross-user collision is a
--     cryptographic non-event; global uniqueness also makes the spend lookup a
--     single index probe without a user_id predicate (the route still scopes the
--     spend to the challenge's user defensively).
--   * `ck_…_code_hash_shape` pins the column to exactly 64 lowercase hex chars so
--     a bug that tried to store a raw/plaintext code fails at the write.
--   * Hard delete via the user FK CASCADE: recovery codes are transient secrets,
--     not durable audit history — deleting the user purges them outright.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    code_hash   TEXT         NOT NULL,                  -- SHA-256 hex of normalized code
    used_at     TIMESTAMPTZ,                            -- NULL = unused
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_user_recovery_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_user_recovery_code_hash UNIQUE (code_hash),
    CONSTRAINT ck_user_recovery_code_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE  user_recovery_codes IS
    'Single-use hashed backup codes for TOTP recovery. One row per issued code; '
    'used_at NULL = spendable. SHA-256 hex of the normalized code is stored — '
    'never the plaintext. See PASS_LOGIN_CONTRACT PART A / server SECURITY.md §18.';
COMMENT ON COLUMN user_recovery_codes.code_hash IS
    'SHA-256 hex (64 lowercase chars) of the normalized recovery code (uppercase, '
    'dashes/space stripped). High-entropy code → SHA-256 store is sufficient (not '
    'a password; Argon2 unnecessary). NEVER store the plaintext.';
COMMENT ON COLUMN user_recovery_codes.used_at IS
    'When the code was spent. NULL = unused. Spend is the atomic gate '
    'UPDATE … SET used_at = now() WHERE id = $ AND used_at IS NULL (single-use).';

-- Spend / count lookup: "this user''s unused codes". Partial on used_at IS NULL
-- keeps the index compact as spent codes accumulate and matches the count query
-- (recovery_codes_remaining) and the delete-then-reissue regenerate path.
CREATE INDEX IF NOT EXISTS ix_user_recovery_active
    ON user_recovery_codes (user_id) WHERE used_at IS NULL;
COMMENT ON INDEX ix_user_recovery_active IS
    'Supports "this user''s unused recovery codes" — the remaining-count read and '
    'the regenerate delete. Partial on used_at IS NULL stays compact over time.';

-- End of 024_user_recovery_codes.up.sql — runner owns the transaction (ADR-013).
