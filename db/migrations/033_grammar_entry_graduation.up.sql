-- 033 (up): add graduated_at to grammar_entries — "known / graduated" patterns.
--
-- Feature: the user can mark a banked grammar pattern they are comfortable
-- with as KNOWN ("graduate" it). A graduated pattern leaves ACTIVE learning:
--   * the client's drill pool skips it (don't drill what you've mastered),
--   * GET /vocab/cards/due excludes its grammar-production card (the due
--     query already LEFT JOINs grammar_entries; the route adds a
--     `graduated_at IS NULL` predicate for grammar-targeted cards),
--   * GET /grammar/suggestions/weekly keeps excluding it (its exclusion is
--     "any non-deleted banked row", which a graduated row still is).
-- Re-admitting sets the column back to NULL and the pattern re-enters all of
-- the above. NULL = active (the default for every existing row — no backfill
-- needed); non-NULL = the moment the user graduated it.
--
-- WHY the flag lives on grammar_entries and NOT on the production card
-- (vocab_cards.suspended_at): grammar_entries is the user-canonical object —
-- the drill pool, the weekly-suggestion exclusion, and the bank list all key
-- on it, and the production card is a derivative row that a later drill
-- submit would re-schedule anyway (un-suspending it implicitly). Suspending
-- the card would silence only ONE of the three surfaces; graduating the
-- entry silences all of them from a single column, and re-admission is a
-- lossless NULL-out — the card's FSRS state is never touched, so the review
-- schedule resumes exactly where it left off.
--
-- Expand-only and additive: one nullable column, no CHECK needed (any
-- timestamp is valid; NULL is the active state). No new index: every query
-- that reads graduated_at is already narrowed by user_id (per-user bank rows
-- number in the hundreds at most) or arrives via the vocab_cards PK join —
-- a partial index WHERE graduated_at IS NULL would never be chosen over
-- ix_grammar_entries_user_proficiency for those shapes.
--
-- TRANSACTION OWNERSHIP (ADR-013): no BEGIN/COMMIT here — migrate.py wraps
-- this file and the schema_migrations bookkeeping in one transaction.

ALTER TABLE grammar_entries
    ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;

COMMENT ON COLUMN grammar_entries.graduated_at IS
    'When the user marked this pattern as known/graduated. NULL = active '
    '(in the drill pool + review queue); non-NULL = retired from active '
    'learning (drill pool, /vocab/cards/due, weekly suggestions). Re-admit '
    'sets it back to NULL — the production card''s FSRS state is untouched '
    'either way, so re-admission resumes the prior schedule.';
