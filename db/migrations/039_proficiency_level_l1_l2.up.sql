-- 039_proficiency_level_l1_l2.up.sql
--
-- F-002 — TOPIK Level 1 & 2 in the diagnostic.
--
-- Adds 'L1' and 'L2' to the `proficiency_level` enum so the diagnostic can
-- place a beginner at a real level instead of collapsing everything below L3
-- into 'basic'. 'basic' REMAINS a member: it is a content tag on existing
-- vocab_entries / kgiu_entries rows (1716 + 114 rows) and is not disturbed.
-- No data backfill — topik_items keep their existing proficiency tags and the
-- diagnostic uses topik_tests.topik_level ('TOPIK I') as the beginner proxy.
--
-- Positioning: BEFORE 'L3', added in L1-then-L2 order, so the enum's sort
-- order becomes ('basic', 'L1', 'L2', 'L3', 'L4', 'L5+') — comparisons and
-- ORDER BY on the enum stay monotonic in difficulty above 'basic'.
--
-- ADD VALUE is safe inside migrate.py's per-migration transaction on PG12+:
-- the restriction is that the SAME transaction may not USE the new value,
-- which nothing here (or elsewhere in this migration) does. Each ADD VALUE is
-- its own statement, and IF NOT EXISTS makes re-applying a no-op. Mirrors
-- 028/031/032's ADD VALUE stance.

ALTER TYPE proficiency_level ADD VALUE IF NOT EXISTS 'L1' BEFORE 'L3';

ALTER TYPE proficiency_level ADD VALUE IF NOT EXISTS 'L2' BEFORE 'L3';
