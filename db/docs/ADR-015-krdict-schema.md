# ADR-015: KRDICT schema design

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** `db/migrations/003_krdict.up.sql`,
                    `db/migrations/003_krdict.down.sql`
**Owner:** Agent B2 (KRDICT)
**Relates to:** ADR-001 (foundation), ADR-005 (stable cols vs JSONB),
                ADR-006 (tsvector config), ADR-013 (migration tx ownership),
                ADR-016 (parser format), ADR-017 (POS taxonomy)
**Supersedes:** the placeholder `krdict_cache` mention in 001's "out of scope"
                comment (now obsolete — KRDICT is the source of truth, not a
                cache of an external API call).

## Context

KRDICT is the National Institute of Korean Language (국립국어원) open
Korean↔English learner dictionary. It is the spine of the `tap-a-word` flow
in DESIGN_SPEC.md:

1. Kiwi lemmatizes the tapped surface form (먹었어요 → 먹다).
2. KRDICT lookup on the lemma returns headword + pronunciation +
   English/Korean definitions + example sentences + (when present) inflection
   tables.
3. The UI shows the definition. The "i" drawer reveals KRDICT examples plus
   Claude enrichment.
4. The user banks the word as a vocab card; the card stores its source
   sentence as the prime example.

The dataset is downloadable in bulk (XML / JSON / CSV depending on the export
chosen — see ADR-016). It has stable per-entry IDs from the source — the
authoritative provenance handle. Definition shapes are stable enough to be
columns; example sentences and inflection tables vary in shape and quantity,
so a relational child-table model fits.

## Decisions

### D1. Four tables, fully normalized

- `krdict_entries` — one row per source headword. Stable scalars only.
  Headword, pronunciation, part-of-speech, homograph index, hanja, register,
  the *first* Korean and English definition (denormalized convenience for
  one-shot card rendering — see D5), audit columns.
- `krdict_senses` — one row per dictionary sense of a headword.
  `(krdict_entry_id, sense_index)` is UNIQUE. A monosemous entry still has
  one row here for shape consistency.
- `krdict_examples` — one row per example sentence per sense. FK to sense.
  korean is NOT NULL; english NULLABLE (KRDICT often lacks English translations
  for examples on lower-frequency senses).
- `krdict_inflections` — one row per inflected form, per entry (verbs and
  adjectives only). Carries the surface form, the inflection label (e.g.
  "past polite informal"), and an order_index for stable rendering.

Tables are 3NF: every non-key column depends on the entry/sense/example PK.

### D2. Natural key: `(source_id, homograph_index)` UNIQUE

KRDICT entry IDs are stable integers. We store them as `TEXT` in `source_id`
to defend against the upstream changing the type someday (they've broadened
the format twice in the past). The natural key is the source ID plus
`homograph_index` because homographs share a base ID in some KRDICT exports.

Surrogate `id BIGINT GENERATED ALWAYS AS IDENTITY` per ADR-001 §D2.

### D3. POS is TEXT, not the existing enum — see ADR-017

KRDICT carries a POS taxonomy that doesn't map cleanly to anything we already
have. Modeling it as TEXT with a CHECK constraint enumerating the known
KRDICT POS values keeps the schema sound *and* migration-free when KRDICT
inevitably adds a value. See ADR-017 for the full enumeration and
justification.

### D4. `register` is `register_level` enum (ADR-001 §D8)

Where KRDICT explicitly tags a headword's register (반말 / 해요체 / 합쇼체 /
문어체 / 하오체 / 하게체) we store it in the existing `register_level` enum.
Untagged headwords keep `register` NULL.

We deliberately do NOT widen `register` to TEXT (the way KGIU's
`kgiu_entries.register` is) because KRDICT's register tags are clean
single-values per entry — none of the composite "해요체/합쇼체" mess that
forced KGIU to TEXT. The clean enum gives us strong typing for the common
case and matches the rest of A1's user-facing tables.

### D5. Denormalized "first sense" definitions on the entry

`krdict_entries.definition_korean` and `definition_english` carry the
*first* sense's definitions, repeated. Reasoning:

1. The tap-a-word flow renders a card from a single entry. We don't want
   that hot path doing a join + ORDER BY sense_index = 1 LIMIT 1 for every
   word lookup. A column on the entry is faster and simpler.
2. We pay the denormalization cost: the loader writes both rows; the
   schema CHECK enforces sense 1 exists. ADR-001 §"Schema" permits
   denormalization with a documented reason — this is it.

`krdict_senses` still holds every sense including the first one (for
multi-sense rendering in the "i" drawer). The entry-row copy is the
performance shortcut.

### D6. FTS via `tsvector` + GIN, `simple` config (ADR-006) — SUPERSEDED

> **Superseded (2026-08-23) by migration `091_fts_removal` (audit §4.2).** The
> `search_tsv` column, its GIN index (`ix_krdict_entries_search_tsv`), and the
> maintenance trigger described in this section and D7 were removed — the FTS
> subsystem had zero live query callers (see ADR-006's superseding note). The
> rest of this ADR (the KRDICT schema itself) still stands; only the full-text
> decision is retired. The `search_tsv_kiwi` migration sketch later in this
> document is likewise cancelled.

Per ADR-006, Phase A uses `to_tsvector('simple', …)` until Kiwi is online.

Weights:
- A: headword
- B: pronunciation (so IPA-style searches hit the right entry)
- C: definition_korean (the entry-level denormalized copy)
- D: definition_english

Maintained by a `BEFORE INSERT OR UPDATE` trigger. The trigger is a
pure function (no external I/O) per ADR-001 §D12.

### D7. Indexes — every one justified

- `ix_krdict_entries_search_tsv` GIN — tap-a-word FTS.
- `ix_krdict_entries_headword` B-tree, partial WHERE deleted_at IS NULL —
  exact-headword lookup is THE hot path. KRDICT is read-only reference, so
  there's no deleted_at, but the index pattern keeps us future-proof if we
  ever need to soft-delete.
- `ix_krdict_entries_headword_prefix` B-tree text_pattern_ops — prefix
  search ("words starting with 먹…") for the search-as-you-type UI.
- `ix_krdict_entries_pronunciation` B-tree, partial WHERE pronunciation IS
  NOT NULL — IPA queries.
- `ix_krdict_entries_pos` B-tree, partial WHERE part_of_speech IS NOT NULL
  — Reference page POS facet ("show me all 형용사").
- `ix_krdict_senses_entry` B-tree on `(entry_id, sense_index)` — the
  multi-sense fetch.
- `ix_krdict_examples_sense` B-tree on `sense_id` — fetch all examples for
  a sense.
- `ix_krdict_inflections_entry` B-tree on `(entry_id, order_index)` —
  ordered conjugation table render.
- `ix_krdict_inflections_surface` B-tree — reverse lookup
  (surface form → base entry) as a Kiwi fallback.

### D8. FK on-delete policies

- `krdict_senses.krdict_entry_id` → `krdict_entries(id)` ON DELETE CASCADE.
  A sense has no meaning without its entry.
- `krdict_examples.krdict_sense_id` → `krdict_senses(id)` ON DELETE CASCADE.
  Same reasoning.
- `krdict_inflections.krdict_entry_id` → `krdict_entries(id)` ON DELETE
  CASCADE. Same.

KRDICT entries are reference data — user-facing tables (vocab_cards) will
FK TO `krdict_entries` with ON DELETE RESTRICT, so dropping a KRDICT entry
that has dependents is blocked at the parent boundary. Within the KRDICT
tables themselves, CASCADE is the right policy because the child rows have
no independent existence.

### D9. `krdict_import_state` checkpoint table

Loader resume support. One row per `(source_path, sha256)` pair.
`last_processed_source_id` (TEXT — matches `krdict_entries.source_id`) plus
counters and timestamps. The loader updates this in the same transaction
as the batch it just committed, so a crash leaves `last_processed_source_id`
exactly at the last durably-stored entry.

### D10. Idempotent upserts keyed on `(source_id, homograph_index)`

The loader uses `INSERT … ON CONFLICT (source_id, homograph_index) DO UPDATE`.
Re-running the loader on the same file is a no-op for unchanged entries and
a row-level update for changed ones (it bumps `updated_at` and `version`).

The `INSERT … ON CONFLICT DO UPDATE … WHERE … IS DISTINCT FROM …` pattern
ADR-A2 baked into migration 002 is repeated here so re-runs don't churn
version numbers on unchanged rows.

### D11. Reversible migration

`003_krdict.down.sql` drops, in order: indexes (implicit on table drop),
tables (children first), trigger functions owned by 003, the seed
`corpus_sources` row owned by 003 (best-effort — DELETE WHERE corpus = …
if `corpus_sources` still exists). Does NOT drop enums owned by earlier
migrations.

The down script tolerates a partial state (every DROP IS IF EXISTS).

## Alternatives considered

- **Store senses as a JSONB array on `krdict_entries`.** Rejected — sense
  is a real relational entity we query independently. JSONB would force
  every "find the sense whose definition matches X" query to scan the
  parent row's JSON. Children are children.
- **Drop `homograph_index` and force unique on `source_id` alone.**
  Rejected — KRDICT homographs share source IDs in the older exports.
  Losing them silently would be a data-integrity bug. The cost of the
  extra column is trivial.
- **Use the existing `corpus` enum value for KRDICT instead of adding one.**
  Rejected and accepted: KRDICT is *reference data*, not a learner corpus
  in the DESIGN_SPEC sense. It does NOT need a `corpus` enum value because
  no row in `vocab_entries` or `kgiu_entries` will ever cite `corpus =
  'krdict'`. We DO add a `corpus_sources` row of provenance because that's
  the catalog for any ingested source, learner-corpus or not — but we use
  a NULL `corpus` for it. (See D12.)

### D12. `corpus_sources` for KRDICT — schema accommodation

`corpus_sources.corpus` is `NOT NULL` with `UNIQUE` in 002. We can't seed
KRDICT there without either widening the column to nullable (breaking
the UNIQUE contract for KGIU/vocab) or adding a `krdict` enum value
(polluting `corpus`, which has DESIGN_SPEC meaning).

**Decision:** create a small sibling table `krdict_source` in 003 with
the same provenance shape (source_path, sha256, item_count, license,
extracted_at) but no FK from anything else — KRDICT entries' provenance
is `krdict_entries.source_id`, not a corpus_sources row.

## Consequences

- 003 is reversible and tested both directions.
- The tap-a-word hot path is a single indexed lookup (`SELECT … FROM
  krdict_entries WHERE headword = $1 LIMIT 1`).
- Multi-sense rendering is a 2-row fetch on a covered index
  (`krdict_senses` on `(entry_id, sense_index)`).
- Adding new KRDICT POS values is a one-line CHECK update — no schema
  surgery needed.
- Phase B (Kiwi-aware FTS) gets the sibling-column treatment per ADR-006:
  add `search_tsv_kiwi`, switch index target, drop old column.
