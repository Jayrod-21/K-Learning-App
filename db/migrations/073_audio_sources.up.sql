-- migrate: non-destructive
-- =============================================================================
-- Migration 073 — audio_sources (Track A, audio → Listen, A-1 schema)
--   UP — adds `audio_sources`: one row per audio SET/collection (the
--        book_uploads analog for the Listen surface — e.g. 'korean-folktales',
--        'easy-korean-reading', a TOPIK listening paper's audio). A set's
--        individual files land in `audio_tracks` (074), its Whisper transcripts
--        in `audio_transcript_segments` (075). See docs/TRACK_A_AUDIO_PLAN.md
--        §2.
--   Reverse: 073_audio_sources.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()),
--               040_book_uploads (book_uploads — the optional paired-reader
--               link target),
--               044_reading_chapters (uq_book_uploads_id_user — the
--               UNIQUE(id, user_id) the composite owner FK below rides,
--               exactly as 051 rode it).
--
-- WHY A SET TABLE (mirrors 040's book/pages split)
--   The corpus is ~1,021 audio files grouped into a handful of coherent sets
--   (TTMIK grammar audio, TOPIK listening papers, Folktales, …). The Listen
--   surface lists SETS, then tracks within a set — exactly the
--   book_uploads → book_pages topology, so the schema mirrors it: this table
--   is the per-set metadata + lifecycle row; audio_tracks (074) holds the
--   per-file rows and their blob pointers.
--
-- WHY source_upload_id RIDES 044's COMPOSITE OWNER FK (051's SET NULL form)
--   A paired-reader set (kind = 'paired_reader') links back to the book it
--   accompanies via source_upload_id. 044_reading_chapters pins its own
--   denormalized user_id to the upload's true owner with a composite
--   (source_upload_id, user_id) -> book_uploads(id, user_id) FK, and the
--   SAME structural guard applies here. Nullable + ON DELETE SET NULL is NOT
--   an obstacle: PostgreSQL 15+ supports a COLUMN-LIST referential action —
--   `ON DELETE SET NULL (source_upload_id)` nulls ONLY the named column,
--   leaving the NOT NULL user_id untouched, which is exactly how
--   051_reading_positions' chapter FK already degrades (051 up, the
--   fk_reading_positions_chapter_of_upload note; km-db runs postgres:16).
--   MATCH SIMPLE semantics make the NULL case right too: a standalone/topik
--   set (source_upload_id NULL) skips the FK check entirely, while ANY
--   non-NULL link must pair with THIS row's user_id in book_uploads — so
--   tagging another user's book is structurally impossible, not merely
--   route-enforced (the 044/051 bar). The FK rides 044's existing
--   uq_book_uploads_id_user; no new unique on book_uploads is needed.
--   Deleting a book un-pairs its audio set (source_upload_id -> NULL) and
--   the set survives with its owner column intact.
--
-- WHY UNIQUE (id, user_id) ON THIS TABLE
--   074's audio_tracks pins ITS denormalized user_id to this set's owner
--   with a composite (source_id, user_id) -> audio_sources(id, user_id) FK —
--   the same maneuver 044 §0 performed on book_uploads. `id` is already the
--   PK, so the UNIQUE never rejects a real row; it only makes the pair
--   referenceable. It is declared inline (not 044 §0's DO-guarded ALTER)
--   because this table is BORN in this migration — CREATE TABLE IF NOT
--   EXISTS already makes a re-apply a no-op.
--
-- WHY THE kind <-> link CHECK IS ONE-DIRECTIONAL
--   ck_audio_sources_paired_kind_link forbids a standalone/topik set from
--   carrying a book link (kind = 'paired_reader' OR source_upload_id IS
--   NULL). It is deliberately NOT bidirectional: NULL always satisfies it,
--   so the FK's SET NULL (source_upload_id) degradation can never trip it —
--   an un-paired 'paired_reader' set (book deleted after pairing) is a
--   legal at-rest state, exactly like 051's degraded position rows.
--
-- WHY kind / status ARE TEXT + CHECK, NOT ENUM TYPES
--   Both are small closed sets read by one surface. Same call as 061's
--   source_kind (README "Conventions": a discriminator this small doesn't
--   warrant its own coordinated ENUM type — enum DDL, dump ordering, and the
--   ADD VALUE same-transaction gotcha buy nothing here). status deliberately
--   mirrors book_upload_status's value set ('processing','ready','failed')
--   without REUSING that enum type — sharing it would couple the audio
--   lifecycle to book uploads' DDL history for no gain.
--
-- WHY UNIQUE (user_id, slug)
--   The loader upserts a set by its stable slug; re-ingesting a set REPLACES
--   it in place rather than erroring or duplicating — the same idempotent
--   test-then-keep contract as book_uploads' UNIQUE (user_id, title) (040).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audio_sources (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Denormalized owner — hot-path scoping (every Listen query is
    -- WHERE user_id = $1). Written by the loader/route for the authenticated
    -- owner; a deleted user takes their audio sets with them.
    user_id           BIGINT      NOT NULL,

    -- Stable set key the loader upserts by (e.g. 'korean-folktales').
    slug              TEXT        NOT NULL,
    title             TEXT        NOT NULL,

    -- What shape of set this is. Closed 3-value set — TEXT + CHECK (see
    -- header): 'paired_reader' (accompanies an uploaded book — Folktales,
    -- Easy Korean Reading, Real-Life Conversations), 'standalone_listening'
    -- (no book — TTMIK grammar audio, News In Korean), 'topik' (a TOPIK
    -- paper's listening audio).
    kind              TEXT        NOT NULL,

    -- The uploaded book a 'paired_reader' set accompanies. NULLABLE (only
    -- paired sets have one) + column-list ON DELETE SET NULL (deleting the
    -- book un-pairs the audio, never deletes it). Owner-pinned by the
    -- composite FK below — see header "WHY source_upload_id RIDES 044's
    -- COMPOSITE OWNER FK": a non-NULL link must pair with THIS row's
    -- user_id in book_uploads, so cross-user tagging is structurally
    -- impossible.
    source_upload_id  BIGINT,

    -- Set lifecycle: 'processing' (created, tracks/transcripts still landing)
    -- -> 'ready' | 'failed'. Value set mirrors book_upload_status (040)
    -- without reusing the enum type — see header.
    status            TEXT        NOT NULL DEFAULT 'processing',

    -- Audit columns (ADR-001 D6)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_audio_sources_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- OWNER GUARD (mirrors 044/051): a non-NULL (source_upload_id, user_id)
    -- must be a real book_uploads(id, user_id) pair — riding 044's
    -- uq_book_uploads_id_user. Column-list SET NULL (PG 15+, 051's exact
    -- form) clears ONLY source_upload_id on book deletion: the set outlives
    -- its paired book (the audio + transcripts were expensive to ingest and
    -- stand alone), un-paired but owner intact; RESTRICT would block a
    -- legitimate book deletion, plain SET NULL would try to null the NOT
    -- NULL user_id.
    CONSTRAINT fk_audio_sources_upload
        FOREIGN KEY (source_upload_id, user_id)
        REFERENCES book_uploads(id, user_id)
        ON DELETE SET NULL (source_upload_id) ON UPDATE RESTRICT,
    -- Loader upsert key: re-ingesting a set replaces it in place (mirrors
    -- book_uploads' UNIQUE (user_id, title), 040).
    CONSTRAINT uq_audio_sources_user_slug UNIQUE (user_id, slug),
    -- Backs 074's composite (source_id, user_id) owner FK — 044 §0's
    -- maneuver, declared inline because this table is born here (see
    -- header). `id` is the PK, so this never rejects a real row.
    CONSTRAINT uq_audio_sources_id_user UNIQUE (id, user_id),
    CONSTRAINT ck_audio_sources_slug_length
        CHECK (length(slug) BETWEEN 1 AND 200),
    CONSTRAINT ck_audio_sources_title_length
        CHECK (length(title) BETWEEN 1 AND 500),
    CONSTRAINT ck_audio_sources_kind
        CHECK (kind IN ('paired_reader', 'standalone_listening', 'topik')),
    CONSTRAINT ck_audio_sources_status
        CHECK (status IN ('processing', 'ready', 'failed')),
    -- One-directional: only a paired_reader set may carry a book link. NULL
    -- always satisfies it, so the FK's SET NULL (source_upload_id)
    -- degradation can never trip it (an un-paired paired_reader set is a
    -- legal at-rest state) — see header "WHY THE kind <-> link CHECK IS
    -- ONE-DIRECTIONAL".
    CONSTRAINT ck_audio_sources_paired_kind_link
        CHECK (kind = 'paired_reader' OR source_upload_id IS NULL),
    CONSTRAINT ck_audio_sources_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE audio_sources IS
    'One row per audio set/collection (Track A, audio -> Listen — the '
    'book_uploads analog): per-set metadata + lifecycle for a group of '
    'audio_tracks (074). kind says whether the set accompanies an uploaded '
    'book (paired_reader, via source_upload_id), stands alone '
    '(standalone_listening), or is a TOPIK paper''s listening audio (topik). '
    'The loader upserts by (user_id, slug) — re-ingest replaces in place. '
    'CASCADEs away with its user; survives its paired book''s deletion '
    '(source_upload_id SET NULL).';
COMMENT ON COLUMN audio_sources.user_id IS
    'Denormalized owner — every Listen query scopes WHERE user_id = $1 '
    'directly. Written for the authenticated owner by the loader/route; '
    'when a paired book is linked, the composite fk_audio_sources_upload '
    'pins it to that book''s true owner (structural — the 044/051 bar).';
COMMENT ON COLUMN audio_sources.slug IS
    'Stable set key (e.g. ''korean-folktales''), UNIQUE per user — the '
    'loader''s upsert target, so re-ingesting a set replaces it in place.';
COMMENT ON COLUMN audio_sources.kind IS
    'Set shape: ''paired_reader'' (accompanies an uploaded book — '
    'source_upload_id points at it), ''standalone_listening'' (no book), '
    '''topik'' (a TOPIK paper''s listening audio). TEXT + CHECK per the '
    'README discriminator convention (061 precedent).';
COMMENT ON COLUMN audio_sources.source_upload_id IS
    'The book_uploads row a ''paired_reader'' set accompanies; NULL for '
    'standalone/topik sets and after the paired book is deleted (column-list '
    'ON DELETE SET NULL — un-pair, never delete the audio). Owner-pinned by '
    'the composite fk_audio_sources_upload to book_uploads(id, user_id): a '
    'non-NULL link can only ever point at THIS user''s book (see the up '
    'header — PG 15+ column-list action, 051''s exact form).';
COMMENT ON COLUMN audio_sources.status IS
    '''processing'' (set created, tracks/transcripts still landing) -> '
    '''ready'' | ''failed''. Mirrors book_upload_status''s value set (040) '
    'as TEXT + CHECK — deliberately not that enum type.';
COMMENT ON CONSTRAINT fk_audio_sources_upload ON audio_sources IS
    'Composite owner guard (044/051''s bar): a non-NULL (source_upload_id, '
    'user_id) must be a real book_uploads(id, user_id) pair, so cross-user '
    'pairing is structurally impossible. Column-list ON DELETE SET NULL '
    '(source_upload_id) — PG 15+, 051''s exact form — un-pairs (never '
    'deletes) the set on book deletion, leaving the NOT NULL user_id '
    'untouched; RESTRICT would block a legitimate book deletion.';

-- GET /listen's one listing query: the caller's own sets, newest first
-- (mirrors ix_book_uploads_user_created's role for GET /uploads).
CREATE INDEX IF NOT EXISTS ix_audio_sources_user_created
    ON audio_sources (user_id, created_at DESC);
COMMENT ON INDEX ix_audio_sources_user_created IS
    'Supports the Listen surface''s set listing — a user''s audio sets, '
    'newest first. Slug lookups ride uq_audio_sources_user_slug''s backing '
    'index instead.';

-- The FK referencing scan on book deletion + the reverse "does this book
-- have paired audio?" lookup. Partial — most sets are standalone/topik, so
-- NULL rows stay out (every other nullable -> book_uploads SET-NULL FK
-- ships the same shape: 040's ix_vocab_entries_source_upload, 068, 070).
CREATE INDEX IF NOT EXISTS ix_audio_sources_upload
    ON audio_sources (source_upload_id)
    WHERE source_upload_id IS NOT NULL;
COMMENT ON INDEX ix_audio_sources_upload IS
    'Partial (paired sets only). Serves fk_audio_sources_upload''s '
    'referencing scan when a book is deleted (SET NULL sweep) and the Read '
    'surface''s "paired audio for this book" reverse lookup.';

CREATE OR REPLACE TRIGGER trg_audio_sources_updated_at
    BEFORE UPDATE ON audio_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 073_audio_sources.up.sql — runner owns the transaction (ADR-013).
