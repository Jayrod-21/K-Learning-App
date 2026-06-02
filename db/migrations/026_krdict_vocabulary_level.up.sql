-- 026 (up): add vocabulary_level to krdict_entries.
--
-- KRDICT's LMF export tags every entry with a vocabulary grade
-- (feat att="vocabularyLevel": 초급 / 중급 / 고급). This feeds the app's
-- proficiency tagging (basic / L3 / L4 — see DESIGN_SPEC) so dictionary-mined
-- words arrive pre-graded for the gap-weighted queues.
--
-- Expand-only and additive: a nullable column + a CHECK. No backfill (existing
-- rows stay NULL until re-ingested), so the still-live color keeps working on
-- the shared DB while this applies. Mirrors the open-set-CHECK pattern used for
-- part_of_speech (ck_krdict_entries_pos).

ALTER TABLE krdict_entries
    ADD COLUMN IF NOT EXISTS vocabulary_level TEXT;

ALTER TABLE krdict_entries
    DROP CONSTRAINT IF EXISTS ck_krdict_entries_vocab_level;
ALTER TABLE krdict_entries
    ADD CONSTRAINT ck_krdict_entries_vocab_level CHECK (
        vocabulary_level IS NULL OR vocabulary_level IN ('초급', '중급', '고급')
    );

COMMENT ON COLUMN krdict_entries.vocabulary_level IS
    'KRDICT vocabulary grade (초급/중급/고급) from the LMF feat vocabularyLevel. '
    'Feeds app proficiency tagging (basic/L3/L4). NULL when KRDICT does not tag one.';
