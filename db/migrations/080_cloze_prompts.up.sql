-- migrate: non-destructive
-- =============================================================================
-- Migration 080 — cloze prompts (F-208, phase 1)
--   UP — creates `cloze_prompts`: one pre-computed cloze presentation per
--        vocab entry. A due recognition card whose entry has a row here MAY be
--        presented as a typed-answer cloze (the client's coin flip); an entry
--        with no row is simply never cloze-eligible and always renders as the
--        normal flashcard. NOT a new card family — grading a cloze advances
--        the SAME vocab_cards row via the shared FSRS write path.
--   Reverse: 080_cloze_prompts.down.sql
--   Depends on: 002_darakwon_corpora (vocab_entries).
--
-- DESIGN NOTES
--   * PRE-COMPUTED, NEVER LIVE. Rows are written only by the operator seeder
--     (POST /vocab/cloze/seed), which runs the entry's example sentence
--     through Kiwi and records the surface span of the token whose LEMMA
--     matches the entry headword. No request-time generation (F-208 v1
--     charter: zero Claude, deterministic grading).
--   * THE ANSWER LIVES ONLY HERE. `answer_surface` (the exact conjugated
--     substring that gets blanked) is SERVER-ONLY: the due-queue read builds
--     the blanked sentence from (korean, blank_start, blank_end) and never
--     selects this column — the same answer-stripping posture as the grammar
--     drill's referenceModel fields (SECURITY.md §17). It is revealed only in
--     the grade RESPONSE, after the learner has answered.
--   * UTF-16 OFFSETS. blank_start / blank_end are UTF-16 code-unit offsets
--     into `korean` (end exclusive) — the km-kiwi Token contract
--     (services/kiwi/src/kiwi_service/models.py). Node's String.slice uses
--     the same units, so the server slices without conversion. Hangul is BMP
--     (1 code unit per syllable), so these match what a human would count.
--   * ONE PROMPT PER ENTRY (v1). uq_cloze_prompts_vocab_entry keeps the model
--     simple: the seeder picks the best sentence (the entry's own example
--     first, KRDICT fallback second) and upserts. The UNIQUE constraint also
--     provides the index the due-queue LEFT JOIN rides.
--   * SHARED REFERENCE DATA. Like vocab_entries itself, rows carry no
--     user_id: a cloze prompt is a property of the WORD, not of a learner.
--     Per-user isolation stays enforced on vocab_cards (the card row), which
--     is where every read/write is scoped.
--   * ON DELETE CASCADE. A corpus re-ingest that deletes an entry must not
--     leave an orphaned prompt pointing at a recycled id.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cloze_prompts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    vocab_entry_id  BIGINT      NOT NULL,

    -- The full sentence (source text, NFC-normalized by the seeder) and its
    -- optional English translation.
    korean          TEXT        NOT NULL,
    english         TEXT,

    -- The blanked span: [blank_start, blank_end) in UTF-16 code units of
    -- `korean`. answer_surface is the exact substring at that span (the
    -- CONJUGATED surface form, not the headword lemma) — server-only, see
    -- header.
    blank_start     INTEGER     NOT NULL,
    blank_end       INTEGER     NOT NULL,
    answer_surface  TEXT        NOT NULL,

    -- Where the sentence came from: the entry's own example_korean, or the
    -- KRDICT example fallback.
    source          TEXT        NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_cloze_prompts_vocab_entry
        FOREIGN KEY (vocab_entry_id) REFERENCES vocab_entries (id)
        ON DELETE CASCADE,

    -- v1: at most one prompt per entry (doubles as the due-queue join index).
    CONSTRAINT uq_cloze_prompts_vocab_entry
        UNIQUE (vocab_entry_id),

    -- Span sanity: non-negative, non-empty. (Upper-bound-vs-sentence-length
    -- is enforced by the seeder, which derives the span from the same string;
    -- char_length counts code POINTS while offsets are UTF-16 code UNITS, so
    -- a SQL upper-bound CHECK would be wrong for any astral character.)
    CONSTRAINT ck_cloze_prompts_span
        CHECK (blank_end > blank_start AND blank_start >= 0),

    -- Closed vocabulary for source — a CHECK, not an enum type, matching the
    -- lighter-weight convention for single-table discriminators.
    CONSTRAINT ck_cloze_prompts_source_known
        CHECK (source IN ('vocab_example', 'krdict')),

    -- Bound the payloads (Kiwi's own input cap is 2000; answers are words).
    CONSTRAINT ck_cloze_prompts_korean_len
        CHECK (char_length(korean) BETWEEN 1 AND 2000),
    CONSTRAINT ck_cloze_prompts_answer_len
        CHECK (char_length(answer_surface) BETWEEN 1 AND 200)
);

COMMENT ON TABLE cloze_prompts IS
    'F-208: one pre-computed cloze presentation per vocab entry (shared '
    'reference data, no user_id). Written only by the seeder '
    '(POST /vocab/cloze/seed); read by the due queue (answer_surface '
    'excluded) and the cloze grade route.';
COMMENT ON COLUMN cloze_prompts.vocab_entry_id IS
    'FK → vocab_entries.id. CASCADE delete; UNIQUE (one prompt per entry, v1).';
COMMENT ON COLUMN cloze_prompts.korean IS
    'The full example sentence the blank is cut from (NFC-normalized).';
COMMENT ON COLUMN cloze_prompts.english IS
    'Optional English translation of the sentence (shown as a hint).';
COMMENT ON COLUMN cloze_prompts.blank_start IS
    'Blank span start — UTF-16 code-unit offset into korean (km-kiwi Token '
    'contract; matches JS String.slice units).';
COMMENT ON COLUMN cloze_prompts.blank_end IS
    'Blank span end (EXCLUSIVE) — UTF-16 code-unit offset into korean.';
COMMENT ON COLUMN cloze_prompts.answer_surface IS
    'The exact surface substring blanked (conjugated form). SERVER-ONLY: '
    'never selected by the due-queue read; revealed only in the grade '
    'response (answer-stripping, SECURITY.md §17 posture).';
COMMENT ON COLUMN cloze_prompts.source IS
    'Sentence provenance: vocab_example (the entry''s own example_korean) or '
    'krdict (KRDICT example fallback).';

-- End of 080_cloze_prompts.up.sql — runner owns the transaction (ADR-013).
