-- migrate: non-destructive
-- =============================================================================
-- Migration 097 — invite_codes + invite_redemptions (Phase 2.3, invite-only
-- self-signup, D1)
--   UP — adds `invite_codes`: the hashed-at-rest, admin-issued, single- or
--        multi-use codes that gate self-service registration when
--        INVITE_REQUIRED is on (server/src/config/index.ts); and
--        `invite_redemptions`: an append-only audit of which user redeemed
--        which code.
--   Reverse: 097_invite_codes.down.sql
--   Depends on: 001_core_schema (users), 095_user_role (admin issuance).
--
-- DESIGN NOTES (mirrors 094_password_reset_tokens — same hashed-token
-- discipline, adapted for a credential an ADMIN mints rather than the system)
--   * `code_hash` is the SHA-256 hex of the raw 32-byte (base64url) code. The
--     raw code exists ONLY inside the issuance response (server/src/routes/
--     admin.ts POST /admin/invites) — shown to the issuing admin ONCE — and is
--     NEVER stored or logged. A DB read yields hashes, not usable codes.
--   * Unlike password_reset_tokens (attests a USER) or email_verification_
--     tokens (attests an ADDRESS, single redeemable link), an invite code
--     attests PERMISSION TO REGISTER and may be reusable: `max_uses` /
--     `uses` (default 1-of-1, the common case) let an admin mint a
--     multi-redemption code (e.g. a cohort invite) without minting N rows.
--     The `uses <= max_uses` CHECK keeps the counter itself from ever
--     overshooting its own ceiling, independent of the atomic consume UPDATE
--     in server/src/auth/inviteCodes.ts that increments it.
--   * `email` (CITEXT, nullable) optionally binds a code to one address —
--     redemption then requires the registering email to match, case-
--     insensitively (mirrors users.email's citext comparison). NULL = any
--     email may redeem, subject to every other gate.
--   * `expires_at` (nullable, NULL = never expires) — unlike the token tables'
--     mandatory expiry, an invite code's whole purpose is admin-controlled
--     issuance, and an operator may deliberately mint a standing code with no
--     deadline (e.g. a permanent staff-onboarding code). When set, it must be
--     strictly after `created_at` (a code can never be born expired — same
--     shape as ck_password_reset_expiry).
--   * `revoked_at` (nullable) — an admin's explicit kill switch
--     (POST /admin/invites/:id/revoke), independent of expiry/exhaustion.
--     Idempotent by construction (the revoke UPDATE gates on
--     `revoked_at IS NULL`); once set it is permanent (no "un-revoke" —
--     mint a fresh code instead, same posture as a superseded token).
--   * Consuming is ATOMIC WITH THE users INSERT (server/src/routes/auth.ts
--     register handler): both run in ONE transaction via `consumeInviteCode`
--     (server/src/auth/inviteCodes.ts), so a duplicate-email 23505 on the
--     users INSERT rolls back the `uses` increment too — a failed
--     registration attempt never burns a single-use code. See
--     server/src/auth/inviteCodes.ts's own header for the full contract.
--   * `issued_by_user_id` REFERENCES users(id) ON DELETE RESTRICT — the
--     admin who minted the code. RESTRICT (not CASCADE/SET NULL) preserves
--     the issuance audit trail: admins are seeded operator accounts, not
--     user-deletable rows, so a delete attempt against an admin with
--     outstanding issued codes is a deliberate, loud failure rather than a
--     silent orphan.
--   * `note` (nullable, <=500 chars) is the issuing admin's own human label
--     (e.g. "for Jane's cohort") — free text, never interpreted, never
--     shown to the registering user.
--
-- invite_redemptions — append-only audit of which user redeemed which code.
--   * Written by the SAME transaction as the users INSERT + the invite_codes
--     `uses` increment, immediately after the user row exists (so
--     `user_id` can reference it). `UNIQUE (invite_code_id, user_id)` is
--     belt-and-braces — a user can only ever be created once (users.email is
--     itself UNIQUE), so this pairing can never naturally repeat, but the
--     constraint documents the invariant and costs nothing.
--   * ON DELETE CASCADE both ways: a redemption record has no independent
--     meaning once either side (the code or the user) is gone.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS invite_codes (
    id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_hash         TEXT         NOT NULL,       -- SHA-256 hex of raw code
    issued_by_user_id BIGINT       NOT NULL,        -- the issuing admin
    email             CITEXT,                       -- optional email binding
    expires_at        TIMESTAMPTZ,                  -- NULL = never expires
    max_uses          INT          NOT NULL DEFAULT 1,
    uses              INT          NOT NULL DEFAULT 0,
    revoked_at        TIMESTAMPTZ,                   -- admin kill switch
    note              TEXT,                          -- admin's human label
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_invite_codes_issued_by FOREIGN KEY (issued_by_user_id)
        REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT uq_invite_codes_code_hash UNIQUE (code_hash),
    CONSTRAINT ck_invite_codes_code_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_invite_codes_expiry CHECK (expires_at IS NULL OR expires_at > created_at),
    CONSTRAINT ck_invite_codes_max_uses CHECK (max_uses >= 1),
    CONSTRAINT ck_invite_codes_uses CHECK (uses >= 0 AND uses <= max_uses),
    CONSTRAINT ck_invite_codes_note_length CHECK (note IS NULL OR char_length(note) <= 500)
);

COMMENT ON TABLE  invite_codes IS
    'Hashed-at-rest, admin-issued invite codes gating self-service '
    'registration when INVITE_REQUIRED is on (Phase 2.3, D1). uses/max_uses '
    'bound how many times a code may be redeemed (default 1-of-1); consuming '
    'is an atomic rowCount-gated UPDATE run in the SAME transaction as the '
    'users INSERT (server/src/auth/inviteCodes.ts, server/src/routes/auth.ts) '
    'so a failed (e.g. duplicate-email) registration never burns a code. See '
    'server SECURITY.md.';
COMMENT ON COLUMN invite_codes.code_hash IS
    'SHA-256 hex of the raw 32-byte (base64url) code. The raw code exists '
    'only in the admin issuance response (shown ONCE) and is NEVER stored '
    'or logged here.';
COMMENT ON COLUMN invite_codes.issued_by_user_id IS
    'The admin who minted this code. ON DELETE RESTRICT preserves the '
    'issuance audit trail — admins are seeded operator accounts, not '
    'user-deletable rows.';
COMMENT ON COLUMN invite_codes.email IS
    'Optional email binding: when set, redemption requires the registering '
    'email to match case-insensitively (citext). NULL = any email may '
    'redeem, subject to every other gate (revoked/expired/exhausted).';
COMMENT ON COLUMN invite_codes.uses IS
    'Atomic single-use-or-multi-use consume counter, incremented by '
    'server/src/auth/inviteCodes.ts consumeInviteCode''s rowCount-gated '
    'UPDATE ... WHERE uses < max_uses. Bounded by ck_invite_codes_uses so '
    'the counter itself can never exceed max_uses regardless of caller.';
COMMENT ON COLUMN invite_codes.revoked_at IS
    'Admin kill switch (POST /admin/invites/:id/revoke). Idempotent (the '
    'revoke UPDATE gates on revoked_at IS NULL) and permanent — there is no '
    'un-revoke; mint a fresh code instead.';

-- Admin list (GET /admin/invites), newest-first. The hash lookup at redeem
-- time rides the UNIQUE index on code_hash instead.
CREATE INDEX IF NOT EXISTS ix_invite_codes_created_at
    ON invite_codes (created_at DESC);
COMMENT ON INDEX ix_invite_codes_created_at IS
    'Admin listing order (GET /admin/invites): newest-issued first.';

CREATE TABLE IF NOT EXISTS invite_redemptions (
    id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invite_code_id BIGINT       NOT NULL,
    user_id        BIGINT       NOT NULL,
    redeemed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_invite_redemptions_code FOREIGN KEY (invite_code_id)
        REFERENCES invite_codes(id) ON DELETE CASCADE,
    CONSTRAINT fk_invite_redemptions_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT uq_invite_redemptions_code_user UNIQUE (invite_code_id, user_id)
);

COMMENT ON TABLE invite_redemptions IS
    'Append-only audit: which user redeemed which invite code, and when. '
    'Written in the SAME transaction as the users INSERT and the '
    'invite_codes.uses increment (server/src/routes/auth.ts register '
    'handler), immediately after the user row exists.';

-- Reverse lookup: "who has redeemed this code" (admin detail view / support).
CREATE INDEX IF NOT EXISTS ix_invite_redemptions_code
    ON invite_redemptions (invite_code_id);
COMMENT ON INDEX ix_invite_redemptions_code IS
    'Reverse lookup: every redemption of a given invite code.';

-- End of 097_invite_codes.up.sql — runner owns the transaction (ADR-013).
