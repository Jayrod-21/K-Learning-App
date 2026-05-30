# ADR-001: Database Foundation Choices

**Status:** Accepted
**Date:** 2026-05-28
**Context owners:** Korean Master project (single-user app)

## Context

We're moving off Supabase (decided 2026-05-27) onto a self-hosted Postgres on Jared's dad's
Ubuntu server. This ADR captures the foundational data-layer decisions all subsequent schema
work depends on, so they don't have to be re-litigated in every migration.

## Decisions

### D1. Database: PostgreSQL 16+
- **Why:** Mature, well-understood by senior engineers, world-class type system (domains, enums,
  arrays, JSONB, range types), excellent full-text search for Korean (with `mecab-ko` or our
  Kiwi service), strong concurrency model.
- **Alternatives considered:** MySQL (weaker types, weaker FTS), SQLite (single-writer, missing
  features we want), DuckDB (analytical workload, wrong fit).
- **Consequence:** We require PG 16+ features (`GENERATED ALWAYS AS IDENTITY` is older, but we'll
  also use newer JSONB and SQL-standard syntax).

### D2. Primary keys: `BIGINT GENERATED ALWAYS AS IDENTITY`
- **Why:**
  - Surrogate keys are stable; natural keys mutate, breaking FKs.
  - `BIGINT` because INT (2^31 ≈ 2.1B) runs out for high-volume tables and migrating later is painful.
  - `GENERATED ALWAYS` (vs `BY DEFAULT`) prevents accidental writes to the ID column from the app
    side — IDs are owned by the database.
- **Alternatives considered:**
  - UUID v4 — random, no time ordering, slower index inserts. Reserved for IDs exposed to
    untrusted clients where opacity matters (none of those here yet).
  - UUID v7 — time-ordered, attractive, but `BIGINT IDENTITY` is simpler and not worse for our
    single-instance setup.
- **Consequence:** Foreign keys are `BIGINT` everywhere; we never expose internal IDs in URLs
  without a wrapper.

### D3. Timestamps: `TIMESTAMPTZ` everywhere
- **Why:** Storing without a timezone is a bug-in-waiting. `TIMESTAMPTZ` stores UTC and converts
  on output per the session's `timezone` setting. There's no scenario where we want naive
  timestamps.
- **Alternatives considered:** `TIMESTAMP` (rejected — has bitten everyone who's used it),
  Unix epochs as `BIGINT` (workable but loses readability and `EXTRACT()` support).
- **Consequence:** Migrations must specify `TIMESTAMPTZ`. Loader code must produce timezone-aware
  datetimes (Python: `datetime.now(timezone.utc)`).

### D4. String columns: `TEXT`, never `VARCHAR(n)`
- **Why:** Postgres treats `VARCHAR(n)` and `TEXT` identically at the storage layer; the length
  cap adds brittleness without performance benefit. Use `CHECK (length(col) <= N)` when
  length actually matters.
- **Alternatives considered:** `VARCHAR(n)` (common from MySQL/Supabase habits — wrong for PG).
- **Consequence:** All string columns are `TEXT`. Length constraints are explicit CHECK constraints
  with a documented reason.

### D5. Semi-structured data: `JSONB`, never `JSON`
- **Why:** JSONB is indexed (`GIN`), supports containment queries, decomposed at insert.
  JSON is just text with a syntax check.
- **Alternatives considered:** `JSON` (rejected — no indexing), separate relational tables (used
  where the structure is stable; JSONB used where it's genuinely flexible, like agent-flagged
  `notes` and the `tips[]` arrays in grammar entries).
- **Consequence:** Where the Darakwon JSON has variable-shape data (`tips[]`, `examples[]`,
  `cross_refs[]`), we'll store JSONB. Where it's stable (a row's `pattern` or `proficiency`),
  it's a typed column.

### D6. Audit columns on every entity table
Every entity table includes:
```sql
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
version INT NOT NULL DEFAULT 1
```
Plus a trigger maintaining `updated_at`:
```sql
CREATE TRIGGER trg_<table>_updated_at
  BEFORE UPDATE ON <table>
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```
- **Why:**
  - `created_at`/`updated_at`: forensics, debugging, "when did this change?"
  - `version`: optimistic concurrency. App reads `version`, writes with `WHERE version = ?`,
    increments. Detects lost updates without locking.
- **Alternatives considered:** No audit columns (rejected — every senior engineer regrets it
  within 6 months). Triggers writing to a separate audit table (deferred — too much overhead
  for our scale; revisit if we need full change history).
- **Consequence:** All loaders, all writers, all schema diffs must respect this contract.

### D7. Soft delete (`deleted_at`) for historical data
- **Why:** Vocab cards, review history, diagnostic snapshots all have value as history even
  after the user "deletes" them. Hard delete loses information; soft delete preserves it.
- **Where:** Entities the user can delete: cards, sessions, custom notes.
- **Where NOT:** Reference data (grammar entries, vocab entries) — those are never deleted by
  users. Transient data (HTTP sessions, idempotency keys) — those should hard-delete on expiry.
- **Consequence:** Most queries on user-data tables filter `WHERE deleted_at IS NULL`. Partial
  indexes mirror this filter.

### D8. Enums via Postgres `CREATE TYPE … AS ENUM`
- **Where applied:**
  - `proficiency_level`: `basic`, `L3`, `L4`, `L5+`
  - `register_level`: `반말`, `해요체`, `합쇼체`, `문어체`, `하오체`, `하게체`
    (renamed from `register` — see *Amendments* below).
  - `topik_section`: `reading`, `listening`, `writing`
  - `corpus`: `ttmik`, `iyagi`, `topik`, `kgiu_beginner`, `kgiu_intermediate`,
    `kgiu_advanced`, `vocab_2000_beginner`, `vocab_2000_intermediate`
  - `book_level`: `beginner`, `intermediate`, `advanced`
- **Why:** Type-safe at the DB level; the app can't insert garbage values. Easier to query and index.
- **Trade-off:** Adding a value requires a migration (`ALTER TYPE ADD VALUE`). That's fine for these —
  the values are genuinely closed sets.
- **Where NOT:** Domain-extensible categories (`category` on grammar entries, e.g., `"particle"`,
  `"connective"`, `"reason"`) — those are TEXT with a CHECK constraint listing known values, so
  we can add categories without a migration.

### D9. Foreign key `ON DELETE` policies
Default to **`RESTRICT`** — a referenced row can't be deleted while children exist. Forces
explicit cleanup, prevents accidental cascade catastrophes.

Use **`CASCADE`** only where the child has no independent meaning:
- `topik_options` → `topik_items` (a multiple-choice option has no meaning without its question)
- `card_reviews` → `vocab_cards` (a review event has no meaning without its card)

Use **`SET NULL`** for soft references:
- `vocab_cards.source_sentence_id` → if the source sentence is removed, the card persists with
  null source.

Every FK declaration includes an explicit `ON DELETE`/`ON UPDATE` — never rely on defaults.

### D10. Naming conventions
- Tables plural, snake_case: `grammar_entries`, `vocab_cards`.
- Columns singular, snake_case: `entry_id`, `created_at`, `is_canonical`.
- PK always `id`.
- FK always `<referenced_table_singular>_id`: `grammar_entry_id`, `topik_test_id`.
- Indexes: `ix_<table>_<columns>`, `uq_<table>_<columns>`, `fk_<table>_<referenced>`.
- Constraints: `ck_<table>_<rule>` for check constraints, e.g., `ck_grammar_entries_proficiency`.

### D11. Migrations: forward + reverse, numbered, tested
- Path: `Repository/db/migrations/NNN_<short_description>.up.sql` and `.down.sql`.
- Numbered sequentially (`001`, `002`, ...).
- Both directions tested in CI: apply up → verify schema → apply down → verify reverted.
- Destructive operations require `--allow-destructive`.

### D12. No business logic in the database
Triggers are allowed only for:
1. `updated_at` maintenance
2. Search-index maintenance (`tsvector` refresh)
3. Audit-trail capture (if we add one later)

Stored procedures encoding app behavior are **disallowed.** The DB stores data; the app
interprets it. Easier to test, version-control, and reason about.

### D13. Connection management
- App connects via psycopg async connection pool (or pgbouncer if needed at scale).
- `application_name` set on every connection: `korean-master-loader`, `korean-master-api`, etc.
  Surfaces in `pg_stat_activity` for observability.
- Statement timeout per role: 5s for the app, 0 (none) for migrations and loaders.

## Consequences

- All schema migrations follow this contract — agents writing migrations check against this file.
- The loader needs to handle the audit columns, version field, enum values consistently.
- Test infrastructure provisions a real Postgres in Docker — SQLite would lie about enums,
  generated columns, JSONB containment, and trigger behavior.
- Operational tooling (backup, restore, monitoring) assumes Postgres 16+ features.

## Open questions

- **Connection pooling:** psycopg native pool is enough at our scale. Revisit pgbouncer if we
  ever shard or hit connection limits.
- **Audit trail:** Deferred until we have user behavior to investigate. The `version` column buys
  us optimistic concurrency without the overhead of a full audit table.
- **Full-text search for Korean:** Resolved by ADR-006 (`simple` config for Phase A,
  Kiwi-aware for Phase B).

## Amendments

### 2026-05-28 — `register` → `register_level` enum rename

The enum named `register` in the original §D8 list was renamed to
`register_level` when migration `001_core_schema.up.sql` was authored:
`REGISTER` is a SQL-reserved-ish keyword in some dialects and a Postgres
type/column named exactly `register` produces surprising parser behavior in
tooling. The values (반말 / 해요체 / 합쇼체 / 문어체 / 하오체 / 하게체) are
unchanged; only the type name moved.

All references downstream (A2 migration 002, ADR-008) use `register_level`.
This amendment back-propagates the rename so future readers don't trip over
the §D8 text.

