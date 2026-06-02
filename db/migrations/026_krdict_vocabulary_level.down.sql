-- 026 (down): drop vocabulary_level from krdict_entries.
ALTER TABLE krdict_entries
    DROP CONSTRAINT IF EXISTS ck_krdict_entries_vocab_level;
ALTER TABLE krdict_entries
    DROP COLUMN IF EXISTS vocabulary_level;
