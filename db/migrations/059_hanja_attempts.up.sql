-- =============================================================================
-- Migration 059 — hanja_attempts (F-171, Hanja daily-attempt logging)
--   UP — adds `hanja_attempts`: one row per completed hanja FSRS card review,
--        so the app can finally answer "did the user drill hanja today" (the
--        gap this page's own F-171 comment flagged — see
--        client/src/pages/Hanja.tsx's F-165 note: "there is no per-attempt
--        Hanja history endpoint, so a daily 'drilled today' count (unlike
--        Grammar/Writing/TOPIK) still isn't available").
--   Reverse: 059_hanja_attempts.down.sql
--   Depends on: 001_core_schema (users, the `fsrs_rating` enum), 016_hanja
--               (hanja_characters), 050_hanja_cards (vocab_cards.hanja_character_id).
--
-- DESIGN NOTES (see docs/redesign/BACKEND_BATCH_SCOPING.md §1/§2 for the
-- cross-ticket survey this follows)
--   * Closest existing template is `writing_attempts` (038), NOT
--     `grammar_drill_attempts` (019): a hanja review is a single completed
--     action (rate a due card), not a two-phase generate→score flow, so
--     ONE insert per attempt, no nullable "not yet scored" half-row.
--   * `card_id` is a SOFT FK to `vocab_cards(id)`, `ON DELETE SET NULL` —
--     mirrors `writing_attempts.prompt_id`'s precedent exactly. Cards are
--     already soft-deleted in normal operation (`deleted_at`), but a hard
--     delete (account purge notwithstanding, which CASCADEs the whole row
--     via `user_id` anyway) must never be blocked by, or silently corrupt,
--     an attempt-history row.
--   * `char` is a TEXT snapshot of the character reviewed, NOT resolved via
--     a join at read time — mirrors `hanja_progress.char` (migration 016's
--     own design note: "progress must survive a corpus reload"). A future
--     `build_hanja.py` rebuild that drops/re-adds a character must never
--     erase or orphan a user's attempt history the way a hard FK would.
--   * `rating` reuses the SHARED `fsrs_rating` enum (001_core_schema) — the
--     exact domain `card_reviews.rating` already uses for the same rating
--     value on the same review. Reusing the existing enum (rather than a
--     fresh TEXT + CHECK) keeps one source of truth for "what ratings exist"
--     and gets free DB-level validation identical to card_reviews'.
--   * `correct` is a derived BOOLEAN summary (`rating <> 'again'`), computed
--     by the route/service at write time rather than at read time — this
--     mirrors the task's own "correct/result" ask (a simple mirror of
--     grammar_drill_attempts' verdict-style summary column) while keeping
--     hanja's outcome model appropriately simpler: FSRS's 4-way rating
--     already IS the verdict; a boolean is the minimal derived reading a
--     future daily-count / streak surface needs without re-deriving the
--     "again = miss" rule in every consumer.
--   * ONE index, (user_id, created_at DESC) — exactly what the task spec asks
--     for and what GET /hanja/attempts' paged history query needs (mirrors
--     ix_writing_attempts_user_graded's (user_id, graded_at DESC) shape).
--   * No `deleted_at` / soft-delete column: an attempt is transient practice
--     telemetry, not durable history another row references (same posture
--     as grammar_drill_attempts' design note) — the user FK CASCADE purges
--     it outright on account deletion.
--
-- DEPLOYMENT (expand/contract, zero-downtime on the shared blue/green DB)
--   Purely additive: one new `CREATE TABLE IF NOT EXISTS` + one new index.
--   No existing table is altered. Pre-059 server code never references
--   `hanja_attempts` and keeps working unmodified against the new schema;
--   post-059 code (this same PR) is the only writer/reader. Safe to ship to
--   ONE color while the other color's older code runs unaffected.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hanja_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- The FSRS card this attempt reviewed. Soft link — SET NULL, never
    -- CASCADE/RESTRICT (mirrors writing_attempts.prompt_id): history must
    -- outlive the card row.
    card_id         BIGINT,

    -- Snapshot of the character reviewed. TEXT, NOT a FK to hanja_characters
    -- — deliberately decoupled so a corpus reload never erases attempt
    -- history (mirrors hanja_progress.char, migration 016).
    char            TEXT        NOT NULL,

    -- The learner's self-rating for this attempt. Reuses the shared
    -- fsrs_rating enum (001_core_schema) — the same domain card_reviews.rating
    -- already validates for this exact value.
    rating          fsrs_rating NOT NULL,

    -- Derived outcome summary: TRUE unless rating = 'again'. Computed at
    -- write time so readers never have to re-derive the "again = miss" rule.
    correct         BOOLEAN     NOT NULL,

    -- Event timestamp — one-shot log, not a two-phase generate/score row.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_hanja_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_hanja_attempts_card
        FOREIGN KEY (card_id) REFERENCES vocab_cards(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT ck_hanja_attempts_char_single
        CHECK (char_length(char) = 1)
);

COMMENT ON TABLE hanja_attempts IS
    'Append-only log of completed hanja FSRS card reviews (F-171). One row per '
    'POST /hanja/cards/:cardId/reviews call, written inside that SAME '
    'transaction (services/cardReview.ts). Feeds GET /hanja/attempts and a '
    'future daily-drilled-count / streak surface.';
COMMENT ON COLUMN hanja_attempts.card_id IS
    'Soft link to the reviewed vocab_cards row. ON DELETE SET NULL (mirrors '
    'writing_attempts.prompt_id) — history survives the card being removed.';
COMMENT ON COLUMN hanja_attempts.char IS
    'Snapshot of the character reviewed. Deliberately NOT a FK to '
    'hanja_characters — decoupled so a corpus rebuild never erases attempt '
    'history (mirrors hanja_progress.char, migration 016).';
COMMENT ON COLUMN hanja_attempts.rating IS
    'The FSRS self-rating given, reusing the shared fsrs_rating enum — the '
    'same domain card_reviews.rating validates for this exact review.';
COMMENT ON COLUMN hanja_attempts.correct IS
    'Derived outcome summary: TRUE unless rating = ''again''. Computed at '
    'write time (services/cardReview.ts), not re-derived per reader.';

-- Query: GET /hanja/attempts pages this user's history newest-first; also the
-- shape a future daily-count/streak read would scan. Matches the task's own
-- "indexes on (user_id, created_at)" ask, mirroring
-- ix_writing_attempts_user_graded's (user_id, graded_at DESC) precedent.
CREATE INDEX IF NOT EXISTS ix_hanja_attempts_user_created
    ON hanja_attempts (user_id, created_at DESC);
COMMENT ON INDEX ix_hanja_attempts_user_created IS
    'Supports GET /hanja/attempts (paged, user-scoped, newest-first) and any '
    'future daily-drilled-count read over this user''s attempts.';

-- End of 059_hanja_attempts.up.sql — runner owns the transaction (ADR-013).
