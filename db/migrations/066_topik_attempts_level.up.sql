-- migrate: non-destructive
-- =============================================================================
-- Migration 066 — persist `topik_level` on `topik_attempts` (F-122)
--   UP — adds `topik_level TEXT NULL` to `topik_attempts`, CHECK-constrained
--        to the same 2-value set `topik_tests.topik_level` uses ('TOPIK I' /
--        'TOPIK II' — see migration 005), so a mock attempt row can record
--        WHICH paper (not just which `source_test`) it belongs to.
--   Reverse: 066_topik_attempts_level.down.sql (DROP COLUMN — declared
--        destructive; see its own header).
--   Depends on: 037_topik_attempts (topik_attempts), 029_topik_tests_level_
--        unique (the (test_number, topik_level, section) natural key this
--        column finally threads onto the attempt row).
--
-- WHY: 037 predates D-1 (029's widened natural key) — `topik_attempts` was
-- designed back when a bare `test_number` named ONE exam. Once TOPIK I and
-- TOPIK II sittings could share a `test_number`, every attempt-history read
-- (`GET /topik/attempt`, `GET /topik/attempts`) has had to GUESS the level
-- after the fact via `resolveMockTest`'s tie-break (highest test_number, then
-- TOPIK II over TOPIK I — server/src/routes/topik.ts `resolveServedTotal`).
-- That guess is provably wrong whenever a user actually sat a TOPIK I paper
-- that shares a test_number with a TOPIK II paper: the tie-break always
-- prefers TOPIK II, so a TOPIK I attempt would report the WRONG level (and,
-- transitively, the wrong `totalItems`, resolved from the wrong paper's item
-- count). This column removes the guess for every attempt going forward: the
-- routes now know the exact paper an attempt was served from / graded
-- against, and store it directly.
--
-- WRITE PATH (routes-only change, no migration needed there — see the route
-- diff): `PUT /topik/attempt` accepts an optional `topikLevel` mirroring the
-- SAME trust posture `POST /topik/mock/submit`'s `MockSubmitBodySchema`
-- already has for its own optional `topikLevel` field — the client only ever
-- echoes back a level the SERVER resolved and returned from a prior
-- `POST /topik/mock` call (never a value the client invents), so accepting
-- it here is consistent with the rest of this route file's existing trust
-- model, not a new IDOR/tamper surface (it is a 2-value enum with no
-- authorization implication — it only affects which paper a later re-fetch
-- resolves to, and every mock-content read is already public reference
-- data). `POST /topik/mock/submit` is the AUTHORITATIVE writer: it always
-- knows the resolved level for certain (the exact paper it just graded
-- against) and stamps it on the attempt row it closes/creates, regardless of
-- whatever the in-progress row's own `topik_level` said — so a completed
-- attempt's level can never be stale or wrong, even if progress-saves never
-- sent one.
--
-- WHY NULLABLE, NOT BACKFILLED: existing (pre-066) `topik_attempts` rows
-- carry NO record of which level they were actually served from — the
-- column simply didn't exist, and 037's single-slot design never asked. The
-- only candidate backfill is the SAME guessing tie-break the route layer
-- already applies at READ time (`resolveMockTest` with no requested level) —
-- writing that guess into the column would misrepresent a guess as a
-- verified fact, indistinguishable from a real value to any future reader.
-- Leaving pre-066 rows NULL is the honest choice: the route's read path
-- keeps its existing best-effort re-derivation (`resolveServedTotal`) as the
-- fallback for exactly (and only) the rows this column cannot know for
-- certain, while every attempt closed or saved from this migration forward
-- carries the real, verified level.
--
-- MARKER (F-088): declared non-destructive — ADD COLUMN (nullable, no
-- backfill) and ADD CONSTRAINT both create, never destroy.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write.
-- =============================================================================

ALTER TABLE topik_attempts
    ADD COLUMN IF NOT EXISTS topik_level TEXT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_topik_attempts_topik_level') THEN
        ALTER TABLE topik_attempts
            ADD CONSTRAINT ck_topik_attempts_topik_level
                CHECK (topik_level IS NULL OR topik_level IN ('TOPIK I', 'TOPIK II'));
    END IF;
END $$;

COMMENT ON COLUMN topik_attempts.topik_level IS
    'The exact TOPIK paper level (''TOPIK I''/''TOPIK II'') this attempt was '
    'served from / graded against (F-122). NULL for every attempt saved or '
    'completed before migration 066 — that history predates this column and '
    'is NOT backfilled (a tie-break guess is not a verified fact; see the up '
    'file header). POST /topik/mock/submit is the authoritative writer (it '
    'always knows the resolved level for certain); PUT /topik/attempt '
    'accepts it optionally as a client echo of a value the server itself '
    'resolved and returned earlier, same trust posture as '
    'MockSubmitBodySchema.topikLevel. Readers fall back to the pre-066 '
    'best-effort re-derivation (resolveServedTotal) only when this column is '
    'NULL.';

-- End of 066_topik_attempts_level.up.sql — runner owns the transaction (ADR-013).
