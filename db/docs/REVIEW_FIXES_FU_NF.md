# Review: FU-NF fix-pass

**Reviewer:** Independent senior reviewer (fresh, did not author fixes)
**Date:** 2026-05-29
**Source artifacts under review:**
- `FOLLOW_UPS.md` → "From follow-up-pass surfacings (2026-05-29)"
- `Repository/db/docs/FIX_REPORT_FU_NF.md`
- Code in `Repository/{db,server,tools}/...`

---

## Summary verdict

**PASS WITH CONDITIONS.**

7 of 7 in-scope items are FIXED at the code level. FU-NF-4 correctly remains DEFERRED. However, FU-NF-7 introduces a previously-undocumented **REGRESSION on production-shape data**: tightening `TopikItemModel.type` to a `Literal` will now hard-fail Pydantic validation on four of the five sampled TOPIK writing JSONs, because those files use hyphenated discriminator values (`chart-description`, `complete-the-sentence`, `blank-fill`, `sentence-completion`, `data-description`) that are not in the Literal set. The fix-pass author sampled only `topik_36_writing.json` (which uses the underscored forms) and concluded "no behavioral impact" — that conclusion does not hold. The change is arguably the right direction under ADR-019 §D10 (fail-loud), but it should land alongside an explicit ticket to either (a) normalize the source data or (b) extend the Literal — not silently as a "cosmetic" cleanup.

The other six fixes are clean and align with the Senior Engineer Bar.

---

## Finding-by-finding verification

| ID       | Disposition                              | Notes |
|----------|------------------------------------------|-------|
| FU-NF-1  | FIXED                                    | Both placeholder files exist; runner regex matches; rationale documented in headers |
| FU-NF-2  | FIXED                                    | `MalformedEntryError` raises; source_id + bad value in message; new test covers it end-to-end |
| FU-NF-3  | FIXED                                    | `original_size` used in both `load_topik.py` and `load_vocab_2000.py` (bonus fix) |
| FU-NF-4  | DEFERRED-WITH-DOC                        | Out of scope per fix-pass brief; remains `[ ]` in FOLLOW_UPS.md |
| FU-NF-5  | FIXED                                    | `42P01` caught, cache marked `ready=false` before rethrow; test asserts first=500, second=503 |
| FU-NF-6  | FIXED                                    | "Rolling back" section present in README; references ADR-013 + Bar §1 |
| FU-NF-7  | PARTIALLY-FIXED / REGRESSION-INTRODUCED  | Model tightened correctly but breaks parse on 4/5 production writing JSONs; see Detailed Findings |
| FU-NF-8  | FIXED                                    | `SELECT ... FOR UPDATE` + `UPDATE` in same `withTransaction`; 404 vs 409 split correctly; cross-user 404 verified |

---

## Bar checklist (post-fix state)

| Bar item                                                  | Status                                                              |
|-----------------------------------------------------------|---------------------------------------------------------------------|
| Migrations reversible (both directions)                   | PASS — 007 up + down both no-op `SELECT 1;`                          |
| Idempotency preserved                                     | PASS — no new state-mutating operations                              |
| Fail-loud on malformed input                              | PASS — `MalformedEntryError` aligns with ADR-019 §D10                |
| Optimistic concurrency preserved                          | PASS — `version` check + `FOR UPDATE` row lock in vocab.ts           |
| Parameterized queries / no SQL injection                  | PASS                                                                 |
| No `any` casts (TS strict)                                | PASS — `isUndefinedTableError` is a narrow type guard                |
| Structured logging (no `print`/`console.log`)             | PASS                                                                 |
| Tests added with behavioral changes                       | PASS for FU-NF-2, FU-NF-5, FU-NF-8                                   |
| Tests added for FU-NF-3                                   | N/A per brief — no skipped-count assertion existed                   |
| Production data still parses                              | **FAIL** — FU-NF-7 breaks 4/5 sampled TOPIK writing JSONs           |
| Reversible-by-default                                     | PASS                                                                 |
| Documentation updated where behavior changed              | PASS — README.md rolling-back, FIX_REPORT_FU_NF.md, FOLLOW_UPS.md    |

---

## New findings

### BLOCKER

**B1. FU-NF-7 regresses TOPIK writing-JSON ingestion.**
`Repository/tools/ingest/loaders/models.py:142-144` constrains `TopikItemModel.type` to `Literal["short_answer_blanks", "chart_description", "essay"] | None`. The fix-report (`FIX_REPORT_FU_NF.md` §FU-NF-7) claims sampling `output/topik_36_writing.json`, `topik_37_writing.json`, `topik_41_writing.json` confirmed `chart_description` is the only non-MCQ type in real data. Verification across the actually-present writing fixtures (`Repository/tools/ingest/output/topik_{36,47,52,64,96}_writing.json`):

```
topik_36_writing.json: short_answer_blanks, chart_description, essay   ← only file matching the Literal
topik_47_writing.json: sentence-completion, chart-description, essay   ← hyphen form, NOT in Literal
topik_52_writing.json: complete-the-sentence, chart-description, essay ← hyphen form, NOT in Literal
topik_64_writing.json: blank-fill, data-description, essay             ← hyphen form, NOT in Literal
topik_96_writing.json: sentence-completion, chart-description, essay   ← hyphen form, NOT in Literal
```

`build_write.py` (the generator at `Repository/tools/ingest/_work/build_write.py:10,15,19`) writes these hyphenated values verbatim into the JSON. Pydantic will now raise `ValidationError` at `TopikDocumentModel.model_validate_json(raw)` on `load_topik.py:71` for these four files. Existing test fixture (`tests/fixtures/topik_mini_reading.json`) doesn't include a `type` field, so the test suite will not catch this — explaining the report's claim that "no test regression expected."

**Recommended remediation (any one):**
- (a) Add hyphen forms to the Literal: `Literal["short_answer_blanks", "chart_description", "essay", "blank-fill", "chart-description", "sentence-completion", "complete-the-sentence", "data-description"] | None`, and have `_resolve_item_type` normalize them to the underscored canonical enum values. Preserves both ingestion and fail-loud guarantees.
- (b) Add a pre-validation normalization step (`@field_validator(mode="before")`) that maps hyphen → underscore before the Literal check.
- (c) Fix the source data: re-run `build_write.py` with canonical names and regenerate all writing JSONs.

(a) or (b) is the minimum-risk path. (c) is the cleanest long-term answer but should be a separate ticket.

This is a BLOCKER only because the fix-report and FOLLOW_UPS.md both claim FIXED without caveat. If the report is updated to flag the regression and a follow-up ticket is opened (FU-NF-9 or similar), this becomes a SHOULD-FIX.

### SHOULD-FIX

**S1. FU-NF-5 — cache write happens before the `throw err`, which is correct, but the `markKrdictUnavailable()` call mutates module state inside a request handler.**
`Repository/server/src/routes/define.ts:140-143`. Behaviorally correct. The trade-off is documented inline. No action required — flagging only because a future reviewer should not "clean this up" by moving the cache write into the error-handler middleware (which would lose the symmetry guarantee).

**S2. FU-NF-8 — the `INSERT INTO card_reviews` runs inside the same transaction as the version UPDATE, which is correct, but a comment would help.**
`Repository/server/src/routes/vocab.ts:215-238`. The audit-log row insert isn't called out as ACID-tied to the version bump; a 1-line comment ("audit row written in the same tx so a rolled-back UPDATE doesn't leave an orphan review") would make the intent obvious. Minor.

### NIT

**N1. FU-NF-3 fix in `load_vocab_2000.py:104` adds a comment cross-referencing FU-NF-3 by ticket ID.** Good practice, kept.

**N2. FU-NF-7 docstring** for `_resolve_item_type` claims "the branch list is the full universe of legal values (plus `None`)." If B1 above is fixed by expanding the Literal, this docstring will need a matching update.

**N3. FU-NF-1 placeholder body** is `SELECT 1 AS migration_007_skip_placeholder;`. The label is harmless but slightly silly — `SELECT 1;` is sufficient. Cosmetic only; leave it.

### PRAISE

**P1. FU-NF-2** is exemplary: structured `logger.error` with full context BEFORE the raise; the exception type is domain-specific (`MalformedEntryError(ValueError)`); the new test verifies (a) the raise, (b) no partial rows, (c) `load_state.status='failed'` — exactly the three properties that matter. Tracing the exception path through `_insert_item_batch` → outer `except Exception` → `mark_failed` confirms the test claim holds end-to-end.

**P2. FU-NF-5** test (`define.test.ts:120-149`) uses `ALTER TABLE ... RENAME TO ... _hidden` to simulate a rollback without actually dropping data. Clever, reversible (the `finally` renames it back), and isolated by `beforeEach` cache reset. This is how integration tests should be written.

**P3. FU-NF-8** correctly recognizes that `FOR UPDATE` serializes concurrent reviewers — the alternative (advisory lock, SELECT + UPDATE without lock) would leak race windows. The choice is documented inline at `vocab.ts:163-167`.

**P4. FU-NF-1** decision matrix (placeholder vs. renumber) is documented IN the migration file headers themselves — future operators will read the rationale without having to chase the runbook. Good co-location of decision context.

**P5. FU-NF-6** README addition references both ADR-013 and Senior Engineer Bar §1 — preserves the link to "why" not just "what."

---

## Detailed findings (for non-FIXED rows)

### FU-NF-7 — REGRESSION-INTRODUCED

**File:** `Repository/tools/ingest/loaders/models.py:117-144`

**Claim in FIX_REPORT_FU_NF.md:** "sampling the topik writing JSONs (`output/topik_36_writing.json`, `topik_37_writing.json`, `topik_41_writing.json`) confirms `chart_description` IS used in real data."

**What I verified:**
1. Listed actual writing JSONs in `Repository/tools/ingest/output/`: `topik_{36,47,52,64,96}_writing.json` are present. `topik_37_writing.json` and `topik_41_writing.json` (named in the report) are NOT in the directory.
2. Extracted all `"type": "..."` values from the present files:
   - Only `topik_36_writing.json` uses the underscored canonical forms (`short_answer_blanks`, `chart_description`).
   - The other four use HYPHENATED forms (`sentence-completion`, `complete-the-sentence`, `blank-fill`, `chart-description`, `data-description`).
3. Confirmed the source: `Repository/tools/ingest/_work/build_write.py:10,15,19,25,34,39,43,49` writes the hyphenated values directly.
4. `TopikDocumentModel.model_validate_json` (load_topik.py:71) runs Pydantic strict validation; `StrictBase` rejects unknown values for a `Literal` field. These four files will fail to parse.
5. The test fixture (`tests/fixtures/topik_mini_reading.json`) has no `type` field, so the property tests pass — but they exercise the `None`/inferred-MCQ branch only.

**Pre-fix behavior:** `type: str | None` accepted any string; `_resolve_item_type` returned `multiple_choice` for unknown values (silently miscategorizing writing items as MCQ). That was a real bug, but the file at least loaded.

**Post-fix behavior:** four writing JSONs cannot be ingested at all. Whether that's a net improvement depends on whether the pipeline was actually loading them. If they were being loaded as MCQ (wrong, but loaded), the fix is a behavioral regression. If they were already being skipped or failing for another reason, the fix is neutral.

**Recommended actions (in priority order):**
1. Open a follow-up ticket (FU-NF-9?) tracking the data-shape mismatch.
2. Pick a remediation from the BLOCKER section above (preference: option (a) or (b) — extend the Literal or add a pre-validator normalization).
3. Update `FIX_REPORT_FU_NF.md` §FU-NF-7 to flag the regression rather than claim full closure.
4. Update FOLLOW_UPS.md FU-NF-7 status from `[x]` back to `[~]` until the data-shape question is resolved.

---

## Recommendation

**Approve with one blocker:** Land 7-of-8 fixes (FU-NF-1, 2, 3, 5, 6, 8 + the corrected disposition of 4 as DEFERRED). For FU-NF-7, either revert the Literal tightening or land the normalization layer in the same change so production data continues to parse. Until that's resolved, FU-NF-7 should not be marked closed.

After remediation, the fix-pass meets the Senior Engineer Bar:
- All migrations are reversible.
- Loaders fail loud per ADR-019 §D10.
- Concurrency contracts are preserved (optimistic version + `FOR UPDATE` row lock).
- 404/409 distinction is API-correct and cross-user-safe.
- Cache symmetry on rollback is documented and tested.

Nothing else in the fix-pass is at risk.
