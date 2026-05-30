-- =============================================================================
-- Migration 017 — Image captures + OCR-mined words (Pass 8, Images screen)
--   UP — adds `image_captures` (parent, user-owned) + `image_words` (child,
--        the distinct CONTENT words Claude Vision transcribed from the photo)
--        so the Images screen can upload a photo, run OCR, and render a tappable
--        word list against the real image. Standard parent/child pattern;
--        per-user isolation enforced by the FK to users + every read scoped to
--        user_id at the route layer (see Repository/server/src/routes/images.ts).
--   Reverse: 017_image_captures.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES
--   * `image_captures` rows are SOFT-deleted (`deleted_at`). A capture is the
--     user's mining HISTORY — the photo they shot and the words they pulled from
--     it. A future "added to vocab from capture #N" audit row (the deferred
--     KRDICT→vocab_entries mapping of FU-NF-33) would reference this id, and
--     hard-deleting would orphan that trail. Soft delete keeps the row; hard
--     purge is the user-account-delete CASCADE. Mirrors `vocab_lists.deleted_at`
--     (migration 012) and `users.deleted_at` (001).
--   * NO bounding-box columns (locked decision). Claude Vision returns reliable
--     word transcription + glosses but NOT precise coordinates, so the OCR
--     result has no `box` field and the client renders the real photo + a
--     tappable word LIST (not an overlay). `image_words` therefore stores only
--     the word + its glosses + an ordinal, never geometry.
--   * `blob_path` is a RELATIVE path under the configured store root
--     (`IMAGE_STORAGE_DIR`), e.g. `42/9f1c…uuid.png` — NEVER an absolute path.
--     The server joins it with the root and asserts the resolved path stays
--     under the root (path-traversal guard, see imageStore.ts). Storing it
--     relative keeps the rows portable if the root moves (filesystem today, S3
--     later — see SECURITY.md §16) and means the DB never holds a host-specific
--     absolute path.
--   * `mime` is TEXT + CHECK against the upload allowlist (jpeg/png/webp). The
--     route ALSO magic-byte-sniffs the buffer before insert — never trusting the
--     client-declared mime — so a row's `mime` reflects the sniffed type, and
--     the CHECK is the DB backstop for that allowlist.
--   * `image_words.pos` is the lone nullable column: part-of-speech is free text
--     (the client `PartOfSpeech` union — n./v./adj./adv./pn.) and the model may
--     omit it; NULL = "unknown", distinct from a present-but-empty gloss. Every
--     other text column is NOT NULL DEFAULT '' so the DTO never carries a
--     surprising null (the client defaults English/gloss to '').
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. image_captures — one row per uploaded photo + its OCR caption
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS image_captures (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             BIGINT      NOT NULL,

    -- The client-declared upload filename, kept for display only. Untrusted:
    -- it is NEVER used to build a filesystem path (the blob filename is a
    -- server-generated UUID). NULL when the client sent no filename.
    original_filename   TEXT,

    -- Sniffed (not merely client-declared) content type. CHECK is the DB
    -- backstop for the route's magic-byte allowlist.
    mime                TEXT        NOT NULL,

    -- Size of the stored blob in bytes. > 0 (an empty upload is rejected at the
    -- route); the route also caps it at the multer fileSize limit (8 MiB).
    byte_size           INTEGER     NOT NULL,

    -- Relative path under IMAGE_STORAGE_DIR. See module note: never absolute,
    -- never built from client input.
    blob_path           TEXT        NOT NULL,

    -- OCR caption (a short scene description). DEFAULT '' so a caption-less
    -- capture is '' on the wire, never null.
    caption_kr          TEXT        NOT NULL DEFAULT '',
    caption_en          TEXT        NOT NULL DEFAULT '',

    -- Audit columns (ADR-001 D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    -- Soft delete — captures are user mining history (see module note).
    deleted_at          TIMESTAMPTZ,

    CONSTRAINT fk_image_captures_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_image_captures_mime
        CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT ck_image_captures_byte_size_positive
        CHECK (byte_size > 0),
    CONSTRAINT ck_image_captures_blob_path_nonempty
        CHECK (length(blob_path) BETWEEN 1 AND 1024),
    CONSTRAINT ck_image_captures_original_filename_length
        CHECK (original_filename IS NULL OR length(original_filename) <= 512),
    CONSTRAINT ck_image_captures_caption_kr_length
        CHECK (length(caption_kr) <= 2000),
    CONSTRAINT ck_image_captures_caption_en_length
        CHECK (length(caption_en) <= 2000),
    CONSTRAINT ck_image_captures_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE image_captures IS
    'One row per photo a user uploaded to the Images screen, plus its OCR '
    'caption. Powers the Images list + capture views. Soft-deleted so future '
    'mining-history audit rows can keep referring back. Per-user isolation '
    'enforced at the route layer (every read filters by user_id via getUserId).';
COMMENT ON COLUMN image_captures.original_filename IS
    'Client-declared upload filename, display-only and UNTRUSTED — never used '
    'to build a filesystem path (the blob filename is a server UUID).';
COMMENT ON COLUMN image_captures.mime IS
    'Sniffed content type (magic-byte verified at the route, not the client '
    'mime). CHECK constrains to the jpeg/png/webp upload allowlist.';
COMMENT ON COLUMN image_captures.byte_size IS
    'Stored blob size in bytes; > 0. Route caps the upload at 8 MiB.';
COMMENT ON COLUMN image_captures.blob_path IS
    'RELATIVE path under IMAGE_STORAGE_DIR (e.g. "42/<uuid>.png"), NEVER '
    'absolute and NEVER built from client input. The server joins it with the '
    'root and asserts the resolved path stays under the root (traversal guard).';
COMMENT ON COLUMN image_captures.deleted_at IS
    'Soft delete. When set, the capture is treated as deleted (excluded from '
    'list/get). Kept so future mining-history rows can still reference this id.';

-- Query 1: "list a user's live captures, newest first" (GET /images). Partial
-- on deleted_at IS NULL because the listing endpoint always excludes
-- soft-deleted rows and most rows are live.
CREATE INDEX IF NOT EXISTS ix_image_captures_user_created
    ON image_captures (user_id, created_at DESC)
    WHERE deleted_at IS NULL;
COMMENT ON INDEX ix_image_captures_user_created IS
    'Supports GET /images — "list a user''s live captures, newest first" with '
    'the live filter. Partial on deleted_at IS NULL because the listing '
    'endpoint always excludes soft-deleted rows.';

CREATE OR REPLACE TRIGGER trg_image_captures_updated_at
    BEFORE UPDATE ON image_captures
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. image_words — the distinct CONTENT words OCR'd from a capture
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS image_words (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    capture_id      BIGINT      NOT NULL,

    -- Order the word was detected in (0-based). UNIQUE within a capture so the
    -- word list renders in a stable, gap-tolerant order.
    ordinal         INTEGER     NOT NULL,

    -- Dictionary form of the word (Korean). NOT NULL — a word row with no word
    -- is meaningless.
    kr              TEXT        NOT NULL,
    -- Short English gloss + a slightly fuller gloss. DEFAULT '' so the DTO is
    -- '' not null when the model omits them.
    en              TEXT        NOT NULL DEFAULT '',
    gloss           TEXT        NOT NULL DEFAULT '',

    -- Part of speech (client PartOfSpeech union: n./v./adj./adv./pn.). Free
    -- text + nullable: the model may omit it (NULL = unknown).
    pos             TEXT,

    CONSTRAINT fk_image_words_capture
        FOREIGN KEY (capture_id) REFERENCES image_captures(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_image_words_capture_ordinal
        UNIQUE (capture_id, ordinal),
    CONSTRAINT ck_image_words_ordinal_nonneg
        CHECK (ordinal >= 0),
    CONSTRAINT ck_image_words_kr_length
        CHECK (length(kr) BETWEEN 1 AND 200),
    CONSTRAINT ck_image_words_en_length
        CHECK (length(en) <= 500),
    CONSTRAINT ck_image_words_gloss_length
        CHECK (length(gloss) <= 800),
    CONSTRAINT ck_image_words_pos_length
        CHECK (pos IS NULL OR length(pos) <= 16)
);

COMMENT ON TABLE image_words IS
    'The distinct CONTENT words Claude Vision transcribed from a capture '
    '(nouns/verbs/adjectives/adverbs/pronouns — particles/endings skipped). '
    'Child of image_captures (CASCADE). NO bounding-box columns (locked design: '
    'no coordinates) — the client renders a tappable word LIST, not an overlay.';
COMMENT ON COLUMN image_words.ordinal IS
    '0-based detection order. UNIQUE within a capture; the word list renders by '
    'this ordinal.';
COMMENT ON COLUMN image_words.kr IS 'Dictionary form of the word (Korean).';
COMMENT ON COLUMN image_words.en IS 'Short English gloss ('''' when omitted).';
COMMENT ON COLUMN image_words.gloss IS 'Slightly fuller gloss ('''' when omitted).';
COMMENT ON COLUMN image_words.pos IS
    'Part of speech (free text, client PartOfSpeech union). NULL = unknown.';

-- Query 1: "fetch a capture's words in display order" (GET /images/:id).
CREATE INDEX IF NOT EXISTS ix_image_words_capture
    ON image_words (capture_id, ordinal);
COMMENT ON INDEX ix_image_words_capture IS
    'Supports GET /images/:id — a capture''s words in detection order. '
    '(capture_id, ordinal) matches the ORDER BY.';

-- End of 017_image_captures.up.sql — runner owns the transaction (ADR-013).
