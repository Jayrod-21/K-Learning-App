-- 087 (up): widen diagnostic_responses.section to accept 'hanja'
-- (diagnostic-upgrade Phase A — hanja coverage dimension).
--
-- 014 pinned diagnostic_responses.section to the four dimensions the live
-- diagnostic scored at the time: 'vocab' | 'grammar' | 'reading' |
-- 'listening' (a TEXT + CHECK, NOT the topik_section enum — 014's own header
-- notes the four diagnostic dimensions are a superset of the corpus
-- sections, so an enum was never the right fit here). The diagnostic-upgrade
-- spec adds a fifth, COVERAGE-ONLY dimension: hanja, built from the existing
-- `hanja_characters` reference corpus (migration 016 — 89 L2 chars, 768 L3
-- chars) as a plain 4-choice MC item (reading-of-character or
-- meaning-of-character), with NO Claude call. "Coverage-only" means a hanja
-- response is graded and scored (its own `dimensionStats` entry — see
-- `server/src/services/diagnostic/scoring.ts` DIMENSION_ORDER) but never
-- bumps the run's global θ ladder (`server/src/routes/diagnostic.ts`'s
-- `/answer` handler skips `nextTheta` when `section = 'hanja'`) — the hanja
-- corpus caps at L3 (no L4/L5 rows), so letting it drive θ would drag an
-- advanced learner's overall placement toward that ceiling. This migration
-- is the storage half: `section` must accept the new value before a hanja
-- response row can be inserted at all.
--
-- source_kind is NOT touched here. Hanja REUSES source_kind='generated'
-- (already valid — 014's CHECK: 'topik' | 'generated') rather than adding a
-- third 'corpus' value: `section` (not `source_kind`) is what a hanja
-- response is looked up by (`servedHanjaChars` in diagnostic.ts), so a third
-- source_kind value would only widen a CHECK nothing needs to distinguish —
-- the smaller migration surface the spec calls for. `source_ref` stores the
-- served hanja character itself (a single-codepoint TEXT, same column
-- vocab/grammar already put a seed-entry id in).
--
-- Additive/safe: widening a CHECK can never reject an existing row (mirrors
-- 056's writing_attempts.rubric widen, and 027's kgiu_entries.pattern
-- precedent before it). No data touched, no rename, no drop.
--
-- migrate: non-destructive
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- diagnostic_responses.section — a served item may now record section='hanja'.
-- -----------------------------------------------------------------------------
ALTER TABLE diagnostic_responses
    DROP CONSTRAINT IF EXISTS ck_diagnostic_responses_section;
ALTER TABLE diagnostic_responses
    ADD CONSTRAINT ck_diagnostic_responses_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening', 'hanja'));

COMMENT ON COLUMN diagnostic_responses.section IS
    'Diagnostic dimension this item exercises: vocab/grammar/reading/listening '
    'or hanja (087/diagnostic-upgrade Phase A — coverage-only, built from '
    'hanja_characters, excluded from the run''s global θ ladder). A superset '
    'of the corpus section enum, hence TEXT + CHECK, not an enum (see 014).';

-- End of 087_diagnostic_hanja_section.up.sql — runner owns the transaction (ADR-013).
