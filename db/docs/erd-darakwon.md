# ERD — Darakwon corpora (migration 002)

Source: `Repository/db/migrations/002_darakwon_corpora.up.sql`.
Sibling ADRs: `ADR-001-database-choices.md`, `ADR-005-stable-cols-vs-jsonb.md`,
`ADR-006-tsvector-language-config.md`, `ADR-007-vocab-relations-hybrid-target.md`,
`ADR-008-kgiu-vs-grammar-entries.md`.

## Naming clarification

There are TWO grammar tables in this schema, distinct on purpose:

- **`grammar_entries`** — A1's table from `001_core_schema`. User-canonical
  grammar bank, FK to `users`, dedupes highlights by `(user_id, pattern_key)`,
  feeds SRS production drills.
- **`kgiu_entries`** — Owned by this migration. Raw KGIU-book source rows,
  one per `kgiu-<level>-…` JSON entry.

Phase C will build the bridge: a user-canonical `grammar_entries` row will
point at one or more `kgiu_entries` rows (and at TTMIK/Iyagi rows once those
land). See `ADR-008-kgiu-vs-grammar-entries.md`.

## Tables created by migration 002

| Table | Rows about | PK | Audit cols |
|---|---|---|---|
| `corpus_sources` | One per ingested JSON file | `id BIGINT IDENTITY` | yes |
| `kgiu_entries` | One per KGIU source-JSON entry (all 3 levels unified) | `id` | yes |
| `kgiu_entry_relations` | Directed FK cross-references between `kgiu_entries` rows | `id` | yes |
| `vocab_entries` | One per 2000-Words entry (Beginner + Intermediate) | `id` | yes |
| `vocab_entry_relations` | Hybrid-target word↔word relations | `id` | yes |
| `hanja_extensions` | "Korean through Chinese Characters" mind-maps | `id` | yes |
| `lets_check_exercises` | Review-exercise pages, polymorphic parent | `id` | yes |

## Enums introduced by migration 002

- `content_domain` — `general` / `research` / `business`
- `vocab_relation_type` — `synonym`, `antonym`, `related`, `reference`, `passive_form`, `causative_form`, `basic_form`, `honorific_form`, `humble_form`, `contracted_form`
- `kgiu_entry_type` — `grammar` / `intro`
- `vocab_entry_type` — `word` / `theme_intro` / `subsection_intro`
- `lets_check_parent_kind` — `kgiu_entry` / `vocab_subsection`

Reused from A1 / 001: `proficiency_level`, `corpus`, `book_level`, `register_level`.
Reused trigger function: `set_updated_at()`.

## Mermaid

```mermaid
erDiagram
    corpus_sources ||--o{ kgiu_entries           : "produces"
    corpus_sources ||--o{ vocab_entries          : "produces"
    corpus_sources ||--o{ hanja_extensions       : "produces"
    corpus_sources ||--o{ lets_check_exercises   : "produces"

    kgiu_entries  ||--o{ kgiu_entry_relations    : "source"
    kgiu_entries  ||--o{ kgiu_entry_relations    : "target"
    kgiu_entries  ||--o{ lets_check_exercises    : "parent (kgiu)"

    vocab_entries ||--o{ vocab_entry_relations   : "source (CASCADE)"
    vocab_entries ||--o{ vocab_entry_relations   : "target (SET NULL, hybrid)"

    corpus_sources {
        BIGINT  id PK
        corpus  corpus UK
        TEXT    title
        TEXT    publisher
        TEXT    authors
        book_level level
        proficiency_level default_proficiency
        TEXT    source_path UK
        TEXT    source_sha256
        INT     item_count
        TEXT    notes
    }

    kgiu_entries {
        BIGINT  id PK
        BIGINT  corpus_source_id FK
        corpus  corpus
        TEXT    source_id
        book_level book_level
        kgiu_entry_type entry_type
        TEXT    unit
        TEXT    pattern
        TEXT    title_en
        TEXT    category
        TEXT    explanation
        proficiency_level proficiency
        TEXT    register
        content_domain domain
        JSONB   formation_rules
        JSONB   examples
        JSONB   dialogues
        JSONB   vocabulary
        JSONB   tips
        JSONB   compare_with
        JSONB   exercises
        JSONB   cultural_notes
        TEXT    notes
        TEXT    audio_track
        TEXT    source_book
        INT_ARRAY source_pages
    }

    kgiu_entry_relations {
        BIGINT  id PK
        BIGINT  source_entry_id FK
        BIGINT  target_entry_id FK
        TEXT    relation_kind
        TEXT    note
    }

    vocab_entries {
        BIGINT  id PK
        BIGINT  corpus_source_id FK
        corpus  corpus
        TEXT    source_id
        book_level book_level
        vocab_entry_type entry_type
        TEXT    theme
        TEXT    subsection
        TEXT    korean
        TEXT    english
        TEXT    pronunciation
        TEXT    hanja
        TEXT    japanese
        TEXT    part_of_speech
        TEXT    case_marker
        TEXT    irregular_class
        TEXT    example_korean
        TEXT    example_english
        TEXT    passive_form
        TEXT    causative_form
        TEXT    basic_form
        TEXT    honorific_form
        TEXT    humble_form
        TEXT    contracted_form
        JSONB   tips
        JSONB   cross_refs
        JSONB   notes
        proficiency_level proficiency
        content_domain domain
        TEXT    audio_track
        TEXT    source_book
        INT_ARRAY source_pages
    }

    vocab_entry_relations {
        BIGINT  id PK
        BIGINT  source_entry_id FK
        vocab_relation_type relation_type
        BIGINT  target_entry_id FK
        TEXT    target_korean
        TEXT    target_english
        INT     target_page
        TEXT    note
    }

    hanja_extensions {
        BIGINT  id PK
        BIGINT  corpus_source_id FK
        corpus  corpus
        TEXT    source_id
        book_level book_level
        TEXT    theme
        TEXT    central_character
        TEXT    central_korean
        TEXT    central_meaning
        TEXT    central_chinese
        TEXT    central_japanese
        TEXT    central_korean_word
        JSONB   derived_words
        JSONB   notes
        proficiency_level proficiency
        content_domain domain
    }

    lets_check_exercises {
        BIGINT  id PK
        BIGINT  corpus_source_id FK
        corpus  corpus
        TEXT    source_id
        book_level book_level
        lets_check_parent_kind parent_kind
        BIGINT  parent_kgiu_entry_id FK
        TEXT    parent_vocab_theme
        TEXT    parent_vocab_subsection
        TEXT    section_label
        JSONB   items
        TEXT    notes
        proficiency_level proficiency
    }
```

## Cardinality / referential integrity notes

| Edge | ON DELETE | ON UPDATE | Why |
|---|---|---|---|
| `corpus_sources(id) ← kgiu_entries.corpus_source_id` | RESTRICT | CASCADE | Reference data — can't delete a source while children exist. |
| `corpus_sources(id) ← vocab_entries.corpus_source_id` | RESTRICT | CASCADE | Same. |
| `corpus_sources(id) ← hanja_extensions.corpus_source_id` | RESTRICT | CASCADE | Same. |
| `corpus_sources(id) ← lets_check_exercises.corpus_source_id` | RESTRICT | CASCADE | Same. |
| `kgiu_entries(id) ← kgiu_entry_relations.source_entry_id` | RESTRICT | CASCADE | Deleting a referenced entry must be deliberate. |
| `kgiu_entries(id) ← kgiu_entry_relations.target_entry_id` | RESTRICT | CASCADE | Same. |
| `kgiu_entries(id) ← lets_check_exercises.parent_kgiu_entry_id` | CASCADE | CASCADE | Exercises belong to their parent entry. |
| `vocab_entries(id) ← vocab_entry_relations.source_entry_id` | CASCADE | CASCADE | Relation has no meaning without its source. |
| `vocab_entries(id) ← vocab_entry_relations.target_entry_id` | SET NULL | CASCADE | Preserve text label if FK target goes away (ADR-007). |

## FTS / GIN indexes — REMOVED (migration 091_fts_removal, audit §4.2)

The `search_tsv` tsvector columns, their GIN indexes
(`ix_kgiu_entries_search_tsv`, `ix_vocab_entries_search_tsv`), and the
maintenance triggers (`trg_kgiu_entries_tsv`, `trg_vocab_entries_tsv`) were
removed — the full-text-search subsystem had no live query callers (see the
superseding notes in ADR-006 / ADR-015). Reference/vocab/grammar search uses
substring/prefix (ILIKE) matching instead.

## Composite uniqueness

- `(corpus, source_id)` is the natural key on `kgiu_entries`, `vocab_entries`, `hanja_extensions`, `lets_check_exercises`. Loader upserts on it.
- `corpus` on `corpus_sources` is unique.
