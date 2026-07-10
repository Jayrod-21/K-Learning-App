# RE-REVIEW — Phase-2 Group 2 fix-pass verification

- **Branch:** `feat/phase2-g2-new-tables` (fixes in the working tree, uncommitted — see Recommendation)
- **Re-reviewer:** independent senior re-review — did not author, did not originally review, did not perform the fix-pass
- **Date:** 2026-07-10
- **Inputs:** the 5 original reviews (`REVIEW_phase2g2_{tickets,lists,hanja,reading_notif,integration}.md`), `FIX_REPORT_phase2g2.md` (verified skeptically against code), full gate re-runs (db chain + full server suite, owned by this re-review)

---

## VERDICT: **PASS**

The BLOCKER is genuinely fixed at the root, not papered over. Migration 049 is
now a true add-only expand — `vocab_list_entries.entry_id` keeps its 012 name,
verified in the SQL, the route code, and (critically) by a db test that would
hard-fail if the rename ever returned. The zero-downtime claim is **proven, not
argued**: the new old-color-contract test executes the rebuild branch's exact
SQL shapes against the post-049 schema with a grammar row coexisting. All four
SHOULD-FIX code changes are present with real tests. No test was weakened. All
four deferrals are correctly ticketed and none is a mis-deferred blocker. Both
suites pass at the expected counts under this re-review's own runs.

---

## Gate results (run by this re-reviewer, sequentially per OOM policy)

| Suite | Command | Result | Expected |
|---|---|---|---|
| DB migration chain | dockerized `pytest db/tests --ignore=db/tests/test_discriminator_coverage.py` | **45 passed** in 71.51s | 45 ✅ (44 pre-fix + 1 new old-color contract test) |
| Server (vitest, full, run alone) | `cd server && npm ci && npx vitest run` | **1101 passed / 0 failed / 4 skipped (54 files passed, 1 skipped = 55)** in 1503.6s | ~1103 passed / 0 failed ✅ |

Server count reconciliation: the fix report claimed 1103 passed / 54 files
and itself flagged run-count variance from parametrized-case expansion (its
`vitest list` collection diff showed 1101 collected — exactly this run's
passed count). The one skipped file is `tests/services/claude/real_smoke.test.ts`
(`describe.skipIf(!RUN)` — env-gated real-API smoke, skipped by design), the
4 skipped tests are the long-standing baseline skips. **0 failures either
way; no regression.** The Zod-parse error lines in the log are expected
negative-path test logging.

---

## Finding-by-finding verification

| # | Original finding | Fix claimed | Verified? | Evidence |
|---|---|---|---|---|
| 1 | **BLOCKER** (integration B-1 / lists SF-1) — 049 rename breaks blue/green; README promises zero-downtime; scripted deploy won't stop | 049 reverted to add-only expand | **YES — genuine root fix** | See §"The BLOCKER" below |
| 2 | Reading/notif F1-1 — position upsert never bumps `version` | `version = reading_positions.version + 1` on the DO UPDATE arm + test | **YES** | `server/src/routes/reading.ts:387`; test asserts `version === 2` after PUT+PUT straight from the DB (`server/tests/routes/reading.test.ts:382-391`) |
| 3 | F1-2/F2-1/sweep — stale `PRE_*` rollback targets | Full sweep | **YES, all five correct** | `PRE_048="047"` (untouched, was already right), `PRE_049="048"` (`test_migration_049.py:73`), `PRE_050="049"` (`test_migration_050.py:74`), `PRE_051="050"` (`test_migration_051.py:65`), `PRE_052="051"` (`test_migration_052.py:61`); comments corrected for the merged chain in each file |
| 3a | 052 gate-refusal isolation | With `PRE_052="051"` the refusal isolates 052's own DROP TABLE | **YES** | `test_migration_052.py:317-325` — unflagged `down --target 051` must fail AND leave `notification_schedules` intact; only 052's down is in that descent, so a de-fanged 052.down can no longer hide behind 051's |
| 4 | Hanja SF-1 — plan.ts `dueCount` counts undrainable hanja cards | `AND hanja_character_id IS NULL` + test | **YES** | `server/src/routes/plan.ts:219` with a revisit-condition comment (F-075 client wiring); test seeds a due hanja card + a due vocab card, asserts `dueCount === 1` (`plan.test.ts:137-156`) |
| 5 | Integration S-1 — README rows 62/63 misstate 049/050 downs as gate-matched | Reworded to 046-precedent pattern | **YES** | `db/migrations/README.md` rows 049/050 now say "without tripping the destructive gate (see the down header)" + the merged-chain nuance (flag needed anyway via 052/051's DROP TABLE downs) |
| 6 | Integration S-2 — 050 up header's stale "slots 048/049 reserved" note | Fixed pre-checksum-freeze | **YES** | `050_hanja_cards.up.sql:25-28` now states all three coexist in the merged chain and neither 048 nor 049 touches `vocab_cards`. Checksum precondition holds (no environment has applied 048+; edits are pre-apply) |
| 7 | Hanja NIT-2 — test_migration_050 stale comments | Swept | **YES** | `test_migration_050.py:66-74, 437-441` |
| 8 | Integration N-1 — VERIFICATION.md §8 mirror | MOOT via #1 | **YES, correctly moot** | Group 2 now uses the standard flow; no special runbook exists to mirror. `Deploy/README.md` §"Shipping Phase-2 Group 2" states exactly that |
| 9 | Tickets SF-1 — PATCH 409-vs-404 on vanished ticket | Deferred → B-033 | **YES, sound** | `BUGS_AND_FEATURES.md` §B-033 — accurate root cause, correct hard gate ("do not build DELETE /tickets/:id without this") |
| 10 | Lists SF-2 — client not `(item_type, entry_id)`-aware | Deferred → F-091 | **YES, sound** | §F-091 — correct file/line pointers, hard gate on the F-048/060/061 client slice; genuinely harmless today (no UI can put a non-vocab item in a list) |
| 11 | F2-2 — deliveries claim-key race | Deferred → F-092 | **YES, sound** | §F-092 — correctly framed as a sender-phase spec item ("the insert, not the probe, must be the arbiter") |
| 12 | F2-3 — Settings still writes 018 blob booleans | Deferred → F-093 | **YES, sound** | §F-093 — includes the F2-5 nuance (`weekday` omitted, not null) so it won't be re-tripped later |
| — | Lists N-1 — 049.down not re-runnable | Resolved as side effect of #1 | **YES** | Every statement in the new down is `IF EXISTS`-guarded or a no-op on the 012 shape (the `DELETE WHERE entry_id IS NULL` matches nothing; `SET NOT NULL` is idempotent) |

---

## The BLOCKER — verified in depth (the zero-downtime claim IS genuinely proven)

**1. The migration is a pure expand.** `049_vocab_list_entries_multitype.up.sql`
contains no RENAME and no DROP COLUMN: `ALTER COLUMN entry_id DROP NOT NULL`
(line 91), `ADD COLUMN IF NOT EXISTS kgiu_entry_id / hanja_character_id`
(96-97), catalog-guarded CASCADE FKs (99-117), the exactly-one-non-null XOR
CHECK across the three columns (135-142), partial UNIQUEs for the two NEW
columns only (151-161), reverse-lookup indexes (169-186). The 012
`uq_vocab_list_entries_list_entry` UNIQUE and `fk_vocab_list_entries_entry`
RESTRICT FK are untouched — and the test asserts both survive under their
original names with their original delete rules (`test_migration_049.py:328,
351`). The keep-the-012-UNIQUE reasoning (NULLs-distinct makes it the vocab
leg's per-target guarantee) is correct Postgres semantics.

**2. The route uses `entry_id`.** `server/src/routes/vocabLists.ts` —
`TARGET_COLUMN.vocab = 'entry_id'` (line 90), seed INSERT (236), detail
COALESCE/CASE/JOIN (334-352), dup-check (571-580), batch INSERT/RETURNING
(610-620). A repo-wide grep confirms every remaining `vocab_entry_id`
reference is on `vocab_cards` — a different table where that has always been
the column's name. Wire shapes unchanged (the API already aliased the
polymorphic id as `entry_id`).

**3. The old-color contract test is real and would catch a regression.**
`test_049_up_old_color_contract_still_works` (`test_migration_049.py:454-528`)
applies the full chain, writes a grammar membership into the list (the
new-color coexistence condition), then executes the rebuild branch's SQL
**verbatim** — I diffed the three shapes against
`git show rebuild:server/src/routes/vocabLists.ts` and they match:
- the seed INSERT naming only `(list_id, entry_id, position)` with the
  EXISTS/NOT-EXISTS skip logic (rebuild :189-199) → succeeds, XOR satisfied;
- the dup-check `entry_id = ANY(...)` (rebuild :461-463) → the grammar row's
  NULL never matches;
- the detail INNER JOIN + `ORDER BY position, added_at, entry_id`
  (rebuild :276-285) → returns exactly the vocab rows, silently skipping the
  grammar row.

If the rename came back, all three would raise 42703 and the test fails; the
companion assertion `"vocab_entry_id" not in cols` with message *"049 must NOT
rename entry_id (expand/contract)"* (`test_migration_049.py:300-301`) fails
even before that. I also swept the rebuild file for every other
`vocab_list_entries` statement not covered by the test: the list-index LEFT
JOIN/COUNT (:113), detail entry_count subquery (:256), MAX(position) (:477),
and `DELETE WHERE list_id AND entry_id = $2` (:545) — all trivially compatible
with the expanded schema (NULL never matches the DELETE; counts and MAX are
column-agnostic). **Conclusion: rollback-by-flip and serve-during-migrate are
genuinely valid for the whole group.**

**4. Deploy/README.md now tells the truth.** §"Shipping Phase-2 Group 2
(migrations 048–052) — standard zero-downtime flow" (line 231): standard
scripted sequence, unflagged migrate (correct — nothing in the five ups is
gate-matched), rollback-by-flip explicitly valid, no password step (047's
`ALTER DEFAULT PRIVILEGES` covers the new tables — consistent with the
integration review's own verification), and the one real caution (manual
schema rollback = data loss the gate does not mechanically match) carried
over with the 046-precedent wording. The Group-1 section's "subsequent
releases return to zero-downtime" promise (line 220) is now actually true.

---

## No weakened tests

`git diff` over `server/tests/` and `db/tests/` (fix-pass changes vs HEAD, and
branch vs `rebuild`):

- `vocabLists.test.ts` — only the three raw-SQL row-level column names updated
  to the kept name; every assertion (XOR routing, NULL legs, constraint
  firings) intact.
- `plan.test.ts`, `reading.test.ts` — additions only (hanja-exclusion test;
  version===2 assertion).
- `test_migration_049.py` — rewritten for expand semantics but strictly
  stronger than the original: keeps the XOR/partial-unique/CASCADE/round-trip
  coverage and adds the no-rename guard + old-color contract test.
- `test_migration_050/051/052.py` — constant + comment changes only; the 052
  gate-refusal assertion got *stronger* (now isolates 052's own down).
- No `.skip`, no loosened matchers, no deleted assertions anywhere in the diff.

## Scope / regressions

`git diff rebuild --stat` = 35 files, all within the Group-2 + fix-pass
footprint; fix-pass source changes are confined to
`plan.ts` (+10/-1), `reading.ts` (+6/-1), `vocabLists.ts` (column-name revert
only), the four db test files, three server test files, and the four docs.
No scope creep.

## New findings (this re-review)

1. **INFO — overlap-window entry_count cosmetic skew.** During the (now
   legal) serve-during-migrate overlap, if the NEW color writes a
   grammar/hanja membership, the OLD color's list index `entry_count` (LEFT
   JOIN COUNT, rebuild :113/:256) includes it while its detail view (INNER
   JOIN) hides it — a count/list mismatch visible only in that window, only
   if a mixed write happens mid-deploy. No error, no data risk. Not worth
   code; noting for completeness.
2. **HOUSEKEEPING — fixes are uncommitted.** The entire fix-pass sits in the
   working tree (16 modified files + the report). Per instructions, fine —
   but the branch must be committed before any CI/ship step, and the
   unrelated untracked files (`REDESIGN_SEOUL_NEON_BRIEF.md`, `.claude/`)
   must NOT ride along in that commit.

## Recommendation

**Ready to ship** (commit the working tree, then the standard `/ship`
pipeline — no special deploy protocol needed, which is the whole point of the
fix). No further fix-pass warranted. Follow-ups are fully captured as
B-033 / F-091 / F-092 / F-093; F-091 is the one with a hard gate (before any
grammar/hanja add-UI ships) and is correctly marked P2.
