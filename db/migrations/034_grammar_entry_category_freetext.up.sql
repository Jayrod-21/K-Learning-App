-- 034 (up): relax grammar_entries.category from a closed whitelist to free text.
--
-- 001 created ck_grammar_entries_category_known: a CHECK restricting category to
-- an 18-value hand-picked taxonomy (particle/connective/ending/.../other). That
-- predates the KGIU grammar corpus. Banking a KGIU pattern copies its corpus
-- category (kgiu_entries.category, which is FREE TEXT — no whitelist) into
-- grammar_entries.category. The corpus legitimately uses dozens of categories
-- the whitelist never anticipated (copula, conjecture, contrast, negation,
-- nominalization, …), so every real Bank click raised
-- `violates check constraint "ck_grammar_entries_category_known"` (SQLSTATE 23514)
-- and returned 500. The client already bounds category to 1–40 chars (Zod), and
-- kgiu_entries.category — the source — has no whitelist, so a closed set here was
-- an over-constraint incompatible with the feature.
--
-- Fix: drop the whitelist; keep a lightweight length bound (1–40, mirroring the
-- API's Zod max) so category stays sane free text. No data loss — the corpus's
-- meaningful category (e.g. 'copula') is preserved instead of being collapsed to
-- 'other'. Consistent with kgiu_entries.category being TEXT.

ALTER TABLE grammar_entries
    DROP CONSTRAINT ck_grammar_entries_category_known;

ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_category_len
        CHECK (char_length(category) BETWEEN 1 AND 40);
