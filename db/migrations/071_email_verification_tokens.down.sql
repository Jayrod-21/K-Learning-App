-- migrate: destructive
-- =============================================================================
-- Migration 071 — email_verification_tokens (DOWN)
--   Drops `email_verification_tokens` (its indexes drop implicitly with the
--   table). IF EXISTS so a partial/repeated rollback is a no-op. Reverse of
--   071_email_verification_tokens.up.sql.
--
--   DELIBERATELY NOT REVERSED: the up's grandfathering backfill of
--   users.email_verified_at. Once stamped, verified-ness cannot be safely
--   un-stamped — rows verified legitimately after the up ran are
--   indistinguishable from backfilled ones, and nulling them would destroy
--   real verification state (see the up header). The column itself belongs to
--   migration 001 and is untouched here.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS email_verification_tokens;

-- End of 071_email_verification_tokens.down.sql — runner owns the transaction (ADR-013).
