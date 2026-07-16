# Independent Review — F-199 Migration + Backfill (070_vocab_cards_source_upload)

Reviewer: independent senior review (migration/backfill scope only).
Branch: `feature/f199-per-user-provenance`
Scope: `db/migrations/070_vocab_cards_source_upload.{up,down}.sql`, `db/tests/test_migration_070.py`, README ledger line.
Test run: **executed** `db/tests/test_migration_070.py` in the pinned `python:3.12` container per `Deploy/local-test.sh`'s `db_suite` recipe (deps `psycopg[binary]==3.2.3`, `structlog==24.4.0`, `testcontainers[postgres]>=4,<5`, `pytest>=8,<10`; testcontainer `postgres:16-alpine`). Result: **9 passed in 9.53s**.

---

## Summary verdict

**PASS — 0 BLOCKERS, 1 SHOULD-FIX (test-only), 3 NITs.**

The backfill — the highest-risk part of this change — is correct. The ownership predicate is airtight: a tag is copied onto a card only when the tagged upload's `book_uploads.user_id` equals the card's `user_id`, joined through the entry's primary key so at most one source row can match (no `UPDATE ... FROM` multi-match nondeterminism). Cross-user mis-attribution — the exact bug F-199 exists to fix — is structurally impossible in this UPDATE, and the tests prove both directions (owner-matched tag copied; cross-user tag dropped to NULL). The one gap is that the fill-only/no-overwrite guard (`c.source_upload_id IS NULL`) is claimed in the header but never exercised by a test against a table that already carries non-NULL card tags.

---

## Bar checklist

| Requirement | Status | Evidence |
|---|---|---|
| Additive / expand-contract on shared live DB | PASS | Nullable `ADD COLUMN`, fill-only backfill; no rewrite, no drop on up (up.sql:47-50, 102-110) |
| Nullable FK → `book_uploads`, `ON DELETE SET NULL`, named | PASS | `fk_vocab_cards_source_upload ... ON DELETE SET NULL ON UPDATE RESTRICT` (up.sql:49-50) — exact mirror of 068 (068.up.sql:41-42) |
| Partial index | PASS | `ix_vocab_cards_source_upload ... WHERE source_upload_id IS NOT NULL` (up.sql:66-68) |
| F-088 markers correct | PASS | up:1 `-- migrate: non-destructive` (correct: ADD COLUMN + CREATE INDEX + fill-only UPDATE); down:1 `-- migrate: destructive` (correct: DROP COLUMN evades the legacy keyword sniff — declared explicitly). Both asserted in test_migration_070.py:237-247 and behaviorally at :250-254, :429-435 |
| Idempotent (`IF NOT EXISTS`) | PASS | `ADD COLUMN IF NOT EXISTS` (up.sql:48), `CREATE INDEX IF NOT EXISTS` (up.sql:66), backfill guarded fill-only (up.sql:110); down uses `IF EXISTS` on both drops (down.sql:15, 19) |
| Up + down present, reversible | PASS | down drops index then column (FK + COMMENT go with the column); round-trip proven over populated tables (test :465-505) |
| Backfill (1): ownership join correct, set-based, idempotent | PASS (see SF-1 on the idempotency *proof*) | up.sql:102-110; single set-based UPDATE, no loops, no procedural code |
| Backfill (2): no cross-user mis-attribution | PASS — proven | test :318-368 (`card_b` stays NULL on A-tagged shared entry), :371-408 (`soft_deleted` A-card on B-tagged entry stays NULL) |
| Backfill (3): mis-attributed shared tags DROPPED (NULL, not wrong tag) | PASS — proven | same tests; the guard `bu.user_id = c.user_id` (up.sql:109) makes the cross-user row match nothing |
| Backfill (4): NULL safety | PASS — proven | `ve.source_upload_id IS NOT NULL` (up.sql:108) + inner JOIN to `book_uploads`; test `card_plain` (:345-346, :359). Belt-and-braces: 040's FK is itself `ON DELETE SET NULL`, so dangling entry tags cannot exist anyway |
| Tests prove owner-match copy / mismatch drop / up-down / re-up | PASS | tests 3.x and 4.x; re-up re-derives the tag (:500-505) |

---

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
- **SF-1 (test gap): the fill-only/no-overwrite guard is never exercised in a state where it matters.** `up.sql:110` (`AND c.source_upload_id IS NULL`) exists to make a re-run of the backfill unable to clobber a tag the route has written since — the header claims exactly this (up.sql:93-95). But every test that re-runs the up does so after `down`, which drops the column; on re-add every card tag is NULL again, so the guard is vacuously satisfied in all 9 tests. No test executes the backfill UPDATE against a table containing a non-NULL, route-written card tag that *differs* from the entry-derivable tag and asserts it survives. Add one test that applies 070, seeds a card with an explicit tag (e.g. upload X) on an entry tagged to a different same-owner upload Y, executes the up file's body (or just the backfill statement) directly via psycopg, and asserts the card still points at X. Severity tempered because the runner never re-runs an applied version (`schema_migrations`) and manual `psql` applies are forbidden by project protocol — the guard is defense-in-depth — but a safety property asserted in the migration header should be proven, not narrated.

### NIT
- **N-1: locking posture on a "live" DB.** `ALTER TABLE ... ADD COLUMN ... REFERENCES` takes ACCESS EXCLUSIVE on `vocab_cards` (brief — column is all-NULL so FK validation is trivial) and `CREATE INDEX` (non-CONCURRENTLY) takes SHARE. CONCURRENTLY is impossible under ADR-013 (runner owns the transaction), this exactly mirrors 068/040, and the table is single-user scale — acceptable, just noting the trade-off is inherited, not re-examined.
- **N-2: same-user over-attribution edge is accepted, and documented.** A card whose entry's tag came from U2 *extraction* of the owner's own upload (F-108) gets backfilled with that upload even if the save wasn't literally made in that upload's context. Never crosses users; the header calls it out as "equally correct provenance" (up.sql:81-82). Defensible — pre-070 data cannot distinguish the two cases — but it is a widening of "saved while reading THIS upload" semantics for backfilled rows.
- **N-3: the test chain (001, 002, 040, 070) omits 065's partial unique index** `uq_vocab_cards_user_vocab_recognition` (065.up.sql:112-114). Harmless — the backfill only UPDATEs a non-key column and never inserts, so it cannot interact with that index — but the minimal chain means the tests run against a slightly thinner `vocab_cards` than production. A one-line comment in the `provenance_dir` docstring acknowledging the exclusion would make the choice visibly deliberate.

### PRAISE
- **P-1: the ownership join is exactly right.** `WHERE ve.id = c.vocab_entry_id` joins through the entry PK, so each card matches at most one `(ve, bu)` pair — Postgres's `UPDATE ... FROM` multi-match hazard (nondeterministic row pick) is structurally excluded, and `bu.user_id = c.user_id` (up.sql:109) ties the copied tag to an upload the card's owner actually owns. There is no path by which user B's card can receive user A's upload id.
- **P-2: both drop-direction tests exist.** Not just "owner match copies" — the cross-user card on the *same shared entry* (:342, :355-358) and the cross-user card in the two-owner scenario (:391, :406-408) both assert NULL, which is the assertion that would catch a broken guard. The tests fail for the right reason.
- **P-3: F-088 down-marker discipline.** `DROP COLUMN` carries no keyword the legacy sniff catches; the down declares itself destructive explicitly (down.sql:9-11) and the test proves the gate refuses without `--allow-destructive` (:432-435).
- **P-4: header quality.** The up header states why `vocab_cards` and not `vocab_entries`, the F-107/F-108 provenance split, the SET NULL rationale, the updated_at/version audit impact (trigger stamps `updated_at` only — 001_core_schema.up.sql:59-67; `version` is app-bumped, so the backfill cannot break optimistic locking), and ADR-013 transaction ownership. This is the standard the rest of the ledger sets, met.
- **P-5: README ledger line (db/migrations/README.md:80) is accurate and complete** — mentions the ownership guard, the deliberate drop of cross-user tags, the marker classifications, and the coordinated route change.

---

## Detailed findings

### up.sql (`db/migrations/070_vocab_cards_source_upload.up.sql`)
- :47-50 — column + named FK, `ON DELETE SET NULL ON UPDATE RESTRICT`, `IF NOT EXISTS`. Mirrors 068.up.sql:39-42 verbatim in shape. Correct.
- :66-68 — partial index; supports both the grouping read and the SET NULL scan on upload delete (an FK cascade lookup on `source_upload_id = <id>` can use a `WHERE source_upload_id IS NOT NULL` partial index). Correct claim at :69-71.
- :102-110 — the backfill. Set-based single statement; `ve.source_upload_id IS NOT NULL` (:108) is technically redundant with the inner JOIN at :105-106 but makes the intent explicit and lets the planner start from the partial index `ix_vocab_entries_source_upload`. Fill-only guard at :110. No `ORDER BY`/locking concerns; runs inside the runner-owned transaction with the bookkeeping write (ADR-013), so a mid-backfill failure rolls back atomically — no partially-tagged state can be committed.
- Cards with `vocab_entry_id IS NULL` (grammar/sentence/TOPIK-target cards under the 001 XOR, 001_core_schema.up.sql:658-664) simply match nothing — NULL-safe by construction.

### down.sql (`db/migrations/070_vocab_cards_source_upload.down.sql`)
- :1 destructive marker; :9-11 explains why the explicit marker is load-bearing (legacy sniff blind to DROP COLUMN). Correct.
- :15 explicit `DROP INDEX IF EXISTS` before :18-19 `DROP COLUMN IF EXISTS` — the column drop alone would cascade the index and the FK, so the index drop is redundant but harmless and self-documenting.
- Documented lossy semantics (:4-8): card tags recorded post-070 are discarded; nothing is restored onto `vocab_entries` because nothing was removed from it. Honest and correct.
- Proven to run on a populated table (test :417-462) and to leave cards intact (:461-462).

### test file (`db/tests/test_migration_070.py`)
- Real-chain methodology (real migration files copied to tmp dir, runner invoked via `migrate.main`, fresh schema per test) mirrors test_migration_068.py — the tests exercise the actual runner including marker gating, not a re-implementation.
- Backfill tests seed at `up --target 040` (:329-332, :377-380) so the seeded state genuinely predates the column — the backfill runs over real pre-070 rows, not post-hoc fixtures. This is the correct way to test a backfill.
- :237-247 marker test — note `contains_destructive` simply returns the declared value when a directive is present (db/migrate.py:401-403), so the second pair of asserts is implied by the first; harmless, and it does pin the directive-is-authoritative behavior end-to-end.
- Coverage of the four required proofs: owner-match copy (:352-354), cross-user drop (:355-358, :406-408), untagged-entry NULL (:359), `vocab_entries` untouched (:360-368), down+re-up round trip re-deriving tags (:465-505). Missing: SF-1 (no-overwrite under re-run against non-NULL tags).

---

## Coordination observations (outside my scope, verified as consistent)

- `server/src/routes/vocab.ts` was changed in the same branch as the header promises: `POST /vocab/mine` no longer writes `vocab_entries.source_upload_id` (vocab.ts:773-776 documents its deliberate absence from the upsert), validates upload ownership before persisting the card tag (:725-732), and only writes the card tag when `card.source_upload_id === null` (:813-817) — first-write-wins at the *card* level, which is per-user and therefore consistent with the fill-only backfill semantics.
- `vocab_entries.source_upload_id` (040.up.sql:141-147) is left untouched as F-108 extracted-corpus provenance, and the corpus-fence reads (`sourceUploadFenceSql`, vocab.ts:159, :525, :578) continue to guard it — the expand/contract split is coherent across DB and route layers.
- Migration numbering is clean: 069_upload_extractions exists; 070 is the next free slot; no collisions.
- If this ships alongside other schema work, per project protocol the fixpass gates for schema changes must run the FULL server + ingest + db suites — this review ran only the db migration suite as instructed; the orchestrator's stated server gate covers the rest.
