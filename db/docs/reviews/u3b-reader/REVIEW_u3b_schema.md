# Review: U3b schema — `044_reading_chapters.{up,down}.sql`

**Reviewer posture:** independent, did not write this code. Schema-only review
per the request; server routes / client / loader are out of scope.

**Files reviewed:**
- `db/migrations/044_reading_chapters.up.sql`
- `db/migrations/044_reading_chapters.down.sql`

**Read for context:** `db/docs/U3_READER_DESIGN.md` §U3b, `db/docs/ADR-013-migration-tx-ownership.md`,
`db/docs/ADR-004-soft-fk-to-corpus.md`, `db/migrations/README.md`, `db/migrations/040_book_uploads.up.sql`,
`db/migrations/041_book_pages.{up,down}.sql`, plus precedent `ALTER TABLE ADD CONSTRAINT` usage in
`002_darakwon_corpora.up.sql`, `022_user_mined_vocab.up.sql`, `029_topik_tests_level_unique.up.sql`,
`038_writing_attempts.up.sql`, and `db/migrate.py` (`cmd_migrate`, `apply_one`, `discover_migrations`).

---

## Summary verdict

**APPROVE, no BLOCKERs.** The core design — a composite FK
`(source_upload_id, user_id) → book_uploads(id, user_id)` backed by a new
`UNIQUE(id, user_id)` on `book_uploads` — is sound, correctly guarantees
`reading_chapters.user_id` always equals the true owner of the source upload
(no way to insert an inconsistent pair, and both FK columns are `NOT NULL` so
the classic `MATCH SIMPLE` NULL-bypass doesn't apply), and correctly chains
`ON DELETE CASCADE` two levels deep (`users → book_uploads → reading_chapters
→ reading_passages`, all four hops verified). Constraints match the design
doc's contract exactly (body 1..20000, page-span `end_page >= start_page`,
positivity, title 1..500, `version >= 1`). ADR-013 is respected in both files
(no real top-level tx-control statements — only comments mention the words).
`down.sql` reverses `up.sql` completely and in the correct dependency order,
restoring `book_uploads` to its exact pre-044 shape.

There is **1 SHOULD-FIX** with real (if narrow) operational bite — `up.sql`'s
`ADD CONSTRAINT uq_book_uploads_id_user` is not re-apply-safe, unlike every
other statement in the same file and unlike its own `down.sql`'s
`DROP CONSTRAINT IF EXISTS` counterpart — plus a handful of smaller
SHOULD-FIX/NIT documentation and defense-in-depth gaps. None of them threaten
data integrity or block the migration from running correctly once, forward or
back.

## Findings by category

- **BLOCKER:** 0
- **SHOULD-FIX:** 3
- **NIT:** 4
- **PRAISE:** 5

---

## Detailed findings

### SHOULD-FIX

**SF-1 — `ADD CONSTRAINT uq_book_uploads_id_user` has no re-apply guard, unlike its own down-migration counterpart.**
`044_reading_chapters.up.sql:70-71`:
```sql
ALTER TABLE book_uploads
    ADD CONSTRAINT uq_book_uploads_id_user UNIQUE (id, user_id);
```
Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. Every other statement in this
file is re-apply-safe (`CREATE TABLE IF NOT EXISTS` ×2, `CREATE OR REPLACE
TRIGGER` ×2), and `down.sql:26` guards the matching drop with `DROP CONSTRAINT
IF EXISTS` — so the pair is asymmetric: the down side tolerates being run
twice, the up side doesn't. Running `044.up.sql` a second time against a
database where it already succeeded (the exact scenario `README.md`'s
per-migration test docs for 001/002/013–017 exercise explicitly, e.g.
`README.md:311-313` re-running `002_darakwon_corpora.up.sql` back-to-back with
no `down` in between) raises `ERROR: constraint "uq_book_uploads_id_user" for
relation "book_uploads" already exists`.

Mitigating context: under the real deploy path (`db/migrate.py:445-481
cmd_migrate` / `pending = [m for m in migrations if m.version not in
applied]`), an already-applied migration is never re-executed — this is a
manual-`psql`-runbook risk, not a live production risk. It's also not unique
to 044: `029_topik_tests_level_unique.up.sql` (raw `DROP
CONSTRAINT`/`ADD CONSTRAINT`, no guard) and
`038_writing_attempts.up.sql:32-34` (raw `ADD CONSTRAINT`, no guard) show the
same gap, so this looks like drift in house convention rather than a 044-only
regression — but 002's precedent (`002_darakwon_corpora.up.sql:950-960`, a
`DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …) …
END $$` guard) shows the codebase has an established idiom for exactly this,
and 044 is well-positioned to use it since — unlike 029/038 — it's adding a
constraint to a table it doesn't own (cross-table coordination, the same
shape 002 was solving).

**SF-2 — Migration 044 (and 040/042/043 before it) is missing from
`README.md`'s "Migration list" table and has no dedicated `## Migration 044`
narrative section.**
`db/migrations/README.md:10-31` — the table's last row is `| 041 |
book_pages | …`. Migrations 042, 043, 044 have no row. The file's own header
(`README.md:7-8`) says: *"If you're adding a section for a later migration,
APPEND below — do not overwrite existing sections."* Every migration through
017 gets both a table row and a full narrative section (What it creates / Why
/ How to test). 044's `.up.sql` header comment is thorough and largely
substitutes for the narrative (design rationale, dependency notes), but there
is no row in the summary table and no queryable "how to test this migration"
recipe analogous to the ones given for 001/002/013-017. Since 040/042/043
already skipped this, it's a pre-existing gap 044 inherits rather than
introduces — but it's squarely the kind of thing this review is asked to
check compliance against, so flagging it here rather than silently
inheriting the debt.

**SF-3 — No schema-level guard that `source_upload_id` points at a
`'literature'`-typed `book_uploads` row.**
`044_reading_chapters.up.sql:97-103` — the composite FK guarantees
`user_id` correctness but says nothing about `book_uploads.type`. Nothing
stops a `reading_chapters` row from being attached to a `'vocab'`,
`'grammar'`, `'both'`, or `'dialogue'`-typed upload (`book_upload_type` enum,
`040_book_uploads.up.sql:49`), even though the design doc and every comment
in this migration describe chapters as belonging to literature books only
(`U3_READER_DESIGN.md:57`, `044_reading_chapters.up.sql:25-30`). A plain
`CHECK` can't reach across tables; enforcing this in SQL would need a
`BEFORE INSERT/UPDATE` trigger with a subquery to `book_uploads.type`, which
is a real maintenance cost for a rule the loader (`load_literature.py`, not
yet written) can trivially enforce by construction (it only ever loads
chapters for uploads it processed as literature). I'd call this an
acceptable trade-off, not a blocker — but it's worth a one-line
`COMMENT ON CONSTRAINT` or code comment flagging that the invariant is
enforced by the loader/route layer, not the DB, so a future reader doesn't
assume the FK covers more than it does.

### NIT

**N-1 — `reading_chapters.source_upload_id` has no `COMMENT ON COLUMN`
despite being the single most non-obvious design choice in the table.**
`044_reading_chapters.up.sql:121-140` comments `chapter_number`, `user_id`,
and `start_page`, but not `source_upload_id` itself — the column whose
`NOT NULL` + `CASCADE` posture is a deliberate departure from the nullable
`SET NULL` pattern `vocab_entries.source_upload_id` uses
(`040_book_uploads.up.sql:141-147`). That rationale currently lives only in
the migration file's header prose (lines 25-30), which isn't visible to
someone running `\d+ reading_chapters` in `psql`. Recommend porting a
shortened version of the "why NOT NULL + CASCADE" rationale into a
`COMMENT ON COLUMN reading_chapters.source_upload_id`.

**N-2 — `reading_chapters.end_page` has no `COMMENT ON COLUMN`, inconsistent
with `start_page` getting one.**
`044_reading_chapters.up.sql:137-140` comments `start_page` (including the
"advisory, not FK'd" rationale) but not `end_page`, even though they're a
matched pair with identical positivity/advisory semantics. Minor, but an
easy one-liner to add for symmetry.

**N-3 — `reading_passages.page_number` has no `COMMENT ON COLUMN` at all.**
`044_reading_chapters.up.sql:182-191` — the table comment and the `body`
column comment are present, but `page_number` (the column with the least
obvious behavior in this table — "advisory, not FK'd because
`book_pages.page_number` is mutable," per the header at lines 50-56) has no
column-level comment. Same class of gap as N-1/N-2: the rationale is real and
well-reasoned, it's just not attached to the column where a future reader
would look for it.

**N-4 — `CASCADE`-on-book-delete destroys curated OCR text that the project's
own notes describe as expensive to redo, with no soft-delete or app-level
confirmation gate visible at the schema layer.**
`044_reading_chapters.up.sql:100-103` (and `book_uploads` itself being
hard-deleted per `040_book_uploads.up.sql:19-24`, no `deleted_at`). This is
explicitly the documented design decision (`U3_READER_DESIGN.md:60-61`:
"Deleting the book deletes its chapters (ON DELETE CASCADE)... meaningless
once its source book is gone") and the migration's own down-migration comment
calls it out as "LOSSY by design... re-derivable by re-uploading the book and
re-running `tools/ingest/load_literature.py`" (`044.down.sql:3-7`). Given the
design doc separately describes literature OCR as "a semi-manual subscription
curation pass" (`U3_READER_DESIGN.md:92`), "re-derivable" understates the
actual cost of a `DELETE FROM book_uploads` mistake — it's not a free re-run,
it's redoing curation labor. Not a schema defect (the schema faithfully
implements what was decided), but worth flagging as a product-risk note for
whoever builds the `DELETE /uploads/:id` route in U3b/U3c: a confirmation
step ("this will delete N chapters / M passages of curated text") belongs at
the route or client layer since the schema has no soft-delete to fall back
on here.

### PRAISE (fix-pass must not undo)

**P-1 — The composite FK genuinely closes the integrity hole it claims to.**
`044_reading_chapters.up.sql:70-71, 97-103`: `UNIQUE(id, user_id)` on
`book_uploads` (harmless — `id` is already the PK, so it can never reject a
real row, it only makes `(id, user_id)` referenceable) plus
`FOREIGN KEY (source_upload_id, user_id) REFERENCES book_uploads(id,
user_id)` makes it structurally impossible to insert a `reading_chapters` row
whose `user_id` doesn't match its `source_upload_id`'s true owner — verified
by construction (id is unique, so exactly one `book_uploads` row can satisfy
the reference, and its `user_id` is pinned). Both FK columns are `NOT NULL`,
so the classic `MATCH SIMPLE` NULL-bypass pitfall doesn't apply either. This
is correct, minimal, and exactly the right tool for the stated goal.

**P-2 — Multi-hop CASCADE chain verified end-to-end, including through
`users`.**
Confirmed the full chain: `users` → `book_uploads` (`fk_book_uploads_user`,
`ON DELETE CASCADE`, `040_book_uploads.up.sql:82-84`) → `reading_chapters`
(`fk_reading_chapters_upload_owner`, `ON DELETE CASCADE`,
`044.up.sql:100-103`) → `reading_passages` (`fk_reading_passages_chapter`,
`ON DELETE CASCADE`, `044.up.sql:167-169`). Deleting a user, or deleting a
book upload, correctly and transitively cleans up every chapter and passage
without any direct `reading_chapters → users` FK needed. Clean design.

**P-3 — `page_number`/`start_page` NOT being hard-FK'd to `book_pages` is a
defensible, precedent-consistent call, not a shortcut.**
`044.up.sql:50-56, 137-140, 176-177, 188-191` vs.
`041_book_pages.up.sql:26-34` (the reorder tool's two-phase negative-
placeholder dance to avoid tripping `uq_book_pages_upload_number` mid-
permutation). A hard composite FK with `ON UPDATE CASCADE` here would very
plausibly break during that intermediate negative-placeholder step (CHECK
constraints on the referencing table are validated immediately, not
deferred), and the "advisory pointer, not FK'd" pattern already exists
elsewhere in this schema for the same reason (`kgiu_entries.source_pages`,
cited directly in the migration's own rationale). Good call, and good that
it's spelled out rather than left implicit.

**P-4 — Self-contained migration avoids the ADR-004 cross-migration
coordination burden entirely.**
Unlike `vocab_cards`'s deferred FK (ADR-004, split across migrations 001 and
002 because 002's tables didn't exist yet), 044 adds the `UNIQUE(id,
user_id)` and the composite FK that depends on it in the *same* migration,
in the correct order (`up.sql:70-71` before `up.sql:97-103`). No
reserved-constraint-name coordination, no "migration N+1 must drop this
before migration N's down runs" bookkeeping. Simpler and less error-prone
than it had to be.

**P-5 — `down.sql` drop order is correct and each statement is independently
re-apply-safe.**
`044.down.sql:17,21,26` — `reading_passages` (child) dropped before
`reading_chapters` (parent, whose drop also removes the FK referencing
`book_uploads`) before the now-unreferenced `UNIQUE` constraint on
`book_uploads`. All three use `IF EXISTS`, so — modulo SF-1's asymmetry with
`up.sql` — the down side of this migration is fully idempotent on its own.
`book_uploads` is verifiably restored to its exact pre-044 shape (no other
`book_uploads` columns were touched by `up.sql`, so there's nothing else for
`down.sql` to undo).

---

## Coordination observations

- **README debt is pre-existing, not introduced by 044.** Migrations 040,
  042, and 043 are also absent from `README.md`'s migration table — 044
  didn't create this gap, it inherited it. Whoever picks up SF-2 should
  probably backfill 040/042/043's rows in the same pass rather than leaving
  044 as an odd one out with a row and its three predecessors without one.
- **SF-1's guard idiom already exists in this codebase** (`002_darakwon_
  corpora.up.sql:950-960`) and is a small, mechanical fix — wrap the
  `ADD CONSTRAINT` in the same `DO $$ IF NOT EXISTS (SELECT 1 FROM
  pg_constraint WHERE conname = 'uq_book_uploads_id_user') THEN … END IF;
  END $$;` shape. Doing this for 044 without doing it for 029/038 leaves the
  repo in a "some do, some don't" state; worth a follow-up ticket to sweep
  029/038 too rather than treating 044 as the only offender.
- **No conflict with 041's `book_pages` rework.** Because `start_page`/
  `page_number` are advisory (not FK'd), rolling back 041 independently of
  044 (an unusual but not-impossible operator sequence) would not raise a
  dependency error — a nice side-effect of the P-3 design choice, not
  something that needed to be engineered separately.
