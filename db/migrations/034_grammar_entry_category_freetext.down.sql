-- 034 (down): restore the closed-whitelist category CHECK.
--
-- NOTE: this will FAIL if any grammar_entries row holds a category outside the
-- original 18-value whitelist — which is exactly the state 034 (up) enables
-- (e.g. a banked KGIU pattern with category 'copula'). That is expected: once
-- free-text categories are stored you cannot cleanly narrow back to the closed
-- set without data loss. Safe on a DB whose categories are all within the
-- whitelist (e.g. a fresh/empty grammar_entries).

ALTER TABLE grammar_entries
    DROP CONSTRAINT ck_grammar_entries_category_len;

ALTER TABLE grammar_entries
    ADD CONSTRAINT ck_grammar_entries_category_known
        CHECK (category = ANY (ARRAY[
            'particle', 'connective', 'ending', 'auxiliary', 'modal', 'reason',
            'condition', 'concession', 'time', 'comparison', 'quotative',
            'honorific', 'tense', 'aspect', 'register', 'derivation',
            'expression', 'other']));
