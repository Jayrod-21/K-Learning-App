# FIX REPORT b8 — F-108 U2 extraction/OCR pipeline (fixpass)

Fix-pass agent: independent (did not author or review this code). Inputs:
`docs/REVIEW_b8_pipeline.md` + `docs/REVIEW_b8_fences_tests.md`. Branch
`feat/f108-u2-extraction`, worktree `.claude/worktrees/f108-ocr`.

Rule applied throughout: every blocker fix carries a test that FAILS if the
fix is reverted (mutation-checkable), and "who can read
`vocab_entries`/`kgiu_entries` ids" was treated as ONE audit — the fence now
lives in a single shared fragment, `server/src/db/corpusFences.ts`
(`sourceUploadFenceSql`), composed by every owner-conditional site, with the
module header carrying the site list and the rule for future routes.

## Disposition table

| ID | Finding | Disposition |
|---|---|---|
| BLOCKER-1 (pipeline) | Cost-cap bypass: ledger rows CASCADE with `DELETE /uploads/:id` | **FIXED.** `db/migrations/068_upload_extractions.up.sql`: `fk_upload_extractions_upload` → `ON DELETE SET NULL`, `upload_id` made nullable; header gains a "WHY THE LEDGER SURVIVES UPLOAD DELETION" section; table/column COMMENTs updated. 068 was edited IN PLACE (feature branch — not applied to any live DB; per orchestrator instruction, no 069, no renumber). The cap SUM (`uploadExtract.ts`) already sums by `user_id` alone, so orphaned rows keep counting — verified and now pinned by tests. Partial-unique claim semantics verified: a live run still blocks re-trigger; settled/orphaned (NULL) rows never block (btree NULLs are distinct, and settled rows are outside the partial index). `ExtractionRunDTO.upload_id` honestly typed `number \| null`; the mid-OCR-deletion path re-reasoned (persist now 23503s on the dead FK → run settles `failed`; run row survives as ledger). `uploads.ts` DELETE comment updated. Tests: route-level ledger-survival + still-429-after-delete (`uploadExtract.test.ts` "deleting the upload does NOT refund the budget"), DB-level FK pin + orphan-claim semantics (`db/tests/test_migration_068.py`). Down.sql needed no functional change (it drops the whole table); its header now names the ledger loss. |
| BLOCKER-2 / B-1 | `pickVocabSeed` unfenced — extracted L3 rows seed ANY user's diagnostic | **FIXED.** `diagnostic.ts`: `AND source_upload_id IS NULL` added to the seed SQL with the twin's comment (plus why L3 makes it the FIRST-pass match). Both seed helpers exported for direct fence coverage (precedent: `shuffleGeneratedChoices`). Test: extracted rows as the ONLY corpus → both helpers return null; untagged control rows are picked and are the only thing picked. Reverting the fence returns the extracted row → test fails. |
| BLOCKER-3 / B-2 | `POST /vocab/entries/:entryId/bank` existence check unfenced — oracle + exfil via cards join | **FIXED.** `vocab.ts` bank existence check now carries `sourceUploadFenceSql('source_upload_id', '$2')` with `userId` bound (in tx scope). Stranger banking an extracted id → same 404 as a missing id, zero `vocab_cards` minted; owner 201 (positive control). Test in `uploadExtract.test.ts`. `POST /vocab/cards/init` left alone (corpus enum allow-list — verified safe, per both reviews). |
| BLOCKER-4 / B-3 | vocab-lists id-acceptance unfenced (create-with-seeds + typed add, vocab AND kgiu) | **FIXED.** `vocabLists.ts`: (1) create-with-seeds validation EXISTS now fenced (`v.source_upload_id`, `$3` = userId) — a foreign extracted seed id is silently skipped exactly like a nonexistent one (`appended: 0`); (2) typed-add validation fenced for `vocab` and `grammar` target types (`$2` = userId) → 404 listing the id, indistinguishable from a bad id; `hanja` untouched (no `source_upload_id` column — documented inline). Tests: stranger add of extracted vocab id → 404, extracted kgiu id → 404 (the kgiu leak path), empty list detail; owner positive controls for both paths. |
| B-4 (fences) | Grammar weekly-suggestion + grammar diagnostic-seed fences shipped untested | **FIXED.** Tests added: `/grammar/suggestions/weekly` probed as BOTH stranger and owner — extracted pattern absent from both (the fence is unconditional), untagged control present for both; `pickGrammarSeed` never returns the extracted row (see B-1 row — same test proves both helpers). Deleting `grammar.ts`'s fence line or either seed fence now fails tests. |
| SF-1 / S-3 | Same-user cross-upload cap race; comment + BUILD doc overclaim | **FIXED.** `uploadExtract.ts` claim tx takes `pg_advisory_xact_lock(hashtextextended('f108_extract_daily_cap:' \|\| userId, 0))` before the cap SUM (single-BIGINT form — no int4 truncation; lock ordering is upload-row-lock → advisory, the only path that takes both, so no deadlock cycle; auto-released at commit/rollback). Comment rewritten to state the real guarantee; BUILD doc §2 corrected. S-2 per-user-scope test added: budget burnt on upload A → upload B same user 429; different-user control 201 (an upload-scoped SUM would pass the old test verbatim and fails this one). The race itself is untestable deterministically at route level; the advisory lock + the scope test are the honest pinning. |
| SF-2 | Crash mid-run → permanent 409 (no stale-run recovery) | **FIXED.** At claim time, inside the claim tx (serialized per-upload by the existing `FOR UPDATE`), any `pending/running` run for this upload older than `STALE_RUN_MINUTES` (15) is settled `failed` ("stale run reaped…") before the new claim INSERT. Its `pages_requested` stays in the cap ledger (money was spent). Tests: 20-min-old running row → 201 + old row `failed` with the reap message; 5-min-old running row → still 409 (reaper takes only provably dead claims). |
| SF-3 | `raw.pos` persisted un-revalidated (module header promises every field guarded) | **FIXED.** Curation boundary validates `pos` against the closed OCR-schema enum (`ALLOWED_POS` = n./v./adj./adv./pn.), unknown → null (the conservative bucket: on grammar-bearing uploads a nulled pos classifies as a grammar candidate, which only surfaces behind the owner fence). Test: stub proxy returns a marker-bearing pos → persisted `part_of_speech IS NULL`. |
| SF-4 | `errorSummary` can return `''` → CHECK violation swallowed → run stuck `running` | **FIXED.** `errorSummary` falls back to `'unknown error'` (`msg \|\| 'unknown error'`), exported for direct unit coverage; test pins `new Error('')` and `''` → `'unknown error'`, non-empty passthrough. (Exported rather than integration-forced: the only route-reachable empty-message path requires a mid-tx2 failure that cannot be injected deterministically through the API; the unit test is the honest mutation check.) |
| S-1 (fences) | No automated migration-068 test (repo convention 046–067) | **FIXED.** `db/tests/test_migration_068.py` (full real-chain, mirrors test_migration_060's structure): F-088 marker classification; up on the full chain; body re-applied directly (idempotency); pipeline-shaped live `user_mined` kgiu INSERT passes the relaxed CHECKs (both sentinel and non-sentinel book_level) while a curated-corpus level mismatch still fails; the BLOCKER-1 FK pin (delete parent → row survives, upload_id NULL, cap SUM still counts it); live-claim arbitration incl. orphaned-NULL semantics; down refused without `--allow-destructive`, reverses cleanly on an empty extracted corpus (table+enum gone, original CHECKs restored → user_mined kgiu INSERT rejected again), FAILS LOUDLY on a populated user_mined kgiu corpus, succeeds after deliberate row removal; re-up clean. Note: the orchestrator's known cross-branch 068 filename collision is acknowledged — this file tests THE upload_extractions 068. |
| N-1 | Injection test poisons only `gloss` | **FIXED.** Test now also poisons the `kr` headword (the field that becomes pattern/source_id) — `words_skipped` 2, only the clean sibling persists. |
| N-4 | `DEFAULT_EXTRACT_PAGES` exported with no consumer | **FIXED.** Export dropped (module-private const; the GET payload's wire contract is `max_pages_per_run`, documented at the declaration). |
| NIT-1, NIT-2, NIT-3, N-2, N-3, N-5 | Style/semantics nits | **DEFERRED** per fix-pass scope (orchestrator: fix N-1 + N-4 only). |

## PRAISE items — verified intact

- P-1 tx shape (claim → OCR outside tx → atomic persist+settle): untouched;
  only additive statements inside the existing claim tx.
- P-2 TOCTOU-free partial-UNIQUE claim: intact — the reaper UPDATE and the
  advisory lock both live inside the same claim tx; the INSERT is still the
  arbiter (409 test + a new "recent run still 409s" test).
- P-3 `pages_requested`-based cap counting failed runs: intact and now
  strictly stronger (survives upload deletion).
- P-4 per-word injection skip+count: intact, coverage widened (kr headword).
- P-5 migration discipline: preserved — the 068 edit keeps the enum DO-block,
  IF NOT EXISTS, F-088 markers, CHECK-relax posture, and the fail-loud down;
  now pinned by `test_migration_068.py` instead of a manual scratch run.
- P-6 ownership-404 + `FOR UPDATE` + traversal-checked blob reads +
  `.strict()` bodies: untouched.
- The adversarial browse/detail fence test: untouched; the four original
  fence sites were refactored ONLY in how the identical predicate is composed
  (shared fragment, `bo_fence` alias) — the same test still pins all four,
  plus seven new fence tests.

## Self-assessment vs the bar

- Every blocker fix is atomic (code + failing-if-reverted test in the same
  change) and lands at the root cause, not the symptom: the cost ledger's
  lifetime is now a schema property, and the fence is a single shared
  fragment a future id-accepting route imports rather than re-derives.
- The one deliberate deviation from a review suggestion: SF-4's test is a
  unit test on an exported helper rather than an end-to-end stuck-run
  reproduction — the empty-message path is not deterministically injectable
  through the public API without contorting the proxy stub into running SQL
  mid-OCR; rationale recorded in the table.
- Gate results (all run in full, not trusted): see BUILD doc gate table
  addendum + the fixpass commit message.
