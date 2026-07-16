# `db/migrations/` — Database migrations

Forward and reverse migrations for the Korean Master self-hosted Postgres.
Per ADR-001 D11, every migration ships as `NNN_<short>.up.sql` +
`NNN_<short>.down.sql`, applied/rolled back in numeric order.

> If you're adding a section for a later migration, **APPEND** below — do
> not overwrite existing sections.

## Migration list

| # | Name | Owner | Purpose |
|---|------|-------|---------|
| 001 | `core_schema` | A1 | Auth, user state, SRS (FSRS), grammar bank |
| 002 | `darakwon_corpora` | A2 | Darakwon corpora: KGIU + 2000 Words + supplements (hanja, Let's Check) |
| 003 | `krdict` | B2 | KRDICT learner-dictionary import schema |
| 004 | `claude_cache_and_usage` | B4 | Claude proxy: cache + per-call cost / latency accounting |
| 005 | `lesson_podcast_topik` | B-series | TTMIK lessons, Iyagi podcast, TOPIK item pool |
| 006 | `canonical_grammar` | C1 | Canonical-grammar dedup layer (cross-level KGIU dedup, ADR-021) |
| 007 | `skip_placeholder` | C-series | Reserved no-op placeholder (keeps numbering contiguous) |
| 008 | `topik_dependencies` | B-series | TOPIK item-pool dependency tables |
| 009 | `cross_ref_relations` | C-series | Cross-corpus reference relations |
| 010 | `canonical_grammar_manual_override` | C1 | Manual-override sentinel for canonical-grammar re-pointing (REVIEW_C1) |
| 011 | `user_profile_fields` | P3A | `users.phone` + `users.version` (PATCH /auth/me optimistic concurrency) |
| 012 | `vocab_lists` | P3A | User-curated vocab lists (Review → Lists tab) |
| 013 | `writing_prompts` | P4 | Curated writing-prompt bank (Today screen Writing task, GET /plan/today) |
| 014 | `diagnostic_runs` | P5A | Live CAT-lite diagnostic: per-run sessions + per-item responses (Diagnostic screen) |
| 015 | `topik_responses` | P6A | TOPIK Prep answer log: append-only graded attempts (Study mode live + Mock route) |
| 016 | `hanja` | P7A | Hanja reference corpus (`hanja_characters` + `hanja_compounds`) + per-user `hanja_progress` (Hanja screen live); extends `corpus` enum with `'hanja'` |
| 017 | `image_captures` | P8A | Per-user image OCR mining: `image_captures` (uploaded photo + caption, soft-deleted) + `image_words` (the OCR'd content words, no bounding boxes) — Images screen live |
| 018 | `user_preferences` | P9 | `users.preferences` JSONB column — Settings server-sync (notification + palette prefs, Zod-validated whole-blob read/write) |
| 019 | `grammar_drill_attempts` | P9 | `grammar_drill_attempts` — one row per generated production drill, UPDATEd in place at submit/score time (server-only `item` JSONB holds the reference answer, answer-stripped on the wire) |
| 020 | `grammar_production_card_uniq` | FU-NF-42 | Partial UNIQUE index on `vocab_cards (user_id, grammar_entry_id)` scoped to the production face — one production card per (user, grammar pattern); double-submit race defense |
| 021 | `user_mined_corpus` | FU-NF-33 | Extends the `corpus` enum with `'user_mined'` ("tap anything → bank"); value-only migration — first USE deferred to 022 per the enum same-transaction gotcha (mirrors 016) |
| 022 | `user_mined_vocab` | FU-NF-33 | Relaxes both `vocab_entries` CHECKs to admit `'user_mined'` + seeds its `corpus_sources` row (route-populated corpus, so no loader creates the row) |
| 023 | `user_totp` | Login | `user_totp` — single TOTP factor per user (1:1): AES-256-GCM-encrypted base32 secret, replay-guard high-water-mark time-step, per-account lockout counters |
| 024 | `user_recovery_codes` | Login | `user_recovery_codes` — single-use SHA-256-hashed backup codes (`used_at IS NULL` = spendable; atomic rowCount-gated spend) |
| 025 | `mfa_login_challenges` | Login | `mfa_login_challenges` — short-lived, single-use, purpose-scoped pending tokens bridging login step 1 (password) and step 2 (TOTP / enroll) |
| 026 | `krdict_vocabulary_level` | Corpus fix | `krdict_entries.vocabulary_level` (초급/중급/고급, nullable + CHECK) — KRDICT vocabulary grade feeding app proficiency tagging for dictionary-mined words |
| 027 | `kgiu_pattern_allow_reference` | Corpus fix | Relaxes `ck_kgiu_entries_pattern_required` so `reference` rows (appendices / answer keys) may omit a grammar pattern; `grammar` rows still require one |
| 028 | `vocab_entry_type_add_values` | Corpus fix | Extends the `vocab_entry_type` enum with `'lets_check'` + `'hanja_extension'` — the two non-word 2000-Words section types the loader was rejecting |
| 029 | `topik_tests_level_unique` | Corpus fix | Widens the `topik_tests` natural key to `UNIQUE (test_number, topik_level, section)` — TOPIK I vs TOPIK II papers of the same sitting no longer overwrite each other |
| 030 | `topik_tests_provenance` | Corpus fix | `topik_tests.provenance` JSONB — sparse source-import provenance (`note` / `transcript_available` / `transcript_source`) the loader previously dropped |
| 031 | `claude_route_grammar_drill` | Proxy fix | Extends the `claude_route` enum with `generate_grammar_drill` + `score_grammar_drill` — drill calls were failing the `claude_cache`/`claude_usage` writes (uncached + untracked spend) |
| 032 | `claude_route_complete` | Proxy fix | Extends `claude_route` with `image_ocr` + `diagnostic_item` — the enum now mirrors the code's `RouteName` union exactly (`'anon'` deliberately excluded) |
| 033 | `grammar_entry_graduation` | Grammar | `grammar_entries.graduated_at` — mark a banked pattern KNOWN; graduated patterns leave the drill pool + due queue until re-admitted (lossless NULL-out, FSRS state untouched) |
| 034 | `grammar_entry_category_freetext` | Grammar | Replaces the 18-value `grammar_entries.category` whitelist CHECK with a 1–40-char length bound — KGIU corpus categories are free text; fixes the Bank-click 500 |
| 035 | `ttmik_audio` | F-012 | `audio_path` on `ttmik_lessons` + `iyagi_episodes` — RELATIVE keys under `CORPUS_AUDIO_DIR` backing the audio streaming routes (path re-anchored + traversal-checked at the route) |
| 036 | `ttmik_transcript` | F-012 | `ttmik_transcript_lines` — FULL lesson-notes transcript (232 lessons), one row per rendered line with a `kind` render model (header/pair/romanization/prose/dialog) |
| 037 | `topik_attempts` | F-007 | `topik_attempts` — ONE resumable in-progress mock exam per user (picks / current index / remaining time); items re-fetched deterministically on resume, grading stays in `topik_responses` |
| 038 | `writing_attempts` | F-014 | `writing_attempts` (append-only log of graded essays, feeds the F-017 Writing chart) + `writing_prompts.rubric` (TOPIK II Q53/Q54 tagging) + seeds the 6 real TOPIK-style prompts |
| 039 | `proficiency_level_l1_l2` | F-002 | Extends the `proficiency_level` enum with `'L1'` / `'L2'` (positioned BEFORE `'L3'`) so the diagnostic can place beginners at a real level instead of collapsing to `'basic'` |
| 040 | `book_uploads` | U1a | `book_uploads` (user-owned scanned-PDF metadata + relative blob pointer, hard-deleted) + nullable `source_upload_id` FK on `vocab_entries` / `kgiu_entries` for U2's "sort by source" |
| 041 | `book_pages` | U1a | Book-upload rework: `book_pages` (ordered per-page images, normalized from an uploaded zip-of-images or PDF) + drops `book_uploads.blob_ref` (the original file is no longer retained — see `db/docs/PDF_UPLOAD_DESIGN.md` §"REVISION (2026-07-08)") |
| 042 | `vocab_2000_advanced_corpus` | U2 | Extends the `corpus` enum with `'vocab_2000_advanced'` (uploaded "2000 Essential Korean Words — Advanced"); value-only migration — first USE deferred to 043 per the enum same-transaction gotcha (mirrors 021/016) |
| 043 | `vocab_2000_advanced_vocab` | U2 | Relaxes both `vocab_entries` CHECKs to admit `'vocab_2000_advanced'` paired with `book_level = 'advanced'`; `corpus_sources` row created by the loader at load time (contrast 022) |
| 044 | `reading_chapters` | U3b | Digitized chapter reader content store: `reading_chapters` + `reading_passages` (OCR'd + curated literature text, per-paragraph rows) + `UNIQUE(id, user_id)` on `book_uploads` backing the composite ownership FK — see `db/docs/U3_READER_DESIGN.md` §U3b |
| 045 | `hygiene_cleanup` | F-083 | Schema hygiene: drops 6 redundant indexes (each duplicating a same-table UNIQUE), drops the 2 orphan ad-hoc `topik_items_explanation_bak_*` sweep-backup tables (lossy — down recreates empty shells). The audit's proposed `grammar_drill_attempts → grammar_entries` FK was dropped from scope — drill attempts legitimately precede the submit-time auto-bank (see the up header's SCOPE NOTE). **Up contains `DROP TABLE` → apply with `--allow-destructive`** (the scripted deploy's plain `run_migrate up` — and its dry-run — aborts here; see the Group-1 release runbook in `Deploy/README.md`) |
| 046 | `topik_attempts_history` | A1 | Redesigns `topik_attempts` into an attempts model: `status` (active/completed/abandoned) + partial-unique `(user_id) WHERE status='active'` (completed attempts retained as history), `topik_responses.attempt_id` FK grouping; retires the `__closed__` picks tombstone. Unblocks F-078/F-082. **NOT expand/contract** (drops the full unique the pre-046 code's `ON CONFLICT (user_id)` arbiters on) — ships via the brief-downtime Group-1 release, `Deploy/README.md`; its down mass-DELETEs attempt history without tripping the destructive gate (see the down header) |
| 047 | `km_app_role` | B-030 | Least-privilege `km_app` LOGIN role for the Express app: DML (SELECT/INSERT/UPDATE/DELETE) + sequence USAGE only — no DDL/TRUNCATE/superuser; `ALTER DEFAULT PRIVILEGES` auto-grants future migration-created tables/sequences; `schema_migrations` read-only to the app. Role is created WITHOUT a password (the runner has no variable interpolation) — set out-of-band via `Deploy/set-km-app-password.sh`. Migrations keep running as `POSTGRES_USER` |
| 048 | `tickets` | F-023 | Beta ticketing/feedback: `tickets` (bug/concern/suggestion/request, `status` lifecycle, `version` optimistic-concurrency token, author FK CASCADE) + `ticket_comments` (append-only thread, both FKs CASCADE). Community reads are ANONYMIZED at the route layer (`server/src/routes/tickets.ts` never returns `user_id`/email outside owner views). Down drops both tables → `--allow-destructive` |
| 049 | `vocab_list_entries_multitype` | F-048/060/061 | Widens `vocab_list_entries` membership to a vocab/grammar/hanja XOR (exactly-one-non-null CHECK; the 012 UNIQUE stays as the vocab-leg guarantee + per-target partial UNIQUEs for the new columns); powers list management (create/rename/add-by-type/remove) — **closes B-013**. ADD-ONLY expand — `entry_id` keeps its 012 name (no rename → expand/contract-safe, ships via the normal zero-downtime flow; see the up header). Existing vocab rows preserved. Its down DELETEs grammar/hanja memberships + drops the new columns **without tripping the destructive gate** (see the down header) — though in the merged chain a `down --target 048` requires `--allow-destructive` anyway, for 052/051's `DROP TABLE` downs |
| 050 | `hanja_cards` | F-075 | Adds hanja as a new leg of the `vocab_cards` target XOR (hanja FK + extended exactly-one CHECK + per-(user, hanja, face) partial UNIQUE) so hanja rides the existing FSRS engine + `card_reviews`; shared review logic extracted to `server/src/services/cardReview.ts`. Its down mass-DELETEs all hanja cards (+ their `card_reviews`) via DELETE + DROP COLUMN **without tripping the destructive gate** (see the down header) — though in the merged chain a `down --target 049` requires `--allow-destructive` anyway, for 052/051's `DROP TABLE` downs |
| 051 | `reading_positions` | F-069 | Per-upload reading resume: `reading_positions` PK`(user_id, source_upload_id)` with the 044 composite owner-guard FK to `book_uploads` + a composite FK to `reading_chapters` (backed by a new `UNIQUE(id, source_upload_id)`); `ON DELETE SET NULL (chapter_id)`. Down → `--allow-destructive` |
| 052 | `notification_schedules` | F-040 | Notification schedules (`kind` daily_reminder/reviews_due/weekly_report × `channel` push/email/sms, `time_of_day`+`tz`, `weekday` for weekly, UNIQUE`(user, kind, channel)`) + `notification_deliveries` send-log. **Supersedes F-006**; no sender ships (SMS is a stored placeholder). Down → `--allow-destructive` |
| 053 | `claude_route_generation` | F-027/073/068 | Adds `claude_route` enum values `generate_writing_prompt` + `generate_story` for the generation engine's cache/usage tracking (value-only, mirrors 031/032). Down is a documented no-op (PG can't drop enum values). Zero-downtime safe |
| 054 | `generated_stories` | F-068 | `generated_stories` (user-owned AI-generated Korean reading stories: title, `body_ko`, level, prompt, audit cols) feeding the reading page's Generate section. Add-only new table, zero-downtime safe. Down → `--allow-destructive` |
| 055 | `conversation_titles` | F-036 | Auto-name chats: `conversations.title` TEXT NULL (user-set or Claude-generated; NULL = unnamed — the server only auto-names when NULL, so a user rename is never clobbered) + a 1..200-char CHECK, and `claude_route` gains `'name_conversation'` for the naming call's cache/usage tracking (031/032 pattern; the value + the column share one migration because nothing USES the value in-migration). Add-only expand, zero-downtime safe. Down drops the column (lossy for titles — regenerable display labels; the enum value stays, same posture as 031/032) without tripping the destructive gate |
| 059 | `hanja_attempts` | F-171 | Append-only log of completed hanja FSRS card reviews: `hanja_attempts` (soft, `ON DELETE SET NULL` FK to `vocab_cards`, `char` snapshotted so a corpus reload never orphans history, `rating` reuses the shared `fsrs_rating` enum). Add-only new table, zero-downtime safe. Down → `--allow-destructive` |
| 060 | `reading_attempts` | F-172 | Append-only log of completed reading actions: `reading_attempts` (soft, `ON DELETE SET NULL` FKs to `reading_chapters`/`generated_stories`, discriminated by `source_kind`, `title_snapshot` survives either target's removal). Add-only new table, zero-downtime safe. Down → `--allow-destructive` |
| 061 | `listening_attempts` | F-172 | Append-only log of completed listening actions: `listening_attempts` (soft, `ON DELETE SET NULL` FKs to `ttmik_lessons`/`iyagi_episodes`, discriminated by `source_kind`, `title_snapshot` survives a corpus reload). Add-only new table, zero-downtime safe. Down → `--allow-destructive` |
| 062 | `revoke_km_app_temp` | F-089 | Revokes `km_app`'s (047) default `TEMPORARY` privilege on the database — both its own grant (defensive, never explicit) and `PUBLIC`'s database-level default (the real fix, protects future roles too). Verified zero `CREATE TEMP`/`pg_temp` usage anywhere in the codebase first. Marked `-- migrate: non-destructive` (F-088) — a privilege REVOKE is not data loss. Down re-GRANTs both, also non-destructive |
| 063 | `notification_deliveries_claim_key` | F-092 | Adds `notification_deliveries.window_start TIMESTAMPTZ NOT NULL` + `UNIQUE (schedule_id, window_start)` — the real idempotency claim key for the future F-040 sender (an `INSERT ... ON CONFLICT DO NOTHING` on this key, not a probe-then-insert, arbiters concurrent claims of the same firing). No sender ships here — see `server/src/services/notificationDelivery.ts`'s `claimDelivery`/`settleDelivery`. Down `DROP COLUMN` is marked `-- migrate: destructive` (F-088) — the exact mass-DROP-COLUMN shape the legacy sniff would have missed |
| 064 | `backfill_notification_schedules_from_prefs` | F-093 | One-time data backfill (no schema change): for every user whose 018 `preferences->notif` blob already expresses an enabled email intent, inserts the equivalent `notification_schedules` (052) row when one doesn't already exist (`ON CONFLICT DO NOTHING` — real user data always wins). Defensive `jsonb_typeof` guards so a malformed/legacy blob can't abort the migration. Down is marked `-- migrate: destructive` (mass DELETE) and only removes rows still untouched since the backfill (`created_at = updated_at`) |
| 065 | `vocab_recognition_card_uniq` | F-113 fix-pass | Partial UNIQUE index on `vocab_cards (user_id, vocab_entry_id)` scoped to the recognition face — one recognition card per (user, vocab entry); closes the `POST /vocab/lists/:id/cards/seed` / `cards/init` / `entries/:id/bank` double-seed race (mirrors 020/050). Up is marked `-- migrate: destructive`: it DEFENSIVELY soft-deletes any pre-existing duplicate rows (keep-earliest-id) BEFORE creating the index, so it succeeds on a live DB whether or not the pre-existing gap already produced duplicates. Down only drops the index — does not restore soft-deleted duplicates (documented, one-way data cleanup) |
| 066 | `topik_attempts_level` | F-122 | Adds `topik_attempts.topik_level TEXT NULL` (CHECK-constrained to the same `'TOPIK I'`/`'TOPIK II'` set as `topik_tests.topik_level`) so an attempt row records the EXACT paper it was served from / graded against, instead of the pre-existing best-effort tie-break guess (`resolveServedTotal`). `POST /topik/mock/submit` is the authoritative writer; `PUT /topik/attempt` validates a client-supplied level against `resolveMockTest(section, sourceTest, level)` and drops a mismatch to NULL. Pre-066 rows stay NULL — not backfilled (a guess is not a verified fact; see the up header). Down `DROP COLUMN` is marked `-- migrate: destructive` |
| 067 | `writing_prompts_depth` | F-096 | Seeds 24 additional rubric-tagged TOPIK II writing prompts (12 × Q53, 12 × Q54) into `writing_prompts`, deepening the bank from ~3 to 15 prompts per rubric so the server-side random draw has a real rotation. Pure add-only content (INSERTs, `ON CONFLICT (source_id) DO NOTHING`), marked `-- migrate: non-destructive`; its down DELETEs exactly these 24 seed rows by source_id → declared destructive |
| 068 | `grammar_entries_source_upload` | F-107 | Adds a nullable `source_upload_id` FK on `grammar_entries` (named FK → `book_uploads`, `ON DELETE SET NULL`, partial index), mirroring the column migration 040 put on `vocab_entries`/`kgiu_entries`. Records *user-saved* provenance for the `POST /grammar/bank` save path (a USER-scoped table) — distinct from F-108's *extracted-corpus* provenance on `kgiu_entries`. Up `-- migrate: non-destructive`; down `DROP COLUMN` marked destructive |
| 069 | `upload_extractions` | F-108 | U2 extraction runs: `upload_extractions` (one row per OCR run over a page range of a book upload — status pending/running/done/failed, range + `pages_requested` for the daily Vision-page cap, result counts, error; partial UNIQUE `(upload_id) WHERE status IN ('pending','running')` = one live run per upload, the claim INSERT arbitrates concurrency) + relaxes both `kgiu_entries` corpus/level CHECKs to admit `'user_mined'` (mirrors 022's vocab_entries relaxations) so extracted grammar candidates can persist with `source_upload_id`. Up marked `-- migrate: non-destructive`; down (DROP TABLE + CHECK restore, which fails loudly if user_mined kgiu rows still exist — same posture as 022's down) is destructive |

## Explicit destructive marker (F-088)

Every migration's destructive classification first checks for a directive
comment, anywhere in the file:

```sql
-- migrate: destructive
-- migrate: non-destructive
```

When present, the declaration is authoritative — it overrides the legacy
keyword-sniff (`DROP TABLE`/`DROP SCHEMA`/`DROP DATABASE`/`TRUNCATE`), which
does not catch a mass `DELETE FROM` or a `DROP COLUMN` (see 046.down / 041 for
pre-existing examples the sniff still doesn't catch — they predate this
ticket and were not retrofitted, since already-applied migration content is
checksum-locked). A migration with NO directive falls back to the unchanged
legacy sniff — every migration written before F-088 (001-061) classifies
exactly as it always has. See `db/migrate.py`'s `explicit_destructiveness` /
`contains_destructive` and `db/tests/test_migrations.py` for the full
contract (case-insensitivity, string-literal-forging guard, conflicting-marker
rejection).

New migrations should prefer the explicit marker over relying on the sniff.

## Transaction ownership (ADR-013)

**Migration files MUST NOT contain top-level `BEGIN`, `COMMIT`, `ROLLBACK`,
`START TRANSACTION`, or unprefixed `SAVEPOINT`.** The runner (`db/migrate.py`)
wraps every migration body in a single transaction together with the
`schema_migrations` bookkeeping write. An inner `COMMIT` would end the
runner's tx early and decouple the schema change from the bookkeeping row,
breaking atomicity.

`discover_migrations` enforces this rule at discovery time — a file
containing top-level tx control is rejected before any apply runs (raises
`TxControlInMigration`). `BEGIN`/`END` inside `DO $$ … $$` blocks (PL/pgSQL
keywords) are fine — the detector strips dollar-quoted strings before
matching.

Manual application via `psql` should use the `-1` flag to wrap the whole
file in a transaction without requiring inline `BEGIN`/`COMMIT`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f NNN_name.up.sql
```

See `db/docs/ADR-013-migration-tx-ownership.md` for the rationale and
alternatives considered.

## Running migrations

Migration tooling is owned by A3 (`docker-compose.yml` + `Makefile` +
migrator). The expected interface is:

```bash
make db.up          # apply all pending up migrations
make db.down N=1    # roll back the last N migrations
make db.status      # show applied vs pending
```

Manual application with `psql` (use the `-1` flag — the migration files
deliberately don't contain `BEGIN`/`COMMIT`; the runner OR psql -1 owns
the transaction; see ADR-013):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 001_core_schema.up.sql
```

`ON_ERROR_STOP=1` is critical — without it, psql continues after errors and
leaves the schema in a half-applied state. `-1` wraps the file in a single
transaction so partial-failure rollback is automatic.

## How to test a migration

Per the Senior Engineer Bar §1 "Migrations": every migration is tested in
both directions. The test cycle is:

1. **Fresh database** — `dropdb && createdb` or a disposable Docker container.
2. **Apply up** — `psql -v ON_ERROR_STOP=1 -1 -f NNN_*.up.sql`. Must succeed.
3. **Snapshot schema** — `pg_dump --schema-only > after-up.sql`.
4. **Apply down** — `psql -v ON_ERROR_STOP=1 -1 -f NNN_*.down.sql`. Must succeed.
5. **Snapshot again** — `pg_dump --schema-only > after-down.sql`.
6. **Confirm reverted** — `diff before-up.sql after-down.sql` is empty (or
   limited to extension presence, which we intentionally don't drop).
7. **Re-apply up** — verify idempotency: applying again on a fresh DB still
   succeeds.

A3 will wire this into CI.

## Rolling back

Down migrations for **001** are destructive by design (they `DROP TABLE`
users / sessions / vocab_cards / etc.). Pass `--allow-destructive` when
running `make db-rollback` or `python -m db.migrate down` — without it the
runner exits non-zero with a guard error and refuses to apply the down.
This is intentional: 001 is the foundation, and rolling it back wipes the
database. See `db/docs/ADR-013-migration-tx-ownership.md` and the Senior
Engineer Bar §1 ("Migrations — destructive operations gated").

## Conventions

- Identity columns: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`. Never
  serial, never INT.
- Timestamps: `TIMESTAMPTZ`, default `now()`. Never `TIMESTAMP`.
- Strings: `TEXT` + optional `CHECK (length(...) <= N)`. Never `VARCHAR(n)`.
- Semi-structured: `JSONB`. Never `JSON`.
- Closed sets: Postgres `ENUM`. Open sets that may grow: `TEXT` + `CHECK`.
- Audit columns on every entity table: `created_at`, `updated_at`, `version`.
- `updated_at` maintained by the shared `set_updated_at()` trigger function
  (defined in 001, reused by every later migration).
- Soft delete (`deleted_at`) for user-owned historical data; hard delete for
  transient data.
- Every FK has explicit `ON DELETE` and `ON UPDATE` clauses.
- Index names: `ix_<table>_<cols>`, `uq_<table>_<cols>`, `fk_<table>_<ref>`.
- Every index has a `COMMENT ON INDEX` naming the query it supports.
- Every table and non-obvious column has `COMMENT ON TABLE` / `COMMENT ON COLUMN`.

See `db/docs/ADR-001-database-choices.md` for the full contract.

---

## Migration 001: `core_schema` (A1)

### What it creates

1. Extensions: `citext`, `pgcrypto`.
2. Shared trigger function: `set_updated_at()` — used by every later migration.
3. Enum types: `proficiency_level`, `register_level`, `topik_section`,
   `corpus`, `book_level`, `card_face`, `fsrs_rating`, `fsrs_state`,
   `conversation_mode`.
4. Tables (in dependency order):
   - `users` — accounts + Argon2id password hash + email verification + soft delete.
   - `sessions` — server-side opaque session tokens (SHA-256 hashed in storage).
   - `study_log` — per-day rollup.
   - `user_progress` — append-only metric snapshots.
   - `diagnostic_snapshots` — multi-dimensional adaptive diagnostic history.
   - `conversations` — AI tutor / roleplay sessions.
   - `grammar_entries` — user-banked canonical grammar patterns.
   - `vocab_cards` — FSRS-native SRS state (polymorphic target).
   - `card_reviews` — append-only review log with BEFORE/AFTER state.

### Coordination with migration 002

`vocab_cards` declares three nullable columns that A2 will FK-link to corpus
tables after they exist:

- `vocab_entry_id`     → reserved name `fk_vocab_cards_vocab_entry`     (ON DELETE RESTRICT)
- `source_sentence_id` → reserved name `fk_vocab_cards_source_sentence` (ON DELETE SET NULL)
- `topik_item_id`      → reserved name `fk_vocab_cards_topik_item`      (ON DELETE RESTRICT)

A2's `002_*.down.sql` MUST drop these constraints before this migration is
rolled back. See `db/docs/ADR-004-soft-fk-to-corpus.md`.

### ADRs that explain non-obvious choices

- `ADR-001` — foundation (BIGINT IDENTITY PKs, TIMESTAMPTZ, TEXT, JSONB, enums).
- `ADR-002` — Argon2id password hashing, server-side opaque sessions, cookie attrs.
- `ADR-003` — FSRS storage (state on card, append-only review log), polymorphic target.
- `ADR-004` — Deferred FKs from `vocab_cards` to corpus tables.

### Security

See `SECURITY.md` (same directory) — enumerates SQL injection, credential
stuffing, timing attacks, session hijacking, password-DB-compromise, CSRF,
mass assignment, exfiltration, soft-delete bypass, JSONB injection.

### How to test (this migration specifically)

```bash
# Fresh DB
createdb korean_master_test
export DATABASE_URL=postgres://localhost/korean_master_test

# Apply up (note -1: migration files don't own transactions — see ADR-013)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/001_core_schema.up.sql

# Quick smoke: every expected table and enum exists
psql "$DATABASE_URL" -c "\dt" | grep -E 'users|sessions|study_log|user_progress|diagnostic_snapshots|conversations|grammar_entries|vocab_cards|card_reviews'
psql "$DATABASE_URL" -c "\dT" | grep -E 'proficiency_level|register_level|topik_section|corpus|book_level|card_face|fsrs_rating|fsrs_state|conversation_mode'

# Idempotency: applying again on the same DB succeeds (no error, no diff)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/001_core_schema.up.sql

# Apply down
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/001_core_schema.down.sql

# Verify reverted: no app tables, no app enums
psql "$DATABASE_URL" -c "\dt" | grep -E 'users|sessions|vocab_cards' && echo "FAIL: tables still present" || echo "OK: tables dropped"
psql "$DATABASE_URL" -c "\dT" | grep -E 'fsrs_state|card_face' && echo "FAIL: enums still present" || echo "OK: enums dropped"

# Re-apply up: clean cycle
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/001_core_schema.up.sql
```

Extensions (`citext`, `pgcrypto`) intentionally remain after `down` — they're
database-global, not migration-owned. Re-running `up` is a no-op for them.

### Known gotchas

- The shared `set_updated_at()` function is defined in this migration and
  **must remain** as long as ANY later migration uses it. Migration 001's
  `down.sql` drops it last. If you write a later migration that adds a table
  with `updated_at` + trigger, do NOT redefine the function — reference the
  existing one.
- `vocab_cards.source_sentence_id` (and the other corpus-side IDs) is a typed
  `BIGINT` column with NO FK yet. A2 adds the FK. Until 002 is applied, the
  schema does not enforce that these IDs reference valid sentences. Loaders
  run after 002 — this is safe in practice.
- Enums are not extensible via `IF NOT EXISTS` in PG 16. The migration guards
  enum creation with `DO $$ … $$` blocks. Adding a value later =
  `ALTER TYPE … ADD VALUE … IF NOT EXISTS` in a follow-up migration.

---

## Migration 002: `darakwon_corpora` (A2)

### What it creates

1. New enum types: `content_domain`, `vocab_relation_type`, `kgiu_entry_type`,
   `vocab_entry_type`, `lets_check_parent_kind`.
2. Tables (dependency order):
   - `corpus_sources` — catalog of every ingested JSON file (Darakwon books here,
     TTMIK/Iyagi/TOPIK in later migrations).
   - `kgiu_entries` — raw KGIU source rows, all 3 levels unified (Beginner /
     Intermediate / Advanced). **Distinct from A1's `grammar_entries`** (which
     is the user-canonical layer). See ADR-008.
   - `kgiu_entry_relations` — directed FK cross-references between
     `kgiu_entries` rows (compare_with, parallel-level pointers, etc.).
   - `vocab_entries` — unified 2000-Words table (Beginner + Intermediate).
   - `vocab_entry_relations` — hybrid-target word↔word relations
     (synonym/antonym/passive/causative/etc.). See ADR-007.
   - `hanja_extensions` — "Korean through Chinese Characters" mind-maps.
   - `lets_check_exercises` — review-exercise pages with polymorphic parent
     (`kgiu_entry` xor `vocab_subsection`).
3. tsvector triggers and GIN indexes for full-text search on `kgiu_entries`
   and `vocab_entries`. Config: `simple` (Korean tokenization deferred to
   Phase B — see ADR-006).
4. Seeds `corpus_sources` with the 5 Darakwon corpora.
5. Adds the A1-reserved FK `fk_vocab_cards_vocab_entry`
   (`vocab_cards.vocab_entry_id` → `vocab_entries.id`, `ON DELETE RESTRICT`).

### Coordination with migration 001

- Reuses A1's `set_updated_at()` function — does NOT redefine.
- Reuses A1's enums `proficiency_level`, `corpus`, `book_level`, `register_level`.
- Adds the deferred FK A1 reserved on `vocab_cards.vocab_entry_id`.
- The down migration drops that FK BEFORE dropping `vocab_entries`, so 002
  can be rolled back independently of 001.

### Coordination with migration A3 (loader tooling)

- The loader populates volatile fields on `corpus_sources`:
  `extracted_by`, `extracted_at`, `version_tag`, `source_sha256`, `item_count`.
- The loader is the ONLY writer of `kgiu_entries`, `vocab_entries`,
  `hanja_extensions`, `lets_check_exercises`, and the seeded `corpus_sources`
  rows post-seed. Its DB role should have INSERT/UPDATE on these tables only
  (see SECURITY.md A2-7).
- Upsert key for entries: `(corpus, source_id)`. Loader should
  `INSERT … ON CONFLICT (corpus, source_id) DO UPDATE SET …`.

### ADRs that explain non-obvious choices

- `ADR-005` — stable columns vs JSONB for variable-shape Darakwon arrays.
- `ADR-006` — tsvector language configuration (`simple` for Phase A,
  Kiwi-aware for Phase B).
- `ADR-007` — hybrid target column on `vocab_entry_relations`
  (FK or text).
- `ADR-008` — `kgiu_entries` (source) vs `grammar_entries` (user-canonical).

### Security

See `SECURITY.md` — section "Darakwon corpora (migration 002) — A2"
enumerates loader-side SQL injection, JSONB injection / DoS, FTS DoS via
pathological queries, stored XSS via rendered JSONB, prompt injection into
Claude, reference-data tampering, and loader-role privilege drift.

### How to test (this migration specifically)

```bash
# Assume migration 001 has already been applied to a fresh DB.
export DATABASE_URL=postgres://localhost/korean_master_test

# Apply 002 (note -1: migration files don't own transactions — see ADR-013)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/002_darakwon_corpora.up.sql

# Smoke: every expected table and enum exists
psql "$DATABASE_URL" -c "\dt" | grep -E 'corpus_sources|kgiu_entries|kgiu_entry_relations|vocab_entries|vocab_entry_relations|hanja_extensions|lets_check_exercises'
psql "$DATABASE_URL" -c "\dT" | grep -E 'content_domain|vocab_relation_type|kgiu_entry_type|vocab_entry_type|lets_check_parent_kind'

# Seeded rows present
psql "$DATABASE_URL" -c "SELECT corpus, level FROM corpus_sources ORDER BY corpus;"
# Expected: kgiu_advanced/advanced, kgiu_beginner/beginner, kgiu_intermediate/intermediate,
#           vocab_2000_beginner/beginner, vocab_2000_intermediate/intermediate

# FK on vocab_cards was added
psql "$DATABASE_URL" -c "\d vocab_cards" | grep fk_vocab_cards_vocab_entry

# Idempotency: re-applying succeeds
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/002_darakwon_corpora.up.sql

# Apply down (drops 002's tables and the vocab_cards FK; leaves 001 intact)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/002_darakwon_corpora.down.sql

# Verify 002's tables are gone but 001's remain
psql "$DATABASE_URL" -c "\dt" | grep -E 'corpus_sources|kgiu_entries|vocab_entries' && echo "FAIL" || echo "OK"
psql "$DATABASE_URL" -c "\dt" | grep -E 'users|sessions|vocab_cards' || echo "FAIL: 001 tables gone"

# Re-apply 002: clean cycle
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
  -f db/migrations/002_darakwon_corpora.up.sql
```

### Known gotchas

- **Two grammar tables**. A1's `grammar_entries` is user-canonical; A2's
  `kgiu_entries` is the raw KGIU source. They are NOT interchangeable. Phase
  C will add a bridge. See `ADR-008-kgiu-vs-grammar-entries.md`.
- **`register` is TEXT, not the `register_level` enum**. Real KGIU data
  has composite values like "해요체/합쇼체", "문어체/구어체" that don't fit a
  closed-set enum. Loader can normalize later. See column comment.
- **`part_of_speech` is TEXT, not an enum.** Real 2000-Words data carries
  composite values like "noun, adverb". See column comment.
- **JSONB shape CHECKs**. Every JSONB column has a CHECK that enforces
  `jsonb_typeof(col) = 'array'`. The loader will fail loudly on bad shapes
  — that's intentional.
- **TSVECTOR config is `simple`.** Korean recall is imperfect until Phase
  B's Kiwi integration. The `ix_vocab_entries_korean` B-tree index is the
  precise-headword fallback. See ADR-006.

---

## Migration checksum drift — operator runbook

### When you'll see this

`make db-migrate` (or `python -m db.migrate up`) exits non-zero with a
`migrate.failed` structlog line whose `error` field reads:

```
migration NNN_<name>.up.sql has been modified since it was applied
(recorded=<sha12>…, current=<sha12>…). Revert the file or write a new
migration.
```

The exception type is `ChecksumMismatch` (see
`db/migrate.py` → `class ChecksumMismatch` and the raise site in
`cmd_migrate`). Exit code is **1** (validation failure). No SQL ran; the
runner refused to proceed before opening a write transaction.

### Why it exists

`migrate.py` stores a SHA-256 of each `*.up.sql` body in
`schema_migrations.checksum` at apply time and re-hashes the file before
every subsequent `up`. A mismatch means the file on disk drifted from what
was applied — usually an in-place edit to an already-applied migration. The
guard refuses to silently diverge the live schema from the recorded
history.

### Dev environment

Drop the database and re-apply from zero:

```bash
make db-reset      # drops + recreates the Postgres database
make db-migrate    # replays every migration with current file contents
```

**Data loss caveat:** `db-reset` destroys every row in the local database
(users, study_log, FSRS state, ingested corpora). Re-seed afterward with
the loader (`make ingest-darakwon` etc.) or accept an empty dev DB.

### Staging / production

#### Option A (preferred): Restore from backup + replay

Audit-friendly. Requires a known-good Postgres backup taken **before** the
in-place edits landed.

```bash
# 1. Stop the app (so no writes race the restore)
sudo systemctl stop korean-master   # or: docker compose stop app

# 2. Restore the pre-drift backup
#    Replace <BACKUP>.dump with the snapshot taken before the bad edit.
pg_restore --clean --if-exists \
    -d "$DATABASE_URL" /var/backups/korean-master/<BACKUP>.dump

# 3. Replay forward with the current migration files
make db-migrate     # equivalent to: python -m db.migrate up

# 4. Sanity check, then restart
python -m db.migrate status
sudo systemctl start korean-master
```

The replayed checksums now match the on-disk files; `schema_migrations`
reflects reality.

#### Option B (fallback): Manually update checksum

Only when Option A is infeasible (no backup, or the data delta since the
backup is unacceptable to lose). **The schema must already match what the
edited migration would produce** — if it doesn't, you're papering over
genuine drift and the next migration may fail in production.

```bash
# 1. Compute the diff between recorded SQL and current file. There is no
#    recorded SQL on disk — compare against git history for the file.
git log --all --oneline -- db/migrations/NNN_<name>.up.sql
git diff <pre-edit-sha>..HEAD -- db/migrations/NNN_<name>.up.sql

# 2. Confirm the live schema already reflects the post-edit form.
#    (Inspect tables/columns/indexes the edit touched via psql \d.)
psql "$DATABASE_URL" -c "\d+ <affected_table>"

# 3. Compute the new checksum (matches migrate.py's algorithm: sha256 of
#    the up.sql body as UTF-8 bytes).
sha256sum db/migrations/NNN_<name>.up.sql

# 4. Update the bookkeeping row. Wrap in a tx so a typo can be rolled back.
psql "$DATABASE_URL" <<SQL
BEGIN;
UPDATE schema_migrations
   SET checksum = '<new_sha256_hex>'
 WHERE version = 'NNN';
-- Verify exactly one row updated before committing:
SELECT version, name, checksum, applied_at, applied_by
  FROM schema_migrations WHERE version = 'NNN';
COMMIT;
SQL

# 5. Re-run migrate to confirm the guard is satisfied.
python -m db.migrate status
make db-migrate
```

**Audit log requirement.** Record in the ops journal: who ran the update,
when, the version, the old + new checksum (first 12 chars is fine), the
reviewer who verified the schema matched, and the link to the original PR
or commit that edited the migration.

### Decision tree

| Scenario | Option |
|---|---|
| Dev / local | `make db-reset` + `make db-migrate` |
| Staging with backup | Option A |
| Prod with backup | Option A |
| Prod without backup | Option B + audit log entry |

### Going forward

Prefer **forward migrations** (`NNN+1_fix_<thing>.up.sql`) over in-place
edits to already-applied migrations. The Phase C fix-pass edited 006, 008,
and 009 in place — that's the maneuver that triggered this runbook and
should not be repeated outside a coordinated environment-wide drop. In-place
edits are acceptable only in dev, or when every environment that applied
the prior version is dropped and replayed in the same change.

## Migration 013: `writing_prompts` (P4)

### What it creates

A single reference table `writing_prompts` — a curated, shared (not per-user)
bank of writing prompts spanning the `proficiency_level` bands (`L3`/`L4`/`L5+`)
and Korean speech-level registers (`해요체`, `합쇼체`, `문어체`). The `.up.sql`
seeds 8 starter prompts inline with `ON CONFLICT (source_id) DO NOTHING`, so
re-applying after a partial failure neither duplicates nor errors.

### Why it exists

Pass 4 lights up the Today screen. Its `GET /plan/today` endpoint composes the
day's plan from existing tables (`vocab_cards` for the due count, `ttmik_lessons`
for reading, `iyagi_episodes` for listening) — the one branch with no existing
source is **Writing**. The integration plan allowed either inline route literals
or a seed table; the table wins because it is testable in isolation, keeps the
band-weighted selection SQL identical in shape to the reading/listening branches,
and gives the Pass-8 Writing drill screen real rows to grow rubric metadata onto.

### Reference data, not user state

No `user_id` FK, no `deleted_at`. Prompts are retired non-destructively via
`is_active = FALSE` (selection queries filter `WHERE is_active`), so a prompt
already surfaced in a user's history is never hard-deleted out from under a
future audit/log row.

### How to test (this migration specifically)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 013_writing_prompts.up.sql
psql "$DATABASE_URL" -c "SELECT count(*) FROM writing_prompts WHERE is_active;"   -- expect 8
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 013_writing_prompts.up.sql          -- re-run = no-op
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 013_writing_prompts.down.sql        -- requires --allow-destructive via migrate.py
```

## Migration 014: `diagnostic_runs` (P5A)

### What it creates

Two parent/child tables that back the live, server-graded, CAT-lite Diagnostic
screen (Pass 5):

- `diagnostic_runs` — one row per started diagnostic *session*. Holds the
  running CAT ability estimate (`ability_estimate`, θ on the 0–6 TOPIK scale),
  the intended item count (`target_item_count`, default 8), lifecycle `status`
  (`in_progress` → `finished`), and a soft FK (`snapshot_id`) to the
  `diagnostic_snapshots` row produced on finish.
- `diagnostic_responses` — one row per *item served* within a run. Holds the
  served-item difficulty, kind, source (`topik` vs `generated`), the full
  server-side `item_payload` JSONB, and — critically — the **column-private
  `correct_answer`**, plus the user's `picked` choice and `is_correct` verdict.

### Why it exists

Pass 5 turns the Diagnostic screen from a client-graded mock into a real,
adaptive, server-graded flow. The finished result still lands in
`diagnostic_snapshots` (migration 001) — these two tables are the *transient run
machinery* in front of that durable snapshot. A run is hard-deleted with the
user (in-flight runs have no standalone audit value); the snapshot is
soft-deleted and survives, and `snapshot_id` is `ON DELETE SET NULL` so dropping
a snapshot never destroys run history.

### The security property (why `correct_answer` is a column)

`correct_answer` lives in `diagnostic_responses` as a column the client NEVER
receives. The route assembles an answer-stripped `ClientItem` (no
`correct_answer`, no `explain`) for the wire; grading compares the user's pick
against this column server-side; the correct choice + explanation are revealed
only in the `/answer` response *after* the user has committed a pick. This is
the answer-tampering defense — see `server/SECURITY.md` §13.

### Reference vs run state

`diagnostic_runs` / `diagnostic_responses` are per-user run state (FK to `users`,
hard-deleted on user delete). They are NOT reference data and carry no
`deleted_at`. The durable, soft-deleted record is `diagnostic_snapshots`.

### How to test (this migration specifically)

```bash
# Assume migrations 001..013 already applied to a fresh DB.
export DATABASE_URL=postgres://localhost/korean_master_test

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 014_diagnostic_runs.up.sql

# Smoke: both tables + the user/snapshot FKs exist
psql "$DATABASE_URL" -c "\dt" | grep -E 'diagnostic_runs|diagnostic_responses'
psql "$DATABASE_URL" -c "\d diagnostic_runs"      | grep -E 'fk_diagnostic_runs_user|fk_diagnostic_runs_snapshot'
psql "$DATABASE_URL" -c "\d diagnostic_responses" | grep -E 'fk_diagnostic_responses_run|uq_diagnostic_responses_run_ordinal'

# Idempotency: re-applying succeeds (CREATE TABLE IF NOT EXISTS)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 014_diagnostic_runs.up.sql

# Apply down (drops the two tables; leaves 001's diagnostic_snapshots/users)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 014_diagnostic_runs.down.sql   -- --allow-destructive via migrate.py

# Verify reverted but 001 intact
psql "$DATABASE_URL" -c "\dt" | grep -E 'diagnostic_runs|diagnostic_responses' && echo "FAIL" || echo "OK"
psql "$DATABASE_URL" -c "\dt" | grep -E 'diagnostic_snapshots|users' || echo "FAIL: 001 tables gone"
```

## Migration 015: `topik_responses` (P6A)

### What it creates

A single table `topik_responses` — an **append-only** log of graded TOPIK Prep
answers. One row is written per answer the user submits via
`POST /topik/:itemId/answer` (Pass 6, TOPIK Prep Study mode going live + the
Mock-Test server route). It powers accuracy / weak-area analytics over the
public `topik_items` pool.

### Why append-only (a log, not per-item state)

TOPIK Prep is a drill: a user may re-attempt the same item many times. Each
attempt is a **new row** with its own `answered_at`, `picked`, and `is_correct`
— the route never UPDATEs an existing response. Duplicate
`(user_id, topik_item_id)` pairs are therefore expected and intended. Analytics
("accuracy over time", "most-missed items") read the full history; collapsing to
one mutable row per (user, item) would destroy that. There is consequently no
optimistic-concurrency write path and no `deleted_at` — the audit columns
(`created_at`/`updated_at`/`version`) are present only for schema consistency
with every other entity table (ADR-001 §D6).

### FK posture

- `user_id` → `users(id)` **ON DELETE CASCADE** — a response belongs to its user
  and has no value detached from them; purging the account purges the log.
- `topik_item_id` → `topik_items(id)` **ON DELETE RESTRICT** — `topik_items` is
  curated reference data (migration 005). RESTRICT stops a corpus item a learner
  has already answered from being hard-deleted out from under its responses.
  Mirrors the existing reference-data FK posture (`vocab_cards.topik_item_id`,
  `vocab_list_entries.entry_id`).

### Constraints

`picked` is TEXT + `CHECK (picked IN ('a','b','c','d'))`; `mode` is TEXT +
`CHECK (mode IN ('study','mock'))` defaulting to `'study'`; `time_ms` is the lone
nullable non-audit column (NULL = unknown, distinct from 0) with
`CHECK (time_ms IS NULL OR time_ms >= 0)`. Two indexes:
`ix_topik_responses_user_item` (per-(user, item) attempt lookups) and
`ix_topik_responses_user_answered_at` (recent-answers feed, `answered_at DESC`).

### Reference vs user state

`topik_responses` is per-user state (FK to `users`, CASCADE). It is NOT reference
data. The thing it points at — `topik_items` — is the reference data, hence the
RESTRICT back-reference.

### How to test (this migration specifically)

```bash
# Assume migrations 001..014 already applied to a fresh DB.
export DATABASE_URL=postgres://localhost/korean_master_test

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 015_topik_responses.up.sql

# Smoke: table + both FKs + both indexes exist
psql "$DATABASE_URL" -c "\dt" | grep -E 'topik_responses'
psql "$DATABASE_URL" -c "\d topik_responses" | grep -E 'fk_topik_responses_user|fk_topik_responses_topik_item'
psql "$DATABASE_URL" -c "\d topik_responses" | grep -E 'ix_topik_responses_user_item|ix_topik_responses_user_answered_at'

# Idempotency: re-applying succeeds (CREATE TABLE IF NOT EXISTS)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 015_topik_responses.up.sql

# Apply down (drops the table; leaves 005's topik_items and 001's users)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 015_topik_responses.down.sql   -- --allow-destructive via migrate.py

# Verify reverted but 005/001 intact
psql "$DATABASE_URL" -c "\dt" | grep -E 'topik_responses' && echo "FAIL" || echo "OK"
psql "$DATABASE_URL" -c "\dt" | grep -E 'topik_items|users' || echo "FAIL: 005/001 tables gone"
```

## Migration 016: `hanja` (P7A)

### What it creates

Three tables that take the **Hanja screen** live (Pass 7), plus one enum
extension:

- `hanja_characters` — the hanja reference corpus, one row per Korean hanja
  (built by `tools/ingest/build_hanja.py` from the vocab corpora + the Unihan
  database, written to `tools/ingest/output/hanja.json`, 758 characters). Shared
  reference data: no `user_id`, no `deleted_at`. Reloads retire-by-overwrite
  (`ON CONFLICT (char) DO UPDATE`).
- `hanja_compounds` — words that contain a character (child of
  `hanja_characters`, `ON DELETE CASCADE`). `UNIQUE (character_id, word_kr)` is
  the reload upsert target.
- `hanja_progress` — **per-user** new/practicing/banked state (FK to `users`,
  CASCADE). `UNIQUE (user_id, char)` is the UPSERT target for
  `POST /hanja/:char/state`.
- `ALTER TYPE corpus ADD VALUE IF NOT EXISTS 'hanja'` — the corpus loader
  (`load_hanja.py`) reuses the shared `upsert_corpus_source` /
  `get_or_create_checkpoint` helpers, both of which cast the corpus name
  `::corpus`. `'hanja'` is not one of the 001 enum values, so the migration adds
  it.

### The `corpus` enum extension (the one schema gotcha)

`ALTER TYPE … ADD VALUE` can run inside a transaction on **PostgreSQL 12+** (our
target is `postgres:16-alpine`), so the runner-owned transaction (ADR-013) is
fine. The only residual PG caveat — *a newly added enum value cannot be USED in
the same transaction that added it* — does not apply: this migration never
inserts a `'hanja'` corpus row. The loader writes that row later, in a separate
process and transaction, well after 016 has committed. The guard
(`ADD VALUE IF NOT EXISTS`) makes re-applying a no-op, mirroring migration 002's
`kgiu_entry_type` / `vocab_entry_type` extensions.

The down migration deliberately does **not** remove the enum value — PostgreSQL
has no `ALTER TYPE … DROP VALUE`. Leaving the value is harmless (nothing
references it once the loader's `corpus_sources` row is gone) and re-applying up
is a no-op. The schema after `down` is a superset of where it started, which is
the same stance migration 002 takes for its own `ADD VALUE` additions.

### Why `hanja_progress.char` is TEXT, not a FK

Progress must SURVIVE a corpus reload. `build_hanja.py` re-derives the character
set from the vocab corpora; a future rebuild could drop a character a user had
already banked. A FK with `ON DELETE CASCADE` would silently erase that progress
on reload; `ON DELETE RESTRICT` would block the reload. Keying progress on the
character TEXT (validated to one hanja codepoint by the route) decouples the two
so user state is durable. An orphan progress row (a char no longer in the
corpus) simply never surfaces — the list endpoint LEFT JOINs *from*
`hanja_characters`.

### Reference vs user state

`hanja_characters` / `hanja_compounds` are shared reference data (no `user_id`,
retire-by-overwrite, no soft delete). `hanja_progress` is per-user state (FK to
`users`, CASCADE, no `deleted_at` — clearing progress is a delete).

### How to test (this migration specifically)

```bash
# Assume migrations 001..015 already applied to a fresh DB.
export DATABASE_URL=postgres://localhost/korean_master_test

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 016_hanja.up.sql

# Smoke: 'hanja' is now a corpus enum value
psql "$DATABASE_URL" -c "SELECT 'hanja'::corpus;"   -- must not error

# Smoke: tables + key constraints/indexes exist
psql "$DATABASE_URL" -c "\dt" | grep -E 'hanja_characters|hanja_compounds|hanja_progress'
psql "$DATABASE_URL" -c "\d hanja_compounds" | grep -E 'fk_hanja_compounds_character|uq_hanja_compounds_character_word'
psql "$DATABASE_URL" -c "\d hanja_progress"  | grep -E 'fk_hanja_progress_user|uq_hanja_progress_user_char'

# Idempotency: re-applying succeeds (CREATE TABLE IF NOT EXISTS + ADD VALUE IF NOT EXISTS)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 016_hanja.up.sql

# Apply down (drops the three tables; leaves the corpus enum value + 001/002)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 016_hanja.down.sql   -- --allow-destructive via migrate.py

# Verify reverted but 001/002 intact (and the enum value persists by design)
psql "$DATABASE_URL" -c "\dt" | grep -E 'hanja_characters|hanja_compounds|hanja_progress' && echo "FAIL" || echo "OK"
psql "$DATABASE_URL" -c "\dt" | grep -E 'users|corpus_sources' || echo "FAIL: 001/002 tables gone"
```

## Migration 017: `image_captures` (P8A)

### What it creates

Two parent/child tables that take the **Images screen** live (Pass 8 — image
OCR mining):

- `image_captures` — **per-user**, one row per photo the user uploaded, plus its
  OCR caption (`caption_kr` / `caption_en`) and the stored-blob metadata
  (`mime`, `byte_size`, `blob_path`). FK to `users` (`ON DELETE CASCADE`).
  **Soft-deleted** (`deleted_at`) because a capture is the user's mining history
  — a deferred "added to vocab from capture #N" audit row would reference it.
- `image_words` — the distinct CONTENT words Claude Vision transcribed from the
  capture (`kr`, `en`, `gloss`, `pos`, plus a detection `ordinal`). Child of
  `image_captures` (`ON DELETE CASCADE`). `UNIQUE (capture_id, ordinal)` keeps
  the word list in a stable order. **No bounding-box columns** (see below).

### The "no bounding boxes" decision

Claude Vision returns reliable word transcription + glosses but NOT precise
coordinates, so the OCR result carries no `box` field. The client renders the
real photo plus a tappable word LIST (not a coordinate overlay). `image_words`
therefore stores only the word + its glosses + an ordinal — never geometry. This
is the locked product decision recorded in `PASS8_CONTRACT.md` §A.

### Why `blob_path` is relative (not absolute)

`blob_path` is a path RELATIVE to the configured store root
(`IMAGE_STORAGE_DIR`), e.g. `42/<uuid>.png`. The server joins it with the root
and asserts the resolved path stays under the root (path-traversal guard in
`server/src/services/imageStore.ts`). Storing it relative keeps rows portable if
the root moves (filesystem today, S3 later — `server/SECURITY.md` §16) and means
the DB never holds a host-specific absolute path. The filename component is a
server-generated UUID — never client input — so the path is injection-free.

### Reference vs user state

Both tables are per-user state (FK chain to `users`, CASCADE). `image_captures`
is soft-deleted (historical value); `image_words` is hard-deleted with its
parent (no standalone audit value, and CASCADE handles account deletion).
Neither is reference data.

### How to test (this migration specifically)

```bash
# Assume migrations 001..016 already applied to a fresh DB.
export DATABASE_URL=postgres://localhost/korean_master_test

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 017_image_captures.up.sql

# Smoke: both tables + the user FK + the word FK + the key constraints/indexes
psql "$DATABASE_URL" -c "\dt" | grep -E 'image_captures|image_words'
psql "$DATABASE_URL" -c "\d image_captures" | grep -E 'fk_image_captures_user|ix_image_captures_user_created|ck_image_captures_mime'
psql "$DATABASE_URL" -c "\d image_words"    | grep -E 'fk_image_words_capture|uq_image_words_capture_ordinal|ix_image_words_capture'

# Idempotency: re-applying succeeds (CREATE TABLE IF NOT EXISTS)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 017_image_captures.up.sql

# Apply down (drops the two tables; leaves 001's users)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 017_image_captures.down.sql   # --allow-destructive via migrate.py

# Verify reverted but 001 intact (blob files on disk are NOT removed — see down.sql note)
psql "$DATABASE_URL" -c "\dt" | grep -E 'image_captures|image_words' && echo "FAIL" || echo "OK"
psql "$DATABASE_URL" -c "\dt" | grep -E 'users' || echo "FAIL: 001 tables gone"
```
