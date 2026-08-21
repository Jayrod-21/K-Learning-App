-- 088 (down): restore the 5-value (vocab/grammar/reading/listening/hanja)
-- diagnostic_responses.section CHECK.
--
-- source_kind is untouched here too — 088's up never widened it (writing
-- reuses 'generated'; see the up.sql header). There is nothing to roll back
-- on that constraint.
--
-- migrate: destructive
--
-- HONEST GATE — NO SILENT DATA LOSS: this is a pure CHECK narrow, not a data
-- migration. It does not DELETE or touch a single row. If any
-- diagnostic_responses row already carries section = 'writing' (written after
-- 088 shipped — every writing item a live run served), re-adding the
-- narrower CHECK below FAILS with a Postgres CheckViolation — exactly like
-- 087's hanja rollback and 056's writing_attempts.rubric rollback before it:
-- rolling back a widen while the widened value is IN USE is a data-shape
-- conflict the operator must resolve deliberately (delete or retag the
-- writing rows — likely via CASCADE from the owning diagnostic_runs, since a
-- response has no independent audit value per 014's own design note) before
-- the rollback can succeed. This is deliberate — a silent DELETE of live
-- diagnostic history would be a worse outcome than a loud, blocked rollback.
--
-- Declared `-- migrate: destructive` (not sniffed) precisely BECAUSE of that
-- possible CheckViolation-on-live-data outcome, even though the SQL itself
-- contains no DROP TABLE / mass DELETE / TRUNCATE migrate.py's
-- DESTRUCTIVE_PATTERNS would catch — mirrors 087's and 056's down posture
-- exactly.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping DELETE.

ALTER TABLE diagnostic_responses
    DROP CONSTRAINT IF EXISTS ck_diagnostic_responses_section;
ALTER TABLE diagnostic_responses
    ADD CONSTRAINT ck_diagnostic_responses_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening', 'hanja'));

COMMENT ON COLUMN diagnostic_responses.section IS
    'Diagnostic dimension this item exercises: vocab/grammar/reading/listening '
    'or hanja (087/diagnostic-upgrade Phase A — coverage-only, excluded from '
    'the run''s global θ ladder). 088 rolled back; writing requires 088 to be '
    're-applied. A superset of the corpus section enum, hence TEXT + CHECK, '
    'not an enum (see 014).';

-- End of 088_diagnostic_writing_section.down.sql — runner owns the transaction (ADR-013).
