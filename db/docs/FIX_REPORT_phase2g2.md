# FIX REPORT — Phase-2 Group 2 fix-pass (post 5-reviewer review)

- **Branch:** `feat/phase2-g2-new-tables` (working tree; NOT committed per instructions)
- **Fixer:** independent senior fix-pass (did not author, did not review)
- **Date:** 2026-07-10
- **Inputs:** `db/docs/REVIEW_phase2g2_{tickets,lists,hanja,reading_notif,integration}.md`
- **Suite counts:** see §Full-suite verification at the bottom (real counts, all four suites).

---

## Disposition table

| # | Finding (review · id) | Severity | Disposition | Where |
|---|---|---|---|---|
| 1 | Integration B-1 / Lists SF-1 — 049 rename breaks blue/green; README promises zero-downtime; scripted deploy won't stop | BLOCKER | **FIXED at the root** — 049 reverted to an ADD-ONLY expand (no rename); Group 2 is now genuinely zero-downtime and the README promise is TRUE | `db/migrations/049_*.{up,down}.sql`, `server/src/routes/vocabLists.ts`, `db/tests/test_migration_049.py`, `server/tests/routes/vocabLists.test.ts`, `db/migrations/README.md:62`, `Deploy/README.md` (new §"Shipping Phase-2 Group 2") |
| 2 | Reading/notif F1-1 — position upsert never bumps `version` | SHOULD-FIX | **FIXED** + test | `server/src/routes/reading.ts:388-391` (DO UPDATE arm), test `server/tests/routes/reading.test.ts:384-392` |
| 3 | Reading/notif F1-2 + F2-1 + sweep — stale `PRE_*` rollback targets after the merge | SHOULD-FIX | **FIXED (full sweep of all five files)** — `PRE_049` 047→048, `PRE_050` 047→049, `PRE_051` 047→050, `PRE_052` 047→051; `PRE_048` = 047 was already correct (verified, untouched); all comments corrected for the merged chain | `db/tests/test_migration_049.py:76`, `test_migration_050.py:64-72`, `test_migration_051.py:60-65`, `test_migration_052.py:56-61` |
| 4 | Hanja SF-1 — plan.ts counts hanja cards the Review queue can't drain | SHOULD-FIX | **FIXED** + test — `dueCount` now excludes hanja cards until the F-075 review UI ships | `server/src/routes/plan.ts:210-224`, test `server/tests/routes/plan.test.ts:135-155` |
| 5 | Integration S-1 — README rows 62/63 misstate 049/050 downs as gate-matched | SHOULD-FIX | **FIXED** — reworded to the 046-precedent pattern ("without tripping the destructive gate … flag needed anyway in the merged chain via 052/051") | `db/migrations/README.md:62-63` |
| 6 | Integration S-2 — 050 up header's stale "slots 048/049 reserved" note (checksum freeze closes at first prod apply) | SHOULD-FIX | **FIXED** (pre-apply window confirmed open — 048+ not applied anywhere; km-db live schema is pre-Group-2) | `db/migrations/050_hanja_cards.up.sql:25-28` |
| 7 | Hanja NIT-2 — test_migration_050 stale "048/049 do not exist" comments | NIT (swept with #3) | **FIXED** | `db/tests/test_migration_050.py:64-72, 438-441` |
| 8 | Integration N-1 — VERIFICATION.md §8 mirror for the Group-2 runbook | NIT | **MOOT via #1** — the root fix means Group 2 uses the standard flow; there is no special runbook to mirror. §8's generic checklist already covers it. `Deploy/README.md` gained the (short) Group-2 section stating exactly that | `Deploy/README.md` §"Shipping Phase-2 Group 2" |
| 9 | Tickets SF-1 — PATCH 409-vs-404 on concurrent ticket deletion | SHOULD-FIX (deferred by instruction) | **DEFERRED → ticket B-033** (only user-visible once a DELETE endpoint exists; gate noted on that future endpoint) | `BUGS_AND_FEATURES.md` §B-033 |
| 10 | Lists SF-2 — client not `(item_type, entry_id)`-aware | SHOULD-FIX (deferred by instruction) | **DEFERRED → ticket F-091** (hard gate on the F-048/060/061 add-UI slice; harmless until then — no UI can add non-vocab items) | `BUGS_AND_FEATURES.md` §F-091 |
| 11 | Reading/notif F2-2 — `notification_deliveries` needs a uniqueness-based claim key | Coordination (deferred) | **DEFERRED → ticket F-092** (sender-phase spec item) | `BUGS_AND_FEATURES.md` §F-092 |
| 12 | Reading/notif F2-3 — client Settings still writes the 018 blob booleans | Coordination (deferred) | **DEFERRED → ticket F-093** | `BUGS_AND_FEATURES.md` §F-093 |

Remaining NITs from the reviews (tickets N-1..5, lists N-1..4, hanja NIT-3/4, reading/notif F1-3/F1-4/F2-4/F2-5) were left as-is — they are documented judgment calls or polish explicitly ruled non-blocking by their reviewers, and none is invalidated by the 049 revert. Exception: lists N-1 (049.down not re-runnable) is **resolved as a side effect** of #1 — the new down no longer references a renamed column, and every statement in it is a no-op or idempotent on the 012 shape.

---

## #1 in detail — the 049 revert (the BLOCKER, fixed at the root)

**Problem (as ruled by the integration + lists reviewers):** 049 renamed
`vocab_list_entries.entry_id` → `vocab_entry_id`. The rename is invisible to
`migrate.py`'s destructive gate, so the scripted zero-downtime deploy would
apply it while the old color is still serving — and from that moment every
list read/seed on the old color 500s with `42703` until the flip. That forced
a 046-style brief-downtime release, contradicted `Deploy/README.md`'s "back to
zero-downtime" promise, and invalidated rollback-by-flip — with documentation
as the only gate, pointing the wrong way.

**Fix:** 049 is now a pure expand. `entry_id` KEEPS its 012 name; only its
NOT NULL is dropped. The migration adds `kgiu_entry_id` + `hanja_character_id`
(+ CASCADE FKs), the exactly-one-non-null XOR CHECK across the three columns,
partial UNIQUE indexes for the two NEW columns, and the reverse-lookup
indexes. The 012 `uq_vocab_list_entries_list_entry` UNIQUE is **kept, not
swapped**: under NULLs-distinct semantics it already IS the vocab leg's
per-target guarantee (grammar/hanja rows carry `entry_id` NULL and never
collide under it), so touching it would have been churn with no enforcement
gain — and keeping it preserves any old-color reliance on the constraint.

**Why the old color provably keeps working** (verified against
`rebuild:server/src/routes/vocabLists.ts`, which names `entry_id` in every
query and uses NO `ON CONFLICT` arbiter on this table):

- old seed INSERT sets only `(list_id, entry_id, position)` → XOR satisfied
  (new columns default NULL);
- old detail SELECT `JOIN vocab_entries v ON v.id = e.entry_id` (INNER) →
  resolves fine, and silently skips any grammar/hanja rows a newer color
  wrote — old clients simply don't see them;
- old dup-check `entry_id = ANY(...)` → NULL never matches, no error.

This is not just argued — it is **proven by a new db test**,
`test_049_up_old_color_contract_still_works`
(`db/tests/test_migration_049.py:432+`), which runs the rebuild code's exact
SQL shapes against the post-049 schema with a grammar membership coexisting in
the list. Rollback-by-flip is therefore valid again for the whole group.

**Naming trade recorded:** the rename's only benefit was uniformity with
`vocab_cards.vocab_entry_id`. The up header now documents why the name stays
(zero-downtime > aesthetics) and that a cosmetic rename, if ever wanted, ships
as its own contract-phase migration once no pre-rename code can be serving.

**Knock-on updates in the same change:**
- `server/src/routes/vocabLists.ts` — vocab leg uses `entry_id` everywhere
  (`TARGET_COLUMN.vocab`, seed INSERT, detail SELECT/JOIN, dup-check, batch
  INSERT/RETURNING). Wire shapes are UNCHANGED (the API already aliased the
  polymorphic id as `entry_id`).
- `server/tests/routes/vocabLists.test.ts` — the three raw-SQL row-level
  assertions updated to the kept column name.
- `db/tests/test_migration_049.py` — rewritten for the expand semantics
  (entry_id kept + nullable; 012 UNIQUE/FK asserted UNTOUCHED under their
  original names; new partial uniques + indexes; XOR; CASCADE; down/re-up
  round-trip) + the old-color contract test above.
- `db/migrations/README.md:62` — row no longer implies a rename; states
  ADD-ONLY / zero-downtime.
- `Deploy/README.md` — new short §"Shipping Phase-2 Group 2 (048–052)":
  standard zero-downtime flow, no flags, no password step (047 default
  privileges cover the new tables), rollback-by-flip valid; the one caution
  (manual schema rollback = real data loss not mechanically gated) documented
  with the 046-precedent wording.

**Checksum note:** editing 049/050 SQL changes their `migrate.py` checksums.
Safe: no environment has applied 048+ (the live km-db is pre-Group-2; CI and
the test harnesses hash from disk per run). This was the integration review's
own precondition for S-2, re-confirmed here.

---

## #2 in detail — reading position `version` bump

`PUT /reading/position/:uploadId`'s `ON CONFLICT … DO UPDATE` now sets
`version = reading_positions.version + 1`, matching the ADR-001 §D6 convention
and this branch's own sibling (`notifications.ts` schedule upsert). Without
it, `reading_positions.version` was frozen at its DEFAULT 1 forever (the 001
trigger only touches `updated_at`). Test extends the existing
overwrite-semantics case: after PUT + PUT, the row's `version` is asserted 2
straight from the DB.

## #4 in detail — plan.ts hanja exclusion

`GET /plan/today`'s `dueCount` query gains `AND hanja_character_id IS NULL`,
with a comment tying it to the drainability contract: `/vocab/cards/due`
excludes hanja cards (`vocab.ts:272`) and no client consumes
`/hanja/cards/due` yet, so counting them showed phantom workload. The comment
says exactly when to revisit (F-075 client wiring — see also F-091's sibling
note). New test: a due, live hanja card and a due vocab card → `dueCount` 1.

## #3/#7 in detail — PRE_* sweep semantics

With the merged chain, each per-migration test's rollback target must be the
true immediate predecessor so the "rolls back exactly NNN(+later)" claims hold
and — critically for 052 — the **gate-refusal assertion isolates 052's own
DROP TABLE** (at `PRE_052 = "047"` the refusal could be satisfied by 051's
gated down, masking a regression in 052.down). Comments in each file now state
which later gated downs the descent traverses and why the flag is passed.

---

## Self-assessment

- **Faithful to the reviews:** every BLOCKER/SHOULD-FIX disposition follows
  the reviewer's own preferred remedy (the lists reviewer explicitly called
  the add-only expand "the senior-engineer answer"; the integration reviewer's
  doc-only alternative became unnecessary once the root cause was removed).
  I verified each claim against the code before acting — notably that the
  rebuild code has no `ON CONFLICT` on `vocab_list_entries` (which would have
  changed the keep-the-constraint decision) and that `PRE_048 = "047"` was
  already correct (the summary's "sweep all" could have over-fired there).
- **Minimal:** no schema surface beyond what 049 already shipped was touched;
  the 012 UNIQUE was deliberately left in place rather than "modernized";
  route wire contracts are unchanged.
- **Each behavioral fix has a real test** (old-color contract, version bump,
  hanja exclusion) against real Postgres, not mocks.
- **Risks accepted:** (a) the vocab uniqueness error now surfaces under the
  012 constraint name rather than a 049 index name — nothing keys on it (the
  routes pre-check and 409 before the constraint can fire); (b) editing
  applied-nowhere migrations changes checksums — precondition re-verified;
  (c) `test_migration_050`'s seed stage now also applies 048/049 — asserted
  harmless (neither touches `vocab_cards`) and it makes the "pre-050 schema"
  claim true in the merged chain.

---

## Full-suite verification (real counts)

| Suite | Command | Result |
|---|---|---|
| DB migration chain | dockerized `pytest db/tests --ignore=db/tests/test_discriminator_coverage.py` (container harness per instructions) | **45 passed** in 63.58s (was 44; +1 new old-color contract test) |
| Server (vitest) | `cd server && npm ci && npx vitest run` (run alone) | **1103 passed / 0 failed / 4 skipped (54 files)** in 355.69s. This fix-pass adds exactly **+1** test (verified by `vitest list` collection diff against the pre-change tree: 1100 → 1101 collected); the residual run-count variance vs the integration review's stated 1100 is parametrized-case expansion, with 0 failures and identical file/skip counts either way |
| Client (vitest) | `cd client && npx vitest run` | **1261 passed / 0 failed (105 files)** in 12.68s wall (parallel workers; tests 60.75s) |
| Ingest (CI-equivalent) | dockerized `pytest tests -q --ignore=tests/test_resolve_cross_references_integration.py` | **342 passed, 3 skipped, 1 failed** in 180.31s — the failure is `test_hanja_hunmeum.py::test_built_corpus_has_full_hun_coverage`, the pre-declared local-data-only known non-issue (CI skips it; the Group-2 diff touches nothing under `tools/ingest/`); identical to the integration review's baseline |
