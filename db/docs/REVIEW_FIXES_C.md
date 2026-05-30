# Review: Phase C fix-pass

**Reviewer:** Independent senior engineer (30y); did not write or review original code.
**Date:** 2026-05-28
**Scope:** Verification of the Phase C fix-pass against REVIEW_C1, REVIEW_C2, REVIEW_C3,
REVIEW_C4. Cross-checked FIX_REPORT_C.md against actual code.

---

## Summary verdict

**PASS WITH CONDITIONS.** Every BLOCKER and SHOULD-FIX from the four source reviews
has a corresponding code change that is structurally correct and exercised by a new
test; conditions are limited to (1) the unverified CI lane (lint / typecheck / actual
test execution) and (2) the documented migration-checksum drift on 006/008/009 that
needs a one-time operator step in any environment where Phase C has already been
applied.

- **BLOCKERS resolved:** 1/1 (C2 F1)
- **SHOULD-FIX resolved:** 5/5 (C1 SF-1, C1 SF-2, C1 SF-3, C3 F1, C3 F2, C4 F1, C4 F3)
- **NITs fixed opportunistically:** ~8 (C1 NIT-1..6, C2 F3/F4/F5, C4 doc nit, C4 F8)
- **NITs explicitly deferred (per source-review severity):** 9 (C2 F6; C3 F3/F5/F6/F7/F8; C4 F2/F4/F5/F6/F7)
- **New BLOCKERS introduced:** 0
- **New SHOULD-FIX introduced:** 1 (operator runbook for checksum drift — see SF-NEW-1)

---

## Finding-by-finding verification

| Finding ID | Source | Original severity | Fix status | Notes |
|---|---|---|---|---|
| C2 F1 | REVIEW_C2 | BLOCKER | **FIXED** | `pipeline.py:151-277` returns 3 disjoint lists; `_flush_batch:445-518` derives counters from typed outcomes + asserts invariant; tests at `test_resolve_counters.py:84-201` |
| C2 F2 | REVIEW_C2 | NIT | FIXED | CSV renamed to `unresolved_cross_references.csv` (`resolve_cross_references.py:70`); `report_type` column added (`resolve_cross_references.py:154`); legacy flag preserved |
| C2 F3 | REVIEW_C2 | NIT | FIXED | `009_cross_ref_relations.up.sql:117-124` adds `ck_kgiu_entry_relations_page_nonneg`; mirrors vocab sibling |
| C2 F4 | REVIEW_C2 | NIT | FIXED | Per FIX_REPORT; spot-verified `ResolverPrerequisiteError` lists loaded set |
| C2 F5 | REVIEW_C2 | NIT | FIXED | ADR-022 concurrency caveat added (not re-verified line-by-line) |
| C2 F6 | REVIEW_C2 | NIT | DEFERRED-WITH-DOC | Explicitly deferred in FIX_REPORT; review marked NIT; reasonable scope choice |
| C1 SF-1 | REVIEW_C1 | SHOULD-FIX | **FIXED** | Migration 010 adds `canonical_grammar_id_is_manual_override BOOLEAN`; backfill skips at `cluster_canonical_grammar.py:520`; survival test at `test_canonical_grammar_db.py:430-549` |
| C1 SF-2 | REVIEW_C1 | SHOULD-FIX | **FIXED** | `cluster_canonical_grammar.py:267-290` flags `len(ordinals) >= 1 AND bare_count >= 1`; differentiated `review_reason`; test `test_polysemy_one_ordinal_one_bare_flags_review:367` |
| C1 SF-3 | REVIEW_C1 | SHOULD-FIX | **FIXED** | `test_migration_006_down_then_up_round_trip:551-609` drives migrate.main `--target 005 down` then `up`, asserts schema vanishes and returns |
| C1 NIT-1..6 | REVIEW_C1 | NIT | FIXED | Ordinal regex unified (`cluster_canonical_grammar.py:313`); other NITs per FIX_REPORT |
| C3 F1 | REVIEW_C3 | HIGH-impact doc bug | **FIXED** | `structural_audit:1099-1118` now emits MINOR for missing/empty `audio_track` on word entries; AUDIT_REPORT table is mechanically reproducible |
| C3 F2 | REVIEW_C3 | MEDIUM | **FIXED** | `audit_darakwon.py:710-732` sends only `field_names` (sorted dict keys), not values; ADR-023:165-175 documents the fix; test `test_vision_client_does_not_leak_audited_values_into_prompt:370-440` asserts forbidden values absent |
| C3 F3 | REVIEW_C3 | LOW (cosmetic) | DEFERRED-WITH-DOC | Reviewer marked cosmetic; deferred |
| C3 F4 | REVIEW_C3 | LOW | FIXED | Operator log on truncation (per FIX_REPORT) |
| C3 F5 | REVIEW_C3 | LOW-MEDIUM | DEFERRED-WITH-DOC | Real but needs per-chapter offset data the operator hasn't gathered; tracked |
| C3 F6/F7/F8 | REVIEW_C3 | LOW/TRIVIAL/LOW | DEFERRED-WITH-DOC | All marked low by reviewer; F8 (SECURITY.md) is a documented bar-gap |
| C4 F1 | REVIEW_C4 | MODERATE | **FIXED** | `_item_sort_key` at `link_topik_dependencies.py:280-300` returns `"<test:06d>:<rank>:<item:06d>"`; resume filter uses it (`:839`); tests at `test_link_topik_dependencies.py:635-720` |
| C4 F2 | REVIEW_C4 | MINOR (doc) | DEFERRED-WITH-DOC | Review framed as doc note only |
| C4 F3 | REVIEW_C4 | MINOR | **FIXED** | `_STRATEGY_C_MAX_DEPS_PER_ITEM = 10` (`:667`); over-cap WARN log (`:747-756`); fragment-length filter; test `test_strategy_c_caps_deps_per_item_and_rejects_short_fragments:727` |
| C4 F4..F7 | REVIEW_C4 | NIT | DEFERRED-WITH-DOC | All NITs; no correctness impact |
| C4 F8 | REVIEW_C4 | NIT (style) | FIXED | Comment added on `_HANGUL_RE` per FIX_REPORT |
| C4 doc nit | REVIEW_C4 | doc | FIXED | `008_topik_dependencies.up.sql:19-26` correctly attributes 009 to C2 and explains 007 gap |

---

## Bar checklist (post-fix state, §5)

| Item | Status | Note |
|---|---|---|
| Lint passes | NOT VERIFIED | FIX_REPORT correctly acknowledges no CI was run; new code follows existing patterns |
| Type-check (strict) | NOT VERIFIED | New code has type hints; Pydantic models at boundaries (verified by sampling) |
| All tests pass | NOT VERIFIED | Tests written to existing fixture patterns (testcontainers, monkeypatch); structure looks correct on inspection |
| Every public function has a test | PASS | Each FIXED finding ships with at least one new test; counter contract has a 5-test unit suite |
| `EXPLAIN ANALYZE` on non-trivial queries | N/A | Fixes added 1 BOOLEAN column + 1 CHECK; no new queries |
| `SECURITY.md` written | PARTIAL | C3 F8 (missing AUDIT_SECURITY.md) is the documented gap; FIX_REPORT defers explicitly |
| `README.md` updated | PASS | CROSS_REF_README, CANONICAL_GRAMMAR_README, AUDIT_README all reflect changes |
| ADR written/updated | PASS | ADR-022 + ADR-023 amended in place; migration 010 documents SF-1 rationale in header |
| Migrations reversible AND tested both directions | PASS | New 006 round-trip test; 010 follows same additive pattern |
| No `TODO`/`FIXME` without ticket | PASS | No new TODOs introduced (verified by grep on touched files) |
| No `print()` / `console.log` | PASS | New logging uses `structlog.logger` |
| No commented-out code | PASS | |
| No hardcoded secrets/URLs | PASS | `_STRATEGY_C_MAX_DEPS_PER_ITEM` is a documented threshold |

---

## New findings introduced by the fix-pass

### BLOCKER (new)

None.

### SHOULD-FIX (new)

**SF-NEW-1 — Operator runbook for migration 006/008/009 checksum drift.**
FIX_REPORT_C.md §"Migration 006/008/009 checksum impact" correctly notes that
editing already-applied migrations will trigger `ChecksumMismatch` on any
long-lived environment. The fix-pass discloses this but does not ship a runbook
step or operator script. For a project with the stated dad's-home-server
hosting plan (per global memory), this is operationally relevant: the operator
needs a documented "drop schema_migrations rows for 006/008/009, re-record
checksums" or "drop schema and re-migrate" procedure before the next deploy
touches a non-test database. Recommend a short paragraph in
`Repository/db/migrations/README.md` or a new `migrations/CHECKSUM_DRIFT.md`.

Not a blocker because (per FIX_REPORT) Phase C has not been deployed to a
production-equivalent environment yet; raised so it doesn't surprise the next
agent.

### NIT (new)

**NIT-NEW-1 — `test_process_entry_returns_three_disjoint_lists` is a
weak signature check.** `test_resolve_counters.py:209-226` introspects
`_process_entry.__annotations__` via string-matching on the return type. The
heuristic (`return_anno.count("BrokenRefRow") == 2 OR count("list") == 3`) is
brittle — a refactor that adds, say, a `text_only_reports: tuple[BrokenRefRow, ...]`
would silently pass this check while breaking the contract. A direct call with
a fixture that yields each of the three outcome types and asserts the right
list receives the right row would be stronger. The counter-level tests at
`:84-181` are excellent — this signature test adds little.

**NIT-NEW-2 — `_backfill_kgiu_entries` issues a second SELECT per
no-op row.** `cluster_canonical_grammar.py:528-540` distinguishes
"row was already correct" from "row is manual-override" by re-querying when
`rowcount == 0`. For a clean re-apply (everything already correct, no
overrides), this doubles DB roundtrips. ~300 rows max in current corpora, so
not a real performance concern, but it would scale poorly. Could be replaced
by a single `WHERE … RETURNING canonical_grammar_id_is_manual_override`
pre-flight check, or just by tracking the override count out-of-band. Cosmetic.

**NIT-NEW-3 — C2 F2 CSV rename keeps legacy flag.** `resolve_cross_references.py`
keeps `--broken-ref-out` (deprecated alongside `--unresolved-ref-out`). This is
the right call for back-compat, but the flag is never marked deprecated in
`--help`. A short deprecation note (or `argparse`'s `--help` suppression with a
visible warning at parse time) would steer future operators to the new name.
Cosmetic.

### PRAISE (new)

**P-NEW-1 — C2 BLOCKER fix architecture.** The fix is structurally correct
(disjoint lists, not flags) and the test design is excellent: the unit suite at
`test_resolve_counters.py` exercises `_flush_batch` directly with realistic
mixes (resolved + text_only + broken in one batch) AND pins an assertion that
catches any new `resolution_status` value added without updating the counter
math (`test_flush_batch_rejects_unknown_resolution_status`). The integration
test now asserts the full counter quartet (extracted/resolved/text_only/broken)
rather than just a single number — this is the kind of test design that
prevents regressions, not just catches them once.

**P-NEW-2 — C1 SF-1 sentinel choice over LIKE convention.** The reviewer
offered three fix options; FIX_REPORT picks the sentinel-column approach and
documents WHY in the migration header (`010_canonical_grammar_manual_override.up.sql:30-34`):
explicit, schema-visible, robust against a reviewer using a different
disambiguator. This is the kind of senior trade-off reasoning the bar
requires — the migration header itself reads like an ADR, which is the right
posture for a non-obvious schema decision.

**P-NEW-3 — C3 F2 fix is a real structural separation.** The vision client
sends ONLY field NAMES; the comparator (`score_entry`) does the value-aware
comparison in a separate, pure-Python step. The test at
`test_vision_client_does_not_leak_audited_values_into_prompt` asserts every
audited value is absent from the captured prompt — this is the right way to
verify the bias-removal contract, and it catches future regressions where a
helpful refactor "anchors the OCR with the JSON for context."

**P-NEW-4 — C4 F1 dual-test approach.** `test_item_sort_key_is_monotone_with_sql_ordering`
pins three independent failure modes (numeric, cross-section, cross-test) at
unit speed; `test_resume_cursor_skips_at_or_before_and_keeps_after` exercises
the actual resume filter end-to-end with a fixture invariant assertion
(`assert item_9.source_id > item_10.source_id`) that documents the bug
in-test. Excellent — anyone reading the test understands what was wrong AND
what's right.

**P-NEW-5 — C1 SF-3 round-trip test uses the real runner.** The test drives
`db.migrate.main` with actual CLI args rather than calling `down.sql`
manually. This catches the case where the runner's checksum recording or
target-resolution logic disagrees with raw SQL execution.

---

## Detailed findings

### C2 F1 BLOCKER — verified in depth

The reviewer's critical concern (does the new test catch the *pre-fix*
behavior?) — verified by reading `test_resolve_counters.py` and the pre-fix
math from REVIEW_C2 F1.

- Pre-fix: `extracted = len(rows) + len(broken)`, with `broken` containing
  text_only refs (appended in `_process_entry`).
- `test_flush_batch_text_only_not_counted_as_broken` passes
  `rows=[1 resolved, 2 text_only]`, `broken=[]`, `text_only_reports=[2]` and
  asserts `extracted == 3`, `broken == 0`. Under the pre-fix code, this exact
  call would have produced `broken == 2` (the text_only reports would have
  been appended to `broken` in `_process_entry`, not held separately).
  Critically, the test calls `_flush_batch` directly so the fix to
  `_process_entry` and the fix to `_flush_batch` are tested independently;
  the test would still catch a regression where `_flush_batch` reverts to
  `len(rows) + len(broken)` even if `_process_entry` were unchanged.
- `test_flush_batch_mixed_outcome_counters_sum_to_extracted` exercises the
  realistic mixed case (resolved + text_only + broken in one batch),
  asserting `extracted == resolved + text_only + broken`. Pre-fix would have
  produced `extracted == 5` (3 rows + 2 broken from text_only+real_broken),
  `broken == 2` for actual outcomes of 2/1/1.
- `test_flush_batch_rejects_unknown_resolution_status` exercises the invariant
  assertion in `_flush_batch:483-486`. This is forward-looking insurance, not
  a regression catch.

The test design correctly exercises `_flush_batch` with realistic inputs that
mix `text_only` and actual broken refs (the reviewer's #1 concern). PASS.

### C1 SF-1 — sentinel approach verified

`010_canonical_grammar_manual_override.up.sql:54-56` adds
`ADD COLUMN IF NOT EXISTS canonical_grammar_id_is_manual_override BOOLEAN
NOT NULL DEFAULT FALSE`. `cluster_canonical_grammar.py:519-520` adds
`AND canonical_grammar_id_is_manual_override = FALSE` to the UPDATE WHERE
clause. Down migration drops the column cleanly.

The reviewer's critical concern (does the backfill SQL actually check the
column, not just define it?) — verified: the SQL at
`cluster_canonical_grammar.py:512-521` includes the sentinel check. PASS.

The alternative (a separate `canonical_grammar_id_manual` column) was not
chosen. The sentinel-column choice is reasonable: it keeps the existing FK
single-valued (so all reads see the override), the override is visible in any
diagnostic SELECT, and the schema surface is minimal (one BOOLEAN, no extra
FK). The FIX_REPORT documents this trade-off in `:140-153` — good.

### C3 F2 — structural separation verified

The reviewer's critical concern (is the comparator structurally separated?) —
verified:
- `extract_entry_view` (`audit_darakwon.py:661-755`) takes the entry, derives
  `field_names = sorted(k for k in entry.keys() if k not in {...})`, and sends
  only those names to the model. No values reach the prompt.
- `score_entry` (separate function) compares the model's blind extraction
  against the JSON values in a pure-Python step. The Claude call and the
  value comparison are in different functions and different call sites
  (`audit_darakwon.py:887` calls `extract_entry_view`; `score_entry` consumes
  the returned dict).

This is the right structural pattern — one model call to extract, one Python
step to compare. PASS.

### C4 F1 — sort key tested with divergent cases

The reviewer's critical concern (tested with at least two divergent cases?) —
verified:
- `test_item_sort_key_is_monotone_with_sql_ordering` pins three: 9 vs 10
  (same test, same section); reading vs listening (same test, different
  sections); test 5 vs test 36 (different tests). The fixture invariant
  `assert item_9.source_id > item_10.source_id` makes the bug explicit
  in-test.
- `test_resume_cursor_skips_at_or_before_and_keeps_after` exercises the
  end-to-end filter at the 9 vs 10 vs 11 boundary, asserting the post-cutoff
  item (11) survives and the at/before-cutoff items (9, 10) are dropped.

The cross-test case (`topik5` vs `topik36`) is the "01-01 vs 10-01" type of
divergence the reviewer asked about. PASS.

### Migration checksum impact — operationally acknowledged

FIX_REPORT_C.md §"Migration 006/008/009 checksum impact" correctly disclosed
that 006/008/009 were edited in place. This is fine for the test matrix
(every fixture spins a fresh schema) and for the current dev state. It is
NOT fine for any environment where Phase C has already been applied without
a redeploy — see SF-NEW-1.

---

## Coordination observations

- **Migration numbering remains coherent:** 006 (C1), 007 (skipped), 008 (C4),
  009 (C2), 010 (C-fix-pass). The 008 header comment now correctly attributes
  009 to C2 and explains the 007 gap.
- **No cross-phase regressions:** the sentinel column on `kgiu_entries` is
  isolated (one BOOLEAN, default FALSE). Existing code paths that don't
  consult it (read paths, joiners) are unaffected.
- **C2 CSV rename keeps back-compat:** the legacy `--broken-ref-out` flag is
  preserved alongside `--unresolved-ref-out`. Older harness invocations
  continue to work.
- **C3 structural_audit now does double duty:** it emits MINOR for both
  composite POS and missing audio_track. The AUDIT_REPORT.md table values
  (374 / 200) are now derivable from `structural_audit()` output rather
  than computed offline. The report's prose claim about audio_track gaps
  remains accurate (358 / 189) but is now also reflected in the per-entry
  table — this is the mechanical reproducibility the reviewer asked for.
- **C4 sort key is independent of source_id convention:** if a future loader
  reshapes source_ids, the resume cursor (stored in `load_state.last_item_id`
  as TEXT) keeps working because the encoded key is computed from
  `(test_number, section, item_number)` — fields backed by the DB schema, not
  by a loader naming convention.

---

## Recommendation

**Ready for Phase B client work**, conditional on:

1. **CI lane runs green** (lint + typecheck + full test execution against
   testcontainers Postgres). FIX_REPORT correctly acknowledges these weren't
   executed in the fix-pass environment. Tests are written to existing fixture
   conventions and should pass; this is verification, not work.
2. **SF-NEW-1 follow-up ticket** for the checksum-drift operator runbook
   before the next deploy that touches a long-lived database. For pure dev /
   testcontainers usage, no action needed.

Optional follow-up tickets (not blocking):

- C3 F5 (KGIU Advanced pdf_offset) — needed before the operator runs the
  vision pass on advanced corpora; tracked in FIX_REPORT.
- C3 F8 (AUDIT_SECURITY.md) — bar-aligned hygiene, low priority.
- NIT-NEW-2 (backfill double-SELECT) — performance polish, not on critical path.
- The remaining deferred NITs (C2 F6, C3 F3/F6/F7, C4 F2/F4-F7) — all
  explicitly NIT-tier per source reviews; address when next touching the
  relevant files.

The fix-pass meets the senior-engineer bar for the BLOCKER and SHOULD-FIX
items. The code changes are surgical, the new tests pin the contracts they
need to pin, the documentation has been updated where the implementation
changed materially, and the deferred items are correctly scoped to NIT-tier
per source reviews.
