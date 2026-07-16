-- migrate: non-destructive
-- =============================================================================
-- Migration 070 — per-user upload provenance on vocab_cards (F-199)
--   UP — adds a nullable `source_upload_id` FK on `vocab_cards` (the
--        USER-scoped save artifact), mirroring migration 068's column on
--        `grammar_entries`, then backfills it from the shared
--        `vocab_entries.source_upload_id` tag WHERE ownership matches.
--   Reverse: 070_vocab_cards_source_upload.down.sql
--   Depends on: 001_core_schema (vocab_cards), 040_book_uploads
--     (book_uploads + vocab_entries.source_upload_id).
--
-- WHY vocab_cards AND NOT vocab_entries: F-107 put user-saved provenance on
-- `vocab_entries.source_upload_id` — but that row is SHARED across users
-- (keyed `(corpus, source_id)`, not by user), so `POST /vocab/mine`'s
-- first-write-wins upsert silently discarded a SECOND user's tag when they
-- genuinely mined the same lemma from their OWN upload (F-199). The user's
-- save artifact is the `vocab_cards` row (`user_id`-scoped) — per-user
-- provenance belongs there, exactly as migration 068 concluded for the
-- grammar side (`grammar_entries` is user-scoped, so 068 needed no move).
--
-- `vocab_entries.source_upload_id` is NOT touched: from 070 on it carries
-- ONLY F-108 extracted-corpus provenance ("U2 digitised this row from that
-- upload"), read by the `GET /vocab/entries?source_upload_id=` browse and
-- guarded everywhere by the corpusFences ownership fence. The user-saved
-- write path (`POST /vocab/mine`) stops writing it in the same change.
--
-- SEMANTICS (mirror 068/040 exactly):
--   * Nullable — every pre-existing card, and every save made outside an
--     upload context, stays NULL.
--   * ON DELETE SET NULL — deleting the upload un-tags the card rather than
--     deleting it (the user's card outlives the source PDF).
--   * The route layer validates the referenced upload BELONGS TO the saving
--     user before persisting (server/src/routes/vocab.ts POST /mine), so a
--     cross-user id can never be tagged; the FK here only enforces
--     existence/lifecycle, not ownership.
--
-- MARKER (F-088): declared non-destructive — ADD COLUMN (nullable), CREATE
-- INDEX, and a fill-only backfill UPDATE (writes ONLY rows whose new column
-- is NULL; overwrites nothing) create data, never destroy it. Contrast the
-- down file, which DROPs the column and is declared destructive.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write.
-- =============================================================================

ALTER TABLE vocab_cards
    ADD COLUMN IF NOT EXISTS source_upload_id BIGINT
        CONSTRAINT fk_vocab_cards_source_upload
        REFERENCES book_uploads(id) ON DELETE SET NULL ON UPDATE RESTRICT;

COMMENT ON COLUMN vocab_cards.source_upload_id IS
    'FK -> book_uploads (F-199, per-user user-saved provenance): the upload '
    'the OWNER of this card was working from when they saved the word (POST '
    '/vocab/mine). NULL for saves made outside an upload context and for all '
    'pre-070 rows the backfill could not attribute. ON DELETE SET NULL: '
    'deleting the upload un-tags the card rather than deleting it. The route '
    'validates ownership (upload belongs to the saving user) before '
    'persisting. Replaces the shared-row vocab_entries.source_upload_id as '
    'the user-saved provenance store — that column is F-108 extracted-corpus '
    'provenance only from 070 on.';

-- "This user's saved-from-uploads words, grouped by upload" reads. Partial —
-- the overwhelming majority of card rows carry no upload provenance (mirrors
-- ix_grammar_entries_source_upload / ix_vocab_entries_source_upload).
CREATE INDEX IF NOT EXISTS ix_vocab_cards_source_upload
    ON vocab_cards (source_upload_id)
    WHERE source_upload_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_cards_source_upload IS
    'Partial index (most rows are NULL). Supports saved-from-uploads grouping '
    'reads and the FK''s ON DELETE SET NULL scan when an upload is removed.';

-- -----------------------------------------------------------------------------
-- BACKFILL — migrate correctly-attributed F-107 tags onto the cards.
--
-- Before 070, POST /vocab/mine wrote the caller's upload id onto the SHARED
-- vocab_entries row, first-write-wins. For every card that exists on such an
-- entry, the entry's tag is CORRECT per-user provenance IFF the tagged upload
-- belongs to the card's OWNER — the mine route only ever let a user tag an
-- upload they own, so "entry tag points at an upload owned by this card's
-- user" recovers exactly the writes that user made (plus banked-from-own-
-- extracted-book cards, equally correct provenance).
--
-- SECURITY / CORRECTNESS OF THE OWNERSHIP JOIN (the guard): the join
--   bu.id = ve.source_upload_id AND bu.user_id = c.user_id
-- ties the copied tag to an upload the CARD'S OWNER owns. A card whose entry
-- was tagged to ANOTHER user's upload matches no row and stays NULL — the
-- mis-attributed shared-row tags (the exact F-199 bug: user B's card on an
-- entry first-tagged by user A) are deliberately DROPPED, never copied, so
-- no user's card can ever point at (or later leak the title of) an upload
-- they do not own.
--
-- Set-based, guarded, idempotent: `c.source_upload_id IS NULL` makes this
-- fill-only (a re-run — or a run after down+up — never overwrites a tag the
-- route has since written). Soft-deleted cards are backfilled too:
-- provenance is a historical fact about the save, the reads all filter
-- `deleted_at IS NULL` anyway, and a narrower predicate would just leave the
-- rule harder to state. The vocab_cards updated_at trigger fires on the
-- backfilled rows (audit-only column; FSRS scheduling reads due_at /
-- last_reviewed_at, which this does not touch).
-- -----------------------------------------------------------------------------
UPDATE vocab_cards c
   SET source_upload_id = ve.source_upload_id
  FROM vocab_entries ve
  JOIN book_uploads bu
    ON bu.id = ve.source_upload_id
 WHERE ve.id = c.vocab_entry_id
   AND ve.source_upload_id IS NOT NULL
   AND bu.user_id = c.user_id          -- ownership guard (see header)
   AND c.source_upload_id IS NULL;     -- fill-only: idempotent re-run

-- End of 070_vocab_cards_source_upload.up.sql — runner owns the transaction
-- (ADR-013).
