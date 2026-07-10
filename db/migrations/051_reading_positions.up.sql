-- =============================================================================
-- Migration 051 — reading_positions (F-069, per-upload reading-resume position)
--   UP — adds `reading_positions`: ONE saved resume spot per (user, uploaded
--        book), so the reader can reopen a book exactly where the user left
--        off (chapter + passage in the digitized reader, or a raw scan page in
--        the image-page viewer). Also adds a UNIQUE(id, source_upload_id) on
--        reading_chapters to back the chapter-consistency composite FK below.
--   Reverse: 051_reading_positions.down.sql
--   Depends on: 044 (reading_chapters + the book_uploads UNIQUE(id, user_id)
--               that backs the owner-guard FK), 040 (book_uploads), 001 (users,
--               set_updated_at()).
--
-- WHY: the reader currently reopens every book at the top. F-069 persists the
-- last position server-side (NOT in users.preferences — a position is a keyed
-- per-upload row with FK integrity + CASCADE lifecycle, none of which a JSONB
-- blob gives) so resume works across devices and survives re-login.
--
-- DESIGN NOTES
--   * PRIMARY KEY (user_id, source_upload_id) — exactly one resume position per
--     (user, upload). The API upserts by this key; no surrogate id is needed
--     because nothing else ever references a position row.
--   * OWNER-GUARD composite FK (mirrors 044's fk_reading_chapters_upload_owner):
--     (source_upload_id, user_id) -> book_uploads(id, user_id), riding the
--     UNIQUE(id, user_id) that 044 added. It is structurally impossible to
--     attach a position to another user's upload — even a buggy or bypassed
--     route cannot write a (user A, user B's upload) row. CASCADE: deleting the
--     upload deletes its positions (a position is meaningless without its book).
--   * user_id ALSO FKs users(id) ON DELETE CASCADE directly: deleting a user
--     must remove their positions even for uploads that somehow outlive them,
--     and it matches every other user-owned table's lifecycle contract.
--   * chapter_id is NULLABLE — a position in the digitized reader records the
--     chapter (+ optional passage); a position in the raw scan viewer records
--     only page_number. Its FK is the composite (chapter_id, source_upload_id)
--     -> reading_chapters(id, source_upload_id) — backed by the UNIQUE added
--     below — so a position can never point at a chapter of a DIFFERENT book
--     (and transitively, via 044's owner guard, never at another user's
--     chapter). ON DELETE SET NULL (chapter_id): a book re-load replaces its
--     chapters (the 044 loader upserts test-then-keep, but a curator may purge
--     + re-load); the position row must SURVIVE that with the chapter pointer
--     cleared, falling back to page_number. The column-list form (PG 15+;
--     km-db runs postgres:16) nulls ONLY chapter_id — plain SET NULL would try
--     to null source_upload_id too, which is NOT NULL + part of the PK.
--   * passage_number is a plain INT (NOT an FK to reading_passages): passages
--     are replaced wholesale on re-load, and the reader clamps an out-of-range
--     number to the last passage — an advisory pointer, exactly like 044's
--     page hints. CHECK'd positive only.
--   * page_number is the raw-scan advisory pointer (book_pages.page_number),
--     NOT FK'd for the same reason 044 doesn't FK its page hints: page_number
--     is mutable (reorder tool).
--   * The SEMANTIC invariants — "a position must point somewhere" and
--     "passage_number is meaningless without a chapter" — are deliberately
--     NOT CHECK constraints. Postgres re-checks table CHECKs on the UPDATE a
--     referential action performs, so either CHECK would make the chapter
--     FK's SET NULL degradation FAIL the chapter DELETE (a chapter-only
--     position becomes all-NULL pointers; a passage keeps its number with a
--     NULLed chapter) — i.e. a book re-load would 23514 instead of degrading
--     the position. The API boundary (PUT /reading/position Zod schema)
--     enforces both on every write; a degraded row is a legal at-rest state
--     the reader treats as "resume from the top" / "ignore the stale passage".
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Back the chapter-consistency composite FK: UNIQUE (id, source_upload_id)
--    on reading_chapters. `id` is already the PK (so this never rejects a real
--    row) — it only makes the pair referenceable, exactly like 044's
--    uq_book_uploads_id_user. Guarded the same way (no `ADD CONSTRAINT IF NOT
--    EXISTS` in Postgres): a manual re-apply against a DB where this already
--    succeeded must not error.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_reading_chapters_id_upload') THEN
        ALTER TABLE reading_chapters
            ADD CONSTRAINT uq_reading_chapters_id_upload
            UNIQUE (id, source_upload_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. reading_positions — one resume spot per (user, upload).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reading_positions (
    user_id            BIGINT      NOT NULL,
    source_upload_id   BIGINT      NOT NULL,
    -- Where in the digitized reader (NULL when the position is a raw scan page,
    -- or after the referenced chapter was deleted by a re-load — see FK note).
    chapter_id         BIGINT,
    -- 1-based passage within chapter_id; advisory (clamped client-side on
    -- re-load), meaningless without a chapter.
    passage_number     INTEGER,
    -- 1-based raw-scan page (book_pages.page_number); advisory pointer, NOT
    -- FK'd (page_number is mutable — reorder tool; same posture as 044).
    page_number        INTEGER,

    -- Audit columns (migrations README "Conventions")
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER     NOT NULL DEFAULT 1,

    -- One position per (user, upload); the API upserts by this key.
    CONSTRAINT pk_reading_positions
        PRIMARY KEY (user_id, source_upload_id),
    -- Deleting a user removes their positions.
    CONSTRAINT fk_reading_positions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- OWNER GUARD (mirrors 044): (source_upload_id, user_id) must be a real
    -- book_uploads(id, user_id) pair — a position can never attach to another
    -- user's upload, by construction. Deleting the upload deletes the position.
    CONSTRAINT fk_reading_positions_upload_owner
        FOREIGN KEY (source_upload_id, user_id)
        REFERENCES book_uploads(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- CHAPTER GUARD: the chapter (when set) must belong to THIS upload. Backed
    -- by uq_reading_chapters_id_upload above. Column-list SET NULL clears only
    -- chapter_id when the chapter is deleted (book re-load) — the position row
    -- survives on its page_number fallback.
    CONSTRAINT fk_reading_positions_chapter_of_upload
        FOREIGN KEY (chapter_id, source_upload_id)
        REFERENCES reading_chapters(id, source_upload_id)
        ON DELETE SET NULL (chapter_id) ON UPDATE RESTRICT,
    -- Positivity only — the semantic invariants (non-empty position,
    -- passage-requires-chapter) live at the API boundary, NOT here: as table
    -- CHECKs they would fire on the chapter FK's SET NULL update and abort
    -- the chapter DELETE (see DESIGN NOTES).
    CONSTRAINT ck_reading_positions_passage_positive
        CHECK (passage_number IS NULL OR passage_number > 0),
    CONSTRAINT ck_reading_positions_page_positive
        CHECK (page_number IS NULL OR page_number > 0),
    CONSTRAINT ck_reading_positions_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE reading_positions IS
    'ONE saved reading-resume position per (user, uploaded book) — F-069. '
    'Upserted by PRIMARY KEY (user_id, source_upload_id) from PUT '
    '/reading/position/:uploadId. The composite owner-guard FK to '
    'book_uploads(id, user_id) (mirroring migration 044) makes it structurally '
    'impossible to attach a position to another user''s upload; the composite '
    'chapter FK pins chapter_id to a chapter of the SAME upload. Positions '
    'CASCADE away with their upload (and with the user).';
COMMENT ON COLUMN reading_positions.chapter_id IS
    'Resume chapter in the digitized reader, or NULL (raw-scan-only position, '
    'or the chapter was deleted by a book re-load — the composite FK''s SET '
    'NULL (chapter_id) clears just this column and the row survives on '
    'page_number). Pinned to a chapter of THIS source_upload_id by '
    'fk_reading_positions_chapter_of_upload.';
COMMENT ON COLUMN reading_positions.passage_number IS
    '1-based passage within chapter_id, or NULL. Advisory (NOT FK''d to '
    'reading_passages — passages are replaced wholesale on re-load; the reader '
    'clamps out-of-range values). The API requires a chapter alongside it on '
    'every write, but the DB deliberately does not (a CHECK would abort the '
    'chapter FK''s SET NULL — see the table''s design notes); after a chapter '
    'deletion it may linger next to a NULL chapter_id and is then ignored.';
COMMENT ON COLUMN reading_positions.page_number IS
    'Resume page in the raw scan viewer (book_pages.page_number), or NULL. '
    'Advisory pointer, NOT FK''d — book_pages.page_number is mutable (reorder '
    'tool); same posture as reading_chapters.start_page (044).';
COMMENT ON CONSTRAINT fk_reading_positions_upload_owner ON reading_positions IS
    'Owner guard (044 pattern): (source_upload_id, user_id) must match a real '
    'book_uploads(id, user_id) row, so a position can never reference another '
    'user''s upload — enforced by the DB, not just the route''s user filter.';

CREATE OR REPLACE TRIGGER trg_reading_positions_updated_at
    BEFORE UPDATE ON reading_positions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 051_reading_positions.up.sql — runner owns the transaction (ADR-013).
