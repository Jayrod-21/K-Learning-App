# REVIEW FIXES b8 — F-108 fixpass re-review (independent)

Re-reviewer: independent fresh-eyes (did not author the code, the original
reviews, or the fix-pass). Branch `feat/f108-u2-extraction`, worktree
`.claude/worktrees/f108-ocr`. Reviewed state: integration merge `390613c`
(HEAD = fix commit `5a11fe6` + `origin/rebuild`, which brought Batch 5's
F-107 provenance work — `vocab.ts` and `grammar.ts` are edited by BOTH).
Every FIX_REPORT_b8.md claim was verified against the actual merged code and
tests, not the report.

## Summary verdict: **PASS**

All 5 blockers and all 6 SHOULD-FIX are genuinely fixed, each with a test
that fails if the fix is reverted. The integration merge kept both Batch 5's
provenance code and F-108's fences intact — nothing was clobbered in either
direction. No PRAISE item was undone. Gates re-run here are green. Two new
NITs (post-merge doc/number drift), no new blockers.

## Finding-by-finding table

| ID | Orig severity | Fix status | Verified how | Notes |
|---|---|---|---|---|
| BLOCKER-1 (cost-cap CASCADE bypass) | BLOCKER | **FIXED** | Read `db/migrations/069_upload_extractions.up.sql:126-128` (`ON DELETE SET NULL ON UPDATE RESTRICT`, `upload_id` nullable at :92) + cap SUM by `user_id` alone (`uploadExtract.ts:564-570`); ran route test | FK is SET NULL; header documents WHY (:34-46). Route test `uploadExtract.test.ts:394-429` drives the real `DELETE /uploads/:id`, asserts the ledger row survives with `upload_id` NULL and a fresh upload still 429s with zero proxy calls — a CASCADE revert fails `expect(ledger.length).toBe(1)`. DB-level pin duplicated in `test_migration_069.py:285-323`. Orphaned-NULL claim semantics verified: partial unique covers only live rows and btree NULLs are distinct (`up.sql:183-188`, `test_migration_069.py:325+`). `ExtractionRunDTO.upload_id` honestly `number \| null` (`uploadExtract.ts:141-142`). |
| BLOCKER-2 / B-1 (`pickVocabSeed` unfenced) | BLOCKER | **FIXED** | Read `diagnostic.ts:391-420`; ran test | `AND source_upload_id IS NULL` at :403 with the twin's comment incl. the L3 first-pass argument. Both helpers exported; test `uploadExtract.test.ts:823-842` makes extracted rows the ONLY corpus → both helpers return null, then seeds untagged L3 controls and asserts they (and only they) are picked. Deleting the fence returns the extracted L3 row on the first pass → test fails. |
| B-2 (bank route existence oracle + exfil) | BLOCKER | **FIXED** | Read `vocab.ts:574-584`; ran test | `sourceUploadFenceSql('source_upload_id', '$2')` inside the bank tx, `userId` bound. Test :844-861: stranger banks extracted id → 404 AND zero `vocab_cards` minted (closes the cards/due exfil leg); owner 201 positive control. Removing the predicate → 201 + minted card → two assertions fail. |
| B-3 (vocab-lists id acceptance, vocab AND kgiu) | BLOCKER | **FIXED** | Read `vocabLists.ts:247-251` (create-with-seeds, `v.source_upload_id`/`$3`) and :576-584 (typed add, fenced for vocab + grammar; hanja documented exempt — no column); ran tests | Typed-add test :863-897 probes BOTH target types as a stranger (404, list detail stays empty — the kgiu leak path explicitly) with owner positive controls; seed-path test :899-917 pins `appended: 0` indistinguishable from a bad id, owner appends 1. Removing the `$2` fence in the typed-add makes the validation return the id → 201 → fails. |
| B-4 (grammar weekly + grammar diag seed fences untested) | BLOCKER | **FIXED** | Read `grammar.ts:497-501` + tests; ran them | Weekly test :805-821 probes as stranger AND owner (fence is unconditional), extracted pattern absent for both, untagged control `-(으)면` present for both — deleting `grammar.ts:501` today fails this test. `pickGrammarSeed` covered by the same seed-helper test as B-1. |
| SF-1 / S-3 (cross-upload cap race; comment overclaim) | SHOULD-FIX | **FIXED** | Read `uploadExtract.ts:549-559`; ran test | `pg_advisory_xact_lock(hashtextextended('f108_extract_daily_cap:' \|\| userId, 0))` taken BEFORE the SUM, single-BIGINT form. Lock ordering is row-lock → advisory in the only path taking both — no deadlock cycle. Comment now states the real guarantee. S-2 scope test :368-392: budget burnt on upload A → upload B (same user) 429, different-user control 201 — an upload-scoped SUM fails it. The race itself is accepted as not deterministically testable; honest. |
| SF-2 (crash mid-run bricks upload) | SHOULD-FIX | **FIXED** | Read `uploadExtract.ts:117, 527-547`; ran tests | Reaper inside the claim tx (serialized by the parent `FOR UPDATE`), settles `pending/running` older than `STALE_RUN_MINUTES` (15) as `failed` with a reap message; `pages_requested` stays in the ledger. Tests :432-472: 20-min-old row → 201 + old row `failed` matching `/stale run reaped/`; 5-min-old row → still 409. |
| SF-3 (`pos` un-revalidated) | SHOULD-FIX | **FIXED** | Read `uploadExtract.ts:124, 308-313`; ran test | `ALLOWED_POS` closed set checked at the curation boundary, unknown → null (conservative: grammar bucket surfaces only behind the owner fence). Test :636-664 stubs a marker-bearing `pos` via double cast, asserts persisted `part_of_speech IS NULL`. |
| SF-4 (`errorSummary('')` → stuck run) | SHOULD-FIX | **FIXED** | Read `uploadExtract.ts:790-794`; ran test | `msg \|\| 'unknown error'`, exported; unit test :667-675 pins `new Error('')` and `''` → `'unknown error'`, non-empty passthrough. Unit-level rather than e2e — rationale in FIX_REPORT is sound (the empty-message path isn't deterministically injectable through the API). |
| S-1 (no migration test) | SHOULD-FIX | **FIXED** | Read `db/tests/test_migration_069.py` (full); relied on orchestrator db run | Real-chain: marker classification, idempotent re-apply, relaxed-CHECK live inserts, the BLOCKER-1 FK pin, orphaned-claim arbitration, destructive-gate refusal + clean down + fail-loud-on-populated-corpus + re-up. Renamed 068→069 in the merge (renumber-only — diffed against `5a11fe6`'s file: title/number changes only). See NEW-2 for a post-merge imprecision. |
| N-1 (injection test gloss-only) | NIT | **FIXED** | Ran test | :608-634 poisons `gloss` AND the `kr` headword; `words_skipped` 2, only the clean sibling persists. |
| N-4 (`DEFAULT_EXTRACT_PAGES` export) | NIT | **FIXED** | Read `uploadExtract.ts:110` | Module-private const with a documented rationale. |
| NIT-1, NIT-2, NIT-3, N-2, N-3, N-5 | NIT | **DEFERRED-WITH-DOC** | FIX_REPORT disposition table | Per orchestrator scope (fix N-1 + N-4 only). Acceptable. |

## Integration-merge verification (B5 F-107 + F-108 coexistence)

The merge `390613c` conflicted on exactly two files (`server/src/routes/grammar.ts`,
`db/tests/test_migration_068.py`). I diffed the merge result against the fix
commit `5a11fe6` for every F-108 file:

- **`uploadExtract.ts`, `corpusFences.ts`, `vocabLists.ts`, `diagnostic.ts`,
  `uploads.ts`, `uploadExtract.test.ts` — byte-identical to the fix commit.**
  No fix was dropped.
- **`grammar.ts`** — the diff is purely additive B5 content: `withTransaction`
  joins `query` in the pool import (line 11) alongside F-108's
  `sourceUploadFenceSql` import (line 12); `BankBodySchema` gains
  `source_upload_id` (:207); `POST /grammar/bank` gains the tx-wrapped
  ownership check (404, non-oracle), the COALESCE first-write-wins tagged
  upsert, and the `fk_grammar_entries_source_upload` 23503→404 race guard
  (:275-291). F-108's browse fence (:109), detail fence (:163), and the
  unconditional weekly fence (:501) are all intact. Both features coexist
  correctly.
- **`vocab.ts`** — merged without conflict; the only deletions are the old
  un-provenance'd `/vocab/mine` INSERT replaced by B5's tagged version. All
  three F-108 fences (browse $8, detail $2, bank $2) present; B5's
  `source_upload_id` on `MineBodySchema` (:644), its ownership check (:709-716),
  and `GET /vocab/saved-from-uploads` (`bu.user_id = $1` ON the join, :935-937)
  present. Note the saved-from-uploads read can legitimately show the OWNER's
  own extracted rows if the owner banks/lists them — owner-only by
  construction, no cross-user surface.
- **Migrations** — F-108's `068_upload_extractions.{up,down}.sql` renamed to
  `069_…` (rename-only: the 6 changed lines per file are the number in the
  header/footer/reverse reference); B5's `068_grammar_entries_source_upload`
  slots before it. `test_migration_068.py` is now B5's (isolated copied-dir,
  `PRE_068 = "040"` — no chain interference), `test_migration_069.py` is the
  fix commit's file renumbered.
- **Whole-corpus fence audit re-swept post-merge**: every `FROM/JOIN
  vocab_entries|kgiu_entries` in `server/src` was enumerated. Fenced:
  vocab browse/detail/bank, kgiu browse/detail, lists seed + typed-add.
  Unconditionally excluded: grammar weekly, both diagnostic seeds. Safe by
  construction: `POST /vocab/cards/init` + `/vocab/suggestions/weekly`
  (closed curated-corpus allow-lists, verified at `vocab.ts:442/1045`),
  `vocab.ts:214` themes (extraction writes no theme), hanja + quiz + mastery +
  cards/due + list detail/due/seed joins (all reach entries only through the
  user's own cards or own lists, which are safe now that banking and list-add
  are fenced), `reading.ts` (upload-ownership asserted first). **No unfenced
  id-accepting path remains.**

## Bar checklist (post-fix)

| Bar item | Status |
|---|---|
| User-scoped every query; 404 not 403 on mismatch | PASS — fence now on every id-accepting path; stranger probes get the missing-id 404 everywhere |
| Daily cap 429 before upstream; counts failed pages; survives deletion | PASS — SET NULL ledger + per-user advisory lock + proxy-spy tests |
| No external I/O inside an open DB tx | PASS — untouched (P-1) |
| Atomic persist / TOCTOU-free claim | PASS — untouched (P-2); reaper + advisory lock live inside the claim tx, INSERT still the arbiter |
| Prompt-injection guard on every persisted field | PASS — `pos` closed-enum revalidation closes the last gap |
| Migration discipline + automated up/down test | PASS — 069 keeps markers/idempotency/fail-loud down; real-chain pytest exists |
| Tests exercise real behavior, fail on revert | PASS — mutation-reasoned two fences (bank, typed-add kgiu): deleting either predicate flips concrete assertions (404→201, card-count 0→1, list detail empty→populated) |
| PRAISE items P-1..P-6 + adversarial fence test | ALL INTACT — verified in the merged code, not the diff |

## Gates — re-run vs relied upon

- **Re-ran here**: `npm ci` + `npm run typecheck` (0 errors) + `npm run lint`
  (0 errors, 79 pre-existing warnings) on the merge HEAD; targeted
  `npx vitest run tests/routes/uploadExtract.test.ts` → **31/31 passed**
  (37.6s, real testcontainer) — this one file carries every blocker's
  regression test.
- **Relied upon** (orchestrator's just-completed runs on this HEAD, nothing
  suspicious found in code reading to warrant repeating): full server vitest
  (1445 passed / 4 skipped, exit 0) and the db suite (138 passed, chain
  001-069). The db suite could not be re-run on this host directly (no
  `psycopg`; it runs in the `python:3.12` container per TESTS.md).

## New findings introduced

- **NEW-1 (NIT, doc drift)** — Comments still citing "migration 068" for the
  extraction FK/ledger now point at the WRONG migration after the merge's
  renumber to 069: `uploadExtract.ts:62-63, 139-140, 562`, `uploads.ts:608-610`,
  `uploadExtract.test.ts:414`. B5's 068 is a different migration
  (grammar_entries provenance). Cosmetic — the SQL itself is correct.
- **NEW-2 (NIT, test precision)** — `db/tests/test_migration_069.py:66-68`:
  `PRE_069 = "067"` with the comment "rolls back ONLY 069". Post-merge the
  migration immediately before 069 is B5's 068, so `down --target 067` rolls
  back 069 AND 068. Every assertion still holds (069's destructive down still
  trips the gate first; re-up re-applies both; the suite passes), but the
  down-scope is one migration wider than documented. Fix: `PRE_069 = "068"`.
- **PRAISE** — `corpusFences.ts`'s module header is a genuine audit surface:
  it names every fence site, the exempt-safe sites with reasons, and the rule
  for future routes; the fix commit's test additions are uniformly
  adversarial (stranger probe + owner positive control + a concrete
  exfiltration read asserted empty).

## Recommendation

**Ready to ship.** No new blockers; no fix-pass round needed. File the two
NITs (NEW-1 comment renumber sweep, NEW-2 `PRE_069 = "068"`) as trivial
follow-ups — both are one-line/mechanical and can ride the next touch of
these files.
