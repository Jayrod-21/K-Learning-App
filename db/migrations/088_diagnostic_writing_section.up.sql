-- 088 (up): widen diagnostic_responses.section to accept 'writing'
-- (diagnostic-upgrade Phase B — Claude-graded writing production dimension).
--
-- 087 widened diagnostic_responses.section (originally pinned by 014 to the
-- four live dimensions: 'vocab' | 'grammar' | 'reading' | 'listening') to add
-- a fifth, COVERAGE-ONLY dimension: 'hanja'. This migration adds a SIXTH
-- value, 'writing' — but unlike hanja, writing is a FULL LEVELED dimension:
-- a writing response DOES bump the run's global θ ladder and DOES consume a
-- step-ordinal slot (server/src/routes/diagnostic.ts's /answer handler
-- already guards on `section <> 'hanja'`, not an allow-list of the original
-- four, so writing falls through that guard unchanged — no new θ-gating code
-- was needed, only this storage widen). A writing item is authored + graded
-- by the EXISTING `generateGrammarDrill`/`scoreGrammarDrill` Claude pipeline
-- (Pass 9's grammar-production-drill route) — the user's locked "Claude-
-- graded short response" decision — reused rather than a new Claude route.
-- Pairs with `RUBRIC_VERSION` v1.3.0→v1.4.0 and `DIMENSION_ORDER` gaining
-- `'writing'` as its 6th, trailing member
-- (server/src/services/diagnostic/scoring.ts).
--
-- source_kind is NOT touched here, same reasoning as 087: writing REUSES
-- source_kind='generated' (already valid — 014's CHECK: 'topik' | 'generated')
-- — `section` (not `source_kind`) is what a writing response is looked up
-- by, so a third source_kind value would only widen a CHECK nothing needs to
-- distinguish. `source_ref` stores the kgiu_entries seed id the writing
-- item's grammar pattern was drawn from (same column vocab/grammar already
-- put a seed-entry id in).
--
-- Additive/safe: widening a CHECK can never reject an existing row (mirrors
-- 087's hanja widen, 056's writing_attempts.rubric widen, and 027's
-- kgiu_entries.pattern precedent before it). No data touched, no rename, no
-- drop.
--
-- migrate: non-destructive
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- diagnostic_responses.section — a served item may now record section='writing'.
-- -----------------------------------------------------------------------------
ALTER TABLE diagnostic_responses
    DROP CONSTRAINT IF EXISTS ck_diagnostic_responses_section;
ALTER TABLE diagnostic_responses
    ADD CONSTRAINT ck_diagnostic_responses_section
        CHECK (section IN ('vocab', 'grammar', 'reading', 'listening', 'hanja', 'writing'));

COMMENT ON COLUMN diagnostic_responses.section IS
    'Diagnostic dimension this item exercises: vocab/grammar/reading/listening, '
    'hanja (087/diagnostic-upgrade Phase A — coverage-only, excluded from the '
    'run''s global θ ladder), or writing (088/diagnostic-upgrade Phase B — a '
    'FULL leveled dimension, Claude-graded via generateGrammarDrill/'
    'scoreGrammarDrill, DOES bump θ). A superset of the corpus section enum, '
    'hence TEXT + CHECK, not an enum (see 014).';

-- End of 088_diagnostic_writing_section.up.sql — runner owns the transaction (ADR-013).
