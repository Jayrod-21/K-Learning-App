-- 028 (up): add 'lets_check' and 'hanja_extension' to vocab_entry_type.
--
-- The 2000 Words corpus contains two non-word section types the original enum
-- (002: word/theme_intro/subsection_intro/reference) didn't anticipate:
--   * lets_check       — "Let's Check" review/exercise pages (82 rows)
--   * hanja_extension  — hanja supplement sections (28 rows)
-- The loader rejected them (unknown entry type) and aborted the vocab load. We
-- add them as first-class section types (not coerced to 'word', which would
-- wrongly back-fill proficiency). Only 'word' rows enter the active queues, so
-- these sit as reference-style content — same as theme_intro/reference.
--
-- ADD VALUE is safe inside migrate.py's per-migration transaction on PG12+: the
-- value just cannot be USED until commit. Nothing here uses it; the loader
-- (a separate runtime transaction) does. Mirrors 002's ADD VALUE for 'reference'.

ALTER TYPE vocab_entry_type ADD VALUE IF NOT EXISTS 'lets_check';
ALTER TYPE vocab_entry_type ADD VALUE IF NOT EXISTS 'hanja_extension';
