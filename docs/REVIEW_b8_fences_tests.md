# REVIEW b8 — F-108 fences + test suite + cross-cutting consistency

**Reviewer scope:** owner-only visibility fences (`vocab.ts` / `grammar.ts` / `diagnostic.ts` diffs), `server/tests/routes/uploadExtract.test.ts` (full), cross-cutting consistency across F-108 files. Service + migration read as context; build-doc claims verified, not trusted.
**Branch:** `feat/f108-u2-extraction` (worktree `.claude/worktrees/f108-ocr`, commit 90384b1)

## Summary verdict

**FAIL — 4 BLOCKERS.** The four fences that were shipped are correctly written, correctly parameterized, and the browse/detail fences are pinned by a genuinely adversarial test. But the fence was applied only to *read-display* paths. Three **id-referencing paths that return or re-surface entry content were missed** — the diagnostic vocab seed pool, the vocab bank route, and the vocab-list membership paths — and each one lets extracted private rows reach another user. Two of the four shipped fences (weekly suggestions, grammar diagnostic seed) have **no test at all**, and migration 068 has no automated up/down test despite every migration 046–067 having a dedicated one.

## Bar checklist

| Bar item | Fence present | Tested | Verdict |
|---|---|---|---|
| Browse fence — `GET /vocab/entries` | vocab.ts:157–161, param $8 = userId (verified) | uploadExtract.test.ts:587–589 (q ILIKE probe) | PASS |
| Detail fence — `GET /vocab/entries/:id` | vocab.ts:525–529, $2 = userId | test.ts:595 | PASS |
| Browse fence — `GET /grammar/kgiu` | grammar.ts:107–110, $7 = userId | test.ts:590–594 | PASS |
| Detail fence — `GET /grammar/kgiu/:id` | grammar.ts:163–166, $2 = userId | test.ts:596 | PASS |
| Weekly-suggestion pool (grammar) | grammar.ts:452 (`source_upload_id IS NULL`) | **NO TEST** | **B-4** |
| Weekly-suggestion pool (vocab) | Implicit — corpus allow-list `IN ('vocab_2000_beginner','vocab_2000_intermediate')` (vocab.ts, weekly query ~L799–804) excludes `user_mined`. Verified safe. | n/a (pre-existing filter) | PASS |
| Diagnostic pool — grammar seed | diagnostic.ts:419–426 | **NO TEST** | **B-4** |
| Diagnostic pool — vocab seed | **NO FENCE** (diagnostic.ts:393–395) | no test | **B-1** |
| Other id-referencing paths (bank, lists) | **NO FENCE** (vocab.ts:570–578; vocabLists.ts:241–243, :561) | no test | **B-2 / B-3** |
| Proxy always mocked | — | test.ts:8–11, 43, 46, 113; no real Vision call anywhere | PASS |
| Cost-cap 429 before upstream | — | test.ts:322–347 (spy + failed-run counting) | PASS (scope gap → S-2) |
| Run-claim 409 race | — | test.ts:349–363, trips the real partial unique index | PASS (see N-3) |
| Tx atomicity (no half-write) | — | test.ts:525–545 | PASS |
| Injection-word skip + count | — | test.ts:482–506 | PASS (gloss field only → N-1) |
| Cross-user 404 (POST + GET) | — | test.ts:365–379 | PASS |
| Idempotent re-trigger | — | test.ts:299–320 | PASS |
| Migration up/down automated test | — | **db/tests/test_migration_068.py does not exist** | **S-1** |
| Config cap wired + sane default | config/index.ts:59–66, default 50, consumed at uploadExtract.ts:507 | via cap test | PASS |
| Consistent AppError mapping | `ExtractionDailyCapError extends AppError` 429/`rate_limited`; `mapClaudeError` passthrough mirrors /images/ocr | test.ts:444–464 | PASS |
| Strict TS at boundaries | `.strict()` bodies (uploads.ts diff), typed Row/DTO split | test.ts:231–240 | PASS |
| No dead code / TODO | zero TODO/FIXME across F-108 files | — | PASS (N-4 minor) |

## Findings by category

**BLOCKER**
- B-1 — `pickVocabSeed` has no fence: extracted rows enter every user's diagnostic pool.
- B-2 — `POST /vocab/entries/:entryId/bank` unfenced: existence oracle + full content exfiltration via the cards join.
- B-3 — vocab-list membership validation unfenced (both seed and add paths, vocab **and** kgiu ids): content leak via list detail.
- B-4 — Two shipped fences (grammar weekly suggestions, grammar diagnostic seed) have no test; build doc's gate table claims "visibility fences" tested.

**SHOULD-FIX**
- S-1 — No automated migration 068 up/down test (repo convention: test_migration_046..067 all exist).
- S-2 — Cap test cannot distinguish per-user from per-upload cap scoping.
- S-3 — Cap-concurrency claim overstated in service comment + build doc (different-upload races can overshoot the cap).

**NIT**
- N-1 — Injection test poisons only `gloss`, not `kr`/`en`.
- N-2 — Resume test doesn't pin that a *failed* run does not advance the resume pointer.
- N-3 — 409 test seeds a live row rather than racing two in-flight requests (acceptable; note only).
- N-4 — `DEFAULT_EXTRACT_PAGES` exported with no external consumer.
- N-5 — Cap day boundary uses server-TZ `date_trunc('day', now())` while weekly features use Asia/Seoul ISO weeks.

**PRAISE** — see end; must not be undone by the fix pass.

## Detailed findings

### B-1 (BLOCKER) — Diagnostic vocab seed pool is unfenced; extracted rows leak into other users' diagnostics
`server/src/routes/diagnostic.ts:390–401`:

```sql
SELECT id::text AS id, korean, english
  FROM vocab_entries
 WHERE korean IS NOT NULL AND length(korean) >= 1
```

No `source_upload_id IS NULL`. The twin helper `pickGrammarSeed` got exactly this fence in this very diff (diagnostic.ts:419–426) — the asymmetry marks this as an oversight, not a decision. It is made worse by the persist sentinel: extracted vocab rows are written with `proficiency = 'L3'` (`services/uploadExtract.ts:353`), and `seedProficiencyForTarget` maps L3 targets to `'L3'` (diagnostic.ts:384–386), so an extracted word matches on the **first** (proficiency-filtered) pass, not just the any-band fallback — private book content (`korean` + `english`) is fed as the seed for diagnostic items generated for *any* user. This is precisely the diagnostic-pool leak the bar names. The build doc (docs/BUILD_b8_f108_ocr.md:122–124) lists only `pickGrammarSeed` and silently omits the vocab seed.

**Fix:** add `AND source_upload_id IS NULL` to the `pickVocabSeed` SQL (same comment block as the grammar twin), plus a test seeding an extracted row into an otherwise-empty `vocab_entries` and asserting the seed helper / diagnostic generation never selects it.

### B-2 (BLOCKER) — `POST /vocab/entries/:entryId/bank` bypasses the detail fence: existence oracle + content exfiltration
`server/src/routes/vocab.ts:570–578` (existence check inside the bank transaction):

```sql
SELECT proficiency
  FROM vocab_entries
 WHERE id = $1
 LIMIT 1
```

No fence. The detail route was carefully fenced so "another user probing sequential ids must get the same 404 as a missing id" (vocab.ts:517–519) — but a stranger can `POST /vocab/entries/:id/bank` against the same sequential BIGINT ids and get 201 vs 404, defeating that fence as an existence oracle. Worse: banking creates a real `vocab_cards` row, and `GET /vocab/cards/due` joins `vocab_entries` unconditionally on the FK (vocab.ts:334–336) and returns `ve.korean, ve.english, ve.example_korean, ve.example_english, ve.source_book` inline. Net: a non-owner can enumerate ids, bank a foreign extracted entry, and read its full content out of their own review queue. (The quiz route at vocab.ts:919 and hanja.ts:272 join through the user's own cards, so they leak only downstream of this hole.)

**Fix:** apply the same `(source_upload_id IS NULL OR EXISTS(owner))` predicate to the bank existence check (it already runs inside a client tx with `userId` in scope), and add a stranger-banks-extracted-id → 404 test. `POST /vocab/cards/init` is safe as-is — `InitBodySchema` restricts corpus to the two curated corpora (vocab.ts:442–446).

### B-3 (BLOCKER) — Vocab-list membership validation is unfenced for BOTH tables: content leak via list detail
`server/src/routes/vocabLists.ts` — two id-acceptance paths validate bare existence with no fence:

- List create with seeds (vocabLists.ts:241–243): `WHERE EXISTS (SELECT 1 FROM vocab_entries v WHERE v.id = s.entry_id)`
- Add entries (vocabLists.ts:561): `SELECT id FROM ${TARGET_TABLE[t]} WHERE id = ANY($1::bigint[])` — `TARGET_TABLE` covers `vocab_entries` **and** `kgiu_entries` (vocabLists.ts:96–98)

A stranger can add a foreign extracted vocab or kgiu id to their own list; `GET` list detail (vocabLists.ts:341–366) then returns `v.korean, v.english, v.example_korean, v.example_english` and `g.pattern, g.title_en` inline. This is the only unfenced path that leaks extracted **kgiu** content (B-2 covers vocab), and it also functions as an existence oracle (404-with-ids vs success). Same class as B-2: the fence exists only where entries are *displayed from the corpus tables directly*, not where entry ids are *accepted and later re-displayed*.

**Fix:** add the owner-EXISTS-or-NULL predicate to both validation queries (userId is in scope in both handlers), plus stranger-adds-extracted-id → 404 tests for the vocab and grammar target types.

### B-4 (BLOCKER) — Two of the four shipped fences have no test
The suite's fence test (uploadExtract.test.ts:547–598) covers browse + detail for both tables — and covers them well (see PRAISE). But:

- `/grammar/suggestions/weekly` fence (grammar.ts:452): no test anywhere seeds an extracted kgiu row and asserts it is absent from the weekly picks. The pre-existing suggestion tests (server/tests/routes/grammar.test.ts:643–760) never touch `source_upload_id`.
- `pickGrammarSeed` fence (diagnostic.ts:426): no test.

The bar requires each fence proven; the build doc's test-to-bug-class map (docs/BUILD_b8_f108_ocr.md:151–152) claims "visibility fences (private-content leak)" are covered, which is true only for 2 of the 4 shipped fences. An extracted kgiu row is a *strong* suggestion-pool candidate absent the fence (`entry_type='grammar'`, non-empty pattern, never banked), so the missing test is not hypothetical: deleting `grammar.ts:452` today fails zero tests. Given these fences are the feature's core data-leak control, untested = blocker.

**Fix:** (a) suggestions — run an extraction (or seed a `source_upload_id`-tagged kgiu row), call `/grammar/suggestions/weekly` as another user AND as the owner, assert the pattern is absent from both (the fence is unconditional by design); (b) diagnostic — same seeding, assert the seed helpers never return the extracted row (an otherwise-empty table makes this deterministic, as the existing suite's TRUNCATE already ensures).

### S-1 (SHOULD-FIX) — No automated migration test for 068
`db/tests/` contains `test_migration_046.py` … `test_migration_067.py` — a dedicated real-chain pytest per migration is this repo's convention — but no `test_migration_068.py`. The generic harness files cover only 001/002 (`test_migrations_real.py:15–17`: "Later migrations (003+) are covered by their own A-* tickets"). The build doc's migration gate row (BUILD_b8_f108_ocr.md:143) describes a **manual** scratch-Postgres run — unrepeatable in CI. 068's down has exactly the kind of behavior real-chain tests exist to pin: verbatim CHECK restoration that **fails loudly when `user_mined` kgiu rows exist** (068_upload_extractions.down.sql:13–20, 46–62), the partial unique index, and the strictly-more-permissive CHECK relaxation. Per the standing full-suite-for-schema-changes rule (P2-G1), this must be automated before merge.

### S-2 (SHOULD-FIX) — Cap test can't prove per-user scope
uploadExtract.test.ts:322–347 seeds the budget-burning run on the **same upload** it then triggers. An implementation that (wrongly) scoped the cap SUM to `upload_id` instead of `user_id` would pass this test verbatim. Add a variant: burn the budget via a run on upload A, trigger upload B (same user) → 429; and optionally a different-user control → 201. This also pins the cost story the config comment promises (config/index.ts:59–66).

### S-3 (SHOULD-FIX, coordination) — Cap-concurrency claim overstated
`services/uploadExtract.ts:495–498` ("inside the claim tx so two concurrent triggers can't both read a pre-spend total") and BUILD doc §2 ("checked inside the claim transaction") overstate the guarantee: the claim tx's `FOR UPDATE` locks only *this* upload's `book_uploads` row (uploadExtract.ts:448–453), and the partial unique index is per-upload. Two concurrent triggers on **different uploads** of the same user both read the pre-spend SUM under READ COMMITTED and both claim — the daily cap can overshoot by up to (concurrent runs − 1) × 20 pages. For a single-user personal app the exposure is bounded and low, but the comment and doc should say "per-upload serialization; cross-upload races can transiently exceed the cap" — or take a per-user advisory lock. Service file is the service reviewer's scope; flagged here because the build-doc claim was mine to verify and it does not hold as written.

### NITs
- **N-1** — Injection test (test.ts:491) puts the marker only in `gloss`. `curateOcrWords` sanitizes `kr`/`en` too (uploadExtract.ts:261–262); one extra word with a marker in `kr` would cover the headword path, which is the one that becomes `pattern`/`source_id`.
- **N-2** — Resume default filters `status = 'done'` (uploadExtract.ts:461–463); no test pins that a **failed** run's `page_to` does not advance the pointer (a regression to `MAX(page_to)` over all runs would silently skip failed pages).
- **N-3** — The 409 test (test.ts:349–363) seeds a live row rather than racing two in-flight POSTs. Acceptable: there is no TOCTOU pre-check to falsely satisfy — the claim INSERT itself trips `uq_upload_extractions_upload_live` (068 up.sql:156–158) and the 23505→409 mapping (uploadExtract.ts:538–543) is exercised for real. A true two-concurrent-request test would be strictly stronger; not required.
- **N-4** — `DEFAULT_EXTRACT_PAGES` is exported (uploadExtract.ts:102) but has no consumer outside the module (grep: only its own line 469). Drop the `export`, or surface it in the GET payload next to `max_pages_per_run` so the client can render the default slice.
- **N-5** — Cap day boundary is `date_trunc('day', now())` (server TZ, uploadExtract.ts:503) while the codebase's weekly features deliberately use Asia/Seoul ISO weeks (`ISO_WEEK_SQL`). Harmless for a cost cap; note for consistency.

## PRAISE (must not be undone)

- **The browse/detail fence test is genuinely adversarial, not tautological** (test.ts:547–598): the stranger probe searches by the secret headword through the real ILIKE path (`q=비밀단어` — vocab browse ILIKEs `korean`, verified at vocab.ts:131–134), tables are TRUNCATEd so the extracted row is the only candidate, both detail ids are probed directly, and the owner positive-control proves the fence isn't just "hide everything". Removing any of the four shipped fences fails an assertion.
- **429-before-upstream is proven, not asserted** (test.ts:322–347): a proxy spy pins "no Vision call", the run-row count pins "nothing claimed", and seeding the burn as a *failed* run pins the failed-runs-count cost posture.
- **The atomicity test proves the interesting thing** (test.ts:525–545): counts visible inside the tx, rows gone after rollback — a real half-write proof, not a mock.
- **The claim design has no TOCTOU pre-check**: the INSERT against the partial unique index *is* the arbiter (uploadExtract.ts:525–543), and the 409 test trips the real index.
- **Fence SQL is consistent and correctly parameterized** across all four sites — same `(source_upload_id IS NULL OR EXISTS …)` shape, `bo` alias distinct from the pre-existing `bu`, and I verified $8 (vocab browse), $7 (kgiu browse), $2 (both details) all bind `userId`.
- **Error-mapping and config conventions match neighbors**: `ExtractionDailyCapError` mirrors imageIngest's `DailyCapError` (429/`rate_limited`), `mapClaudeError` passthrough matches `/images/ocr` (pinned at test.ts:444–464), `UPLOAD_EXTRACT_DAILY_PAGE_CAP` follows `BOOK_UPLOAD_DAILY_CAP`'s schema style with a documented, sane default.
- **Migration 068's down migration documents and enforces the correct destructive posture** (fails loudly on populated extracted corpus, mirroring 022 verbatim), and the doc's "20/20 tests" claim is accurate (I counted 20).

## Coordination observations (for the aggregator / other reviewers)

1. **Root cause of B-1/B-2/B-3 is architectural, one sentence for the fix agent:** the fence was applied where corpus rows are *listed/displayed*, not where corpus *ids are accepted from the client*. Any route that takes a `vocab_entries`/`kgiu_entries` id (bank, lists — and any future one) needs the same predicate. Recommend the fix extracts a shared SQL fragment or a documented checklist comment on both tables' migrations.
2. **For the service reviewer:** S-3 (cap race across uploads) lives in `services/uploadExtract.ts:495–507`; also note `settleFailed` swallowing is fine but its `pages_ocred` argument records pre-persist counts on persist-failure — worth a glance, not flagged.
3. **For the fix pass:** B-2/B-3 fixes touch routes outside the F-108 diff (`vocab.ts` bank, `vocabLists.ts`) — regression-run those routes' full suites, and per the schema-change standing rule, run the FULL server + db suites, not the changed slice.
4. `/vocab/suggestions/weekly` needs **no** change — its corpus allow-list already excludes `user_mined`; do not "fix" it into the unconditional-NULL shape and accidentally change curated behavior.
