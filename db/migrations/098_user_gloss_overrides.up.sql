-- migrate: non-destructive
-- =============================================================================
-- Migration 098 — user_gloss_overrides (Phase 2.8, user-scoped gloss override)
--   UP — adds `user_gloss_overrides`: a per-user (user_id, lemma) table
--        holding the learner's OWN replacement English gloss for a Korean
--        headword, without ever touching the shared `vocab_entries.english`
--        / `krdict_entries.definition_english` columns.
--   Reverse: 098_user_gloss_overrides.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES
--   * THE F-199 LESSON: `vocab_entries` (and `krdict_entries`) are SHARED
--     reference rows — the mined-entry upsert in `POST /vocab/mine`
--     (server/src/routes/vocab.ts) already learned the hard way that writing
--     per-user intent onto a shared row lets one user's edit silently
--     clobber what every other user sees (F-199's first-write-wins bug on
--     `source_upload_id`). A gloss override is even more directly a matter
--     of personal taste/correction, so it gets its OWN per-user table from
--     day one rather than repeating that mistake.
--   * `lemma` is the Korean headword string — the ONE identifier every gloss
--     surface actually has in common (`vocab_entries.korean`,
--     `krdict_entries.headword`, the client's `WordPopoverData.kr`). Mirrors
--     the lemma-fallback dedup key `POST /vocab/mine` already uses
--     (`vocab.ts` — `lemma-<lemma>`). No FK to `vocab_entries`/`krdict_entries`
--     on purpose: a lemma can appear in either (or both) corpora, and the
--     override is meant to follow the SURFACE FORM across every gloss
--     surface, not one entry row. Accepted v1 limit (documented, not a
--     defect): no homograph/sense disambiguation — overriding 배 (boat/pear/
--     stomach) overrides every sense. A future `pos`/`krdict_entry_id`
--     column can narrow this without a shape break (nullable, additive).
--   * `gloss` is stored VERBATIM as the user's own text — length-bounded
--     (<=2000, matching `krdict_entries.definition_english`'s practical
--     ceiling) but otherwise free text; it's rendered as React text children
--     downstream (client/src/components/WordPopover.tsx), never HTML/markup.
--   * `UNIQUE (user_id, lemma)` is the join key the read-overlay's
--     `LEFT JOIN ... ON ugo.user_id = $u AND ugo.lemma = <lemma col>` relies
--     on to guarantee AT MOST ONE override row per (user, word) — no fan-out,
--     no ORDER BY/LIMIT 1 needed on the join side. It also backs
--     `upsertGlossOverride`'s `ON CONFLICT (user_id, lemma) DO UPDATE`
--     (server/src/services/glossOverrides.ts) and needs no separate index —
--     the UNIQUE constraint's own b-tree already serves the overlay's
--     equality lookup on both columns.
--   * `user_id` REFERENCES users(id) ON DELETE CASCADE — a per-user
--     preference has no meaning once the owning account is gone; mirrors
--     every other per-user table in this schema (vocab_cards, vocab_lists,
--     …). ON UPDATE RESTRICT: users.id is a stable IDENTITY PK that is never
--     renumbered, so a cascading update is not a scenario this schema
--     supports anywhere else either.
--   * `ck_user_gloss_overrides_lemma_len` bounds `lemma` to 1..100 chars,
--     matching `MineBodySchema.lemma`'s own bound in `routes/vocab.ts` (the
--     tap-anything surface font this table's key is drawn from) — a lemma
--     longer than that is not a real headword.
--
-- SECURITY (SERVER-ENFORCED, not by this table alone):
--   `user_id` on every write/read MUST come from `getUserId(req)`
--   (server/src/middleware/auth.ts), never client input — this table has no
--   row-level security of its own (ADR — app-layer scoping, see
--   project_korean_master_phase2_decisions D2), so an IDOR here would be a
--   route bug, not a schema gap. The UNIQUE(user_id, lemma) constraint and
--   every service-layer query below are written assuming that invariant
--   holds; see server/src/services/glossOverrides.ts for the enforcement.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_gloss_overrides (
    id         BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT       NOT NULL,
    lemma      TEXT         NOT NULL,  -- Korean headword being overridden (trimmed/NFC-normalized — see glossOverrides.ts normalizeLemma)
    gloss      TEXT         NOT NULL,  -- the user's own replacement English gloss
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_user_gloss_overrides_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT uq_user_gloss_overrides_user_lemma UNIQUE (user_id, lemma),
    CONSTRAINT ck_user_gloss_overrides_lemma_len
        CHECK (char_length(lemma) BETWEEN 1 AND 100),
    CONSTRAINT ck_user_gloss_overrides_gloss_len
        CHECK (char_length(gloss) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE user_gloss_overrides IS
    'Per-user (user_id, lemma) replacement English gloss (Phase 2.8). NEVER '
    'a write target for the shared vocab_entries.english / '
    'krdict_entries.definition_english columns (the F-199 lesson) — every '
    'gloss-display route COALESCEs this table''s value over the shared '
    'default via a LEFT JOIN on (user_id, lemma). See '
    'server/src/services/glossOverrides.ts.';
COMMENT ON COLUMN user_gloss_overrides.lemma IS
    'The Korean headword/surface form being overridden — matches '
    'vocab_entries.korean / krdict_entries.headword / WordPopoverData.kr. '
    'Normalized (trim + Unicode NFC) identically on write and read by '
    'glossOverrides.normalizeLemma so the overlay join can never silently '
    'miss on a normalization mismatch.';
COMMENT ON COLUMN user_gloss_overrides.gloss IS
    'The user''s own replacement English gloss, stored verbatim. Rendered as '
    'React text children (client WordPopover) — never HTML/markup, never '
    'interpreted.';

-- End of 098_user_gloss_overrides.up.sql — runner owns the transaction
-- (ADR-013). No explicit GRANT: km_app auto-inherits SELECT/INSERT/UPDATE/
-- DELETE on this table via migration 047's ALTER DEFAULT PRIVILEGES.
