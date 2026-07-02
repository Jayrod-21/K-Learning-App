-- 030 (up): add topik_tests.provenance for source-import provenance.
--
-- The TOPIK OCR pass records provenance whenever a sitting is imperfectly
-- sourced, in three source-JSON fields the loader previously dropped
-- (TopikSourceModel used extra="ignore"):
--
--   * note                 — free text, e.g. "passages 23-24 withheld under
--                            copyright" or "no reading test paper exists for
--                            this sitting; answers-only".
--   * transcript_available — TRUE when a listening script was reconstructed
--                            rather than taken from an official transcript PDF.
--   * transcript_source    — how it was reconstructed, e.g. "Whisper large-v3
--                            transcription of the official audio, hand-corrected
--                            against the paper's options + answer key".
--
-- These are a small, FIXED set of known scalars (the three fields above) that
-- is SPARSE, not variable-shape: the shape is fixed, only presence varies (most
-- sittings are fully sourced and store '{}'). They are a value object attached
-- to the (test, level, section) row — not a repeating group — so a single jsonb
-- column is a pragmatic home (cf. passages jsonb on the same table).
--
-- NOTE (ADR-005): this DEPARTS from ADR-005's "stable scalars become columns"
-- rule DELIBERATELY — because provenance is sparse, rarely-populated audit
-- metadata that serving code never joins or filters, NOT because the shape
-- varies. Do NOT cite this as precedent for putting queryable fixed scalars in
-- jsonb; that case still belongs in columns per ADR-005.
-- Loader load_topik.py writes it in lockstep.
--
-- Safe online: ADD COLUMN with a NOT NULL constant DEFAULT is a metadata-only
-- change in modern Postgres (no table rewrite); existing rows read '{}'. The
-- follow-up ADD CONSTRAINT ... CHECK still does a full validating table scan
-- regardless of the row values — it is fast here only because topik_tests is
-- tiny (bounded by sittings x sections). On a large table the online pattern
-- would instead be ADD CONSTRAINT ... NOT VALID followed by VALIDATE CONSTRAINT.

ALTER TABLE topik_tests
    ADD COLUMN provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE topik_tests
    ADD CONSTRAINT ck_topik_tests_provenance_object
        CHECK (jsonb_typeof(provenance) = 'object');

COMMENT ON COLUMN topik_tests.provenance IS
    'Source-import provenance for imperfectly-sourced sittings (jsonb object): '
    'note (withheld/absent papers), transcript_available + transcript_source '
    '(reconstructed listening scripts). Empty object when fully sourced. '
    'Written by tools/ingest/loaders/load_topik.py from the source JSON.';
