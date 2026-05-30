-- =============================================================================
-- Migration 011 — User profile fields (Pass 3, Settings → Profile group)
--   UP — adds optional `phone` column to `users` so the Pass 3 Settings
--        Profile group (display name + email + phone) has a stable home for
--        the third field. `display_name` already exists (migration 001);
--        `email` already exists (migration 001); only `phone` is new.
--   Reverse: 011_user_profile_fields.down.sql
--   Depends on: 001_core_schema (provides the `users` table + version trigger).
--
-- DESIGN NOTES
--   * Phone is OPTIONAL. The Settings UI lets the user leave it blank. The
--     column is nullable accordingly (ADR-001 §1: "Nullable is an explicit
--     choice, justified in a COMMENT" — comment below).
--   * Phone is a contact field, not an identifier. We do NOT make it UNIQUE
--     (multiple users can share a household line; verification belongs in a
--     later flow gated by SMS, deferred per Repository/client/SECURITY.md
--     "Deferred" — same posture as email verification).
--   * Shape rule: stored as a normalized E.164-ish string. The CHECK below
--     constrains length (≤32) and the alphabet (leading `+`, digits, spaces,
--     dashes, parens — keep it generous; reject control chars). Strict E.164
--     parsing is the app layer's job; the DB only refuses garbage.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write. `psql -1` does the same
--   when running manually.
-- =============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone TEXT;

-- Add the CHECK only if it isn't already present (idempotency on re-apply).
-- DO block because Postgres pre-17 doesn't support `ADD CONSTRAINT IF NOT EXISTS`.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'users'::regclass
           AND conname  = 'ck_users_phone_shape'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT ck_users_phone_shape
            CHECK (
                phone IS NULL
                OR (
                    length(phone) BETWEEN 7 AND 32
                    AND phone ~ '^[+0-9 ()-]+$'
                )
            );
    END IF;
END$$;

COMMENT ON COLUMN users.phone IS
    'Optional contact phone in E.164-ish form (leading +, digits, spaces, '
    'dashes, parens). Not an identifier; NOT UNIQUE. Verification is deferred '
    'to a later SMS flow per Repository/client/SECURITY.md "Deferred". '
    'Constraint ck_users_phone_shape enforces shape; strict E.164 parsing '
    'happens at the app layer (zod regex on PATCH /auth/me).';

-- End of 011_user_profile_fields.up.sql — runner owns the transaction (ADR-013).
