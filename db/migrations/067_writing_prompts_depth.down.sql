-- migrate: destructive
-- 067 (down): remove the 24 F-096 prompt-depth seed rows.
--
-- Declared destructive (F-088 explicit marker): this is a mass `DELETE FROM`
-- — the exact shape the legacy keyword sniff does NOT catch (no DROP
-- TABLE/SCHEMA/DATABASE or TRUNCATE) — and it is LOSSY at one remove:
-- `writing_attempts.prompt_id` FKs `writing_prompts` with ON DELETE SET
-- NULL (migration 038), so any attempt graded against a 067 prompt loses
-- its bank-row link (the graded `prompt_kr` snapshot on the attempt row
-- survives; only the id linkage is nulled).
--
-- WHY DELETE (not deactivate) — the same round-trip argument as 038's down:
-- these are 067-OWNED seed rows, and a later re-up must rebuild the exact
-- post-067 state. If they survived the down as deactivated rows, the re-up's
-- ON CONFLICT (source_id) DO NOTHING would silently keep them inactive —
-- a permanently shrunken pool. Deleting keeps down→up a true round trip.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DELETE FROM writing_prompts
 WHERE source_id IN (
    'wp-topik53-04', 'wp-topik53-05', 'wp-topik53-06', 'wp-topik53-07',
    'wp-topik53-08', 'wp-topik53-09', 'wp-topik53-10', 'wp-topik53-11',
    'wp-topik53-12', 'wp-topik53-13', 'wp-topik53-14', 'wp-topik53-15',
    'wp-topik54-04', 'wp-topik54-05', 'wp-topik54-06', 'wp-topik54-07',
    'wp-topik54-08', 'wp-topik54-09', 'wp-topik54-10', 'wp-topik54-11',
    'wp-topik54-12', 'wp-topik54-13', 'wp-topik54-14', 'wp-topik54-15'
 );

-- End of 067_writing_prompts_depth.down.sql — runner owns the transaction (ADR-013).
