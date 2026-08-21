-- 087 (down): restore the narrow (vocab/grammar/reading/listening)
-- diagnostic_responses.section CHECK.
--
-- source_kind is untouched here too — 087's up never widened it (hanja
-- reuses 'generated'; see the up.sql header). There is nothing to roll back
-- on that constraint.
--
-- migrate: destructive
--
-- HONEST GATE — NO SILENT DATA LOSS: this is a pure CHECK narrow, not a data
-- migration. It does not DELETE or touch a single row. If any
-- diagnostic_responses row already carries section = 'hanja' (written after
-- 087 shipped — every hanja item a live run served), re-adding the narrower
-- CHECK below FAILS with a Postgres CheckViolation — exactly like 056's
-- writing_attempts.rubric rollback: rolling back a widen while the widened
-- value is IN USE is a data-shape conflict the operator must resolve
-- deliberately (delete or retag the hanja rows — likely via CASCADE from the
-- owning diagnostic_runs, since a response has no independent audit value
-- per 014's own design note) before the rollback can succeed. This is
-- deliberate — a silent DELETE of live diagnostic history would be a worse
-- outcome than a loud, blocked rollback.
--
-- Declared `-- migrate: destructive` (not sniffed) precisely BECAUSE of that
-- possible CheckViolation-on-live-data outcome, even though the SQL itself
-- contains no DROP TABLE / mass DELETE / TRUNCATE migrate.py's
-- DESTRUCTIVE_PATTERNS would catch — mirrors 056's down posture exactly.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping DELETE.

ALTER TABLE diagnostic_responses
    DROP CONSTRAINT IF EXISTS ck_diagnostic_responses_section;
ALTER TABLE diagnostic_responses
    ADD CONSTRAINT ck_diagnostic_responses_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening'));

COMMENT ON COLUMN diagnostic_responses.section IS
    'Diagnostic dimension this item exercises: vocab/grammar/reading/listening '
    '(087 rolled back; hanja requires 087 to be re-applied). A superset of the '
    'corpus section enum, hence TEXT + CHECK, not an enum (see 014).';

-- End of 087_diagnostic_hanja_section.down.sql — runner owns the transaction (ADR-013).
