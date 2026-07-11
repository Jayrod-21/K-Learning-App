-- 056 (down): restore the narrow (topik_ii_53 / topik_ii_54) rubric CHECKs.
--
-- HONEST GATE — NO SILENT DATA LOSS: this is a pure CHECK narrow, not a data
-- migration. It does not DELETE or touch a single row. If any writing_prompts
-- or writing_attempts row already carries rubric = 'free_write' (written
-- after 056 shipped), re-adding the narrower CHECK below FAILS with a
-- Postgres CheckViolation — exactly like 027's kgiu_entries.pattern rollback
-- ("this will fail if any reference rows with a null pattern exist"): rolling
-- back a widen while the widened value is IN USE is a data-shape conflict the
-- operator must resolve deliberately (retag or remove the free_write rows)
-- before the rollback can succeed. This is deliberate — a silent DELETE of
-- graded writing_attempts rows (or of bank prompts) would be a worse outcome
-- than a loud, blocked rollback.
--
-- NB: migrate.py's own DESTRUCTIVE_PATTERNS gate (DROP TABLE / DROP SCHEMA /
-- DROP DATABASE / TRUNCATE) does not fire on this file — there is no dropped
-- table here, only a re-narrowed CHECK. The CheckViolation IS the gate, and
-- it needs no --allow-destructive to trip: Postgres itself refuses the ADD
-- CONSTRAINT while a violating row exists.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping DELETE.

ALTER TABLE writing_attempts
    DROP CONSTRAINT IF EXISTS ck_writing_attempts_rubric;
ALTER TABLE writing_attempts
    ADD CONSTRAINT ck_writing_attempts_rubric
        CHECK (rubric IN ('topik_ii_53', 'topik_ii_54'));

COMMENT ON COLUMN writing_attempts.rubric IS
    'Rubric the sample was graded against (topik_ii_53 / topik_ii_54 — 056 '
    'rolled back; free_write requires 056 to be re-applied).';

ALTER TABLE writing_prompts
    DROP CONSTRAINT IF EXISTS ck_writing_prompts_rubric;
ALTER TABLE writing_prompts
    ADD CONSTRAINT ck_writing_prompts_rubric
        CHECK (rubric IS NULL OR rubric IN ('topik_ii_53', 'topik_ii_54'));

COMMENT ON COLUMN writing_prompts.rubric IS
    'TOPIK II writing rubric the prompt targets (topik_ii_53 = 200-300자 '
    'description, topik_ii_54 = 600-700자 argumentative essay). NULL only on '
    'the retired pre-F-014 register-drill rows; every ACTIVE prompt is tagged '
    'so GET /writing/prompts and GET /plan/today draw from the same pool. '
    '(056 rolled back: free_write is no longer accepted here.)';

-- End of 056_writing_rubric_widen.down.sql — runner owns the transaction (ADR-013).
