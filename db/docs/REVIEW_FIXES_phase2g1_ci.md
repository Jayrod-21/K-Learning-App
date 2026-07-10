# Independent Re-Review — Phase 2 Group 1 CI-Failure Remediation

**Branch:** `feat/phase2-g1-db-foundation` · **PR:** #88 · **Baseline:** `rebuild` (fbd508b)
**Reviewer:** independent re-reviewer (did NOT author the fix)
**Date:** 2026-07-10
**Scope:** verify the two CI failures on PR #88 (migrations 045/046/047) are resolved against the FULL suites, and that no test was weakened to pass.

---

## Verdict: **PASS**

Both original CI failures are genuinely fixed. The grammar/grammarDrill server tests pass because the domain-wrong FK is **gone from the migration**, not because any assertion was softened. The full-chain migration appliers correctly pass `--allow-destructive` where they traverse 045's `DROP TABLE`. All three full suites were run to log files; the two previously-failing server files and the seven previously-erroring ingest tests now pass.

One informational note (does **not** gate the verdict): the local ingest run shows 2 failures that are **pre-existing and environmental** — neither is on CI's execution path, neither is caused by this PR, and one reproduces identically on the untouched `rebuild` baseline. Details in the Ingest section.

---

## Issue A — domain-wrong FK removed

**Original failure:** `fk_grammar_drill_attempts_entry` (composite FK `grammar_drill_attempts(user_id, pattern_key)` → `grammar_entries(user_id, pattern_key)`) 500'd the live grammar-drill route and failed 16 server tests. `POST /grammar-drill` inserts the attempt row at **generation time** (`server/src/routes/grammarDrill.ts:234`, the `INSERT INTO grammar_drill_attempts …` in the POST handler), while the `grammar_entries` row is only created at **submit time** (auto-bank). An attempt for a not-yet-banked pattern is a legitimate by-design state, so the FK was wrong.

**Verification (code):**
- `git diff rebuild -- db/migrations/045_hygiene_cleanup.up.sql`: the FK `ADD CONSTRAINT` block and the orphan `DELETE FROM grammar_drill_attempts` are **GONE**. The up now contains only: 6 `DROP INDEX IF EXISTS` + 2 `DROP TABLE IF EXISTS …bak…`, plus a SCOPE NOTE header explaining why the FK was dropped. ✔
- `045_hygiene_cleanup.down.sql`: recreates the 6 indexes (definitions + COMMENTs verbatim) and the 2 bak-table empty shells. **No dangling `DROP CONSTRAINT fk_…`** — the down is internally consistent with the trimmed up. ✔
- `grep -rn fk_grammar_drill_attempts_entry` across the tracked repo → **ZERO hits.** (The only matches are inside `.claude/worktrees/agent-a53ddb7…/` — a stale detached agent worktree, not the branch tree and not tracked by the branch. Not a concern.) ✔
- Route confirmed: `grammarDrill.ts` inserts the attempt in the POST/generation handler before any auto-bank, corroborating the SCOPE NOTE's domain rationale. ✔

**Docs:**
- `BUGS_AND_FEATURES.md` F-083 (line ~1085): "Scope change (migration 045): the audit's proposed FK … was DROPPED — the audit finding was wrong … the FK would 500 the live drill route on every first drill of an unbanked pattern. The index/bak-table hygiene stands." ✔
- `db/migrations/README.md` 045 row: FK dropped from scope with rationale; hygiene (6 indexes + 2 bak tables) retained; `--allow-destructive` note present. ✔

**Not weakened to pass:** `git diff rebuild -- server/tests/` touches **only** `server/tests/routes/topik.test.ts` (+265/-7) — that is the A1/046 attempt-history test rework (tombstone tests replaced by `status`-model coverage), unrelated to the FK. `grammar.test.ts` and `grammarDrill.test.ts` are **unchanged from `rebuild`** — they pass because the FK is gone, not because assertions were edited. ✔

**Status: RESOLVED.**

---

## Issue B — `--allow-destructive` on full-chain appliers

**Original failure:** 045's `DROP TABLE` trips `migrate.py`'s destructive gate; full-chain `migrate.main([… "up"])` appliers that traverse 045 aborted without the flag.

**Verification (grep of `db/tests/` + `tools/ingest/tests/`):**
- `tools/ingest/tests/test_canonical_grammar_db.py` — both full-chain applies (initial `up` L101-102, re-apply `up` L617-618) now pass `--allow-destructive`. Diff vs `rebuild` shows this is exactly the change (docstring updated to "FULL migration chain … 045's DROP TABLE trips the gate"). ✔
- `db/tests/test_migration_046.py` — full-chain applies at L208, L283, L346 pass `--allow-destructive`; the down at L305 too. The **seed-stage** apply is `--target 044` (`PRE_046 = "044"`, L67) → stops **before** 045, so correctly runs **without** the flag. ✔
- `db/tests/test_km_app_role.py` — appliers use an isolated `{001, 047}` migration dir (`_copy_real_migrations`), never traversing 045 → correctly no flag needed (L166, L345, L356). ✔
- `db/tests/test_migrations_real.py` — `foundation_dir` = `{001, 002}` only, `only_001_dir` = 001 only → no 045 traversal, no flag on the plain `up`s; destructive-gate assertions use `--allow-destructive` deliberately. ✔
- `db/tests/test_migrations.py` — synthetic in-test migrations, not the real chain; unaffected. ✔

Every real-chain-through-045 applier passes the flag; every `--target 044`-or-earlier / isolated-subset applier correctly does not. ✔

**Status: RESOLVED.**

---

## Full-suite results (run to log files, real counts)

### 1. Server — `npx vitest run` (ALL)
Log: `/tmp/km_p2g1ci_server.log` · install: `/tmp/km_p2g1ci_server*install*` (npm ci hit EACCES → `npm install` repaired, "found 0 vulnerabilities").

```
Test Files  52 passed | 1 skipped (53)
      Tests  991 passed | 4 skipped (995)
   Duration  792.08s
EXIT=0
```

- **0 failed.** (The `claude output failed Zod parse` lines in the log are **intentional** — grammar tests feed malformed model output to exercise the Zod error path; they are asserted-on, not failures.)
- Previously-failing files confirmed green via targeted re-run (`/tmp/km_p2g1ci_grammar_targeted.log`):
  `tests/routes/grammar.test.ts` + `tests/routes/grammarDrill.test.ts` → **2 files, 78 tests passed, EXIT=0.** ✔

### 2. Ingest — CI harness in Docker (ALL)
Log: `/tmp/km_p2g1ci_ingest.log`.

```
2 failed, 346 passed, 3 skipped, 5 warnings in 149.86s
EXIT=1
```

- **The 7 `test_canonical_grammar_db.py` errors are GONE** — that file is absent from the failure list and its tests are among the 346 passed. ✔ (This was the PR-relevant regression; it is fixed.)
- The **2 remaining failures are pre-existing / environmental, NOT PR-caused and NOT on CI's path**:
  1. `tests/test_hanja_hunmeum.py::test_built_corpus_has_full_hun_coverage` — reads the **gitignored** `tools/ingest/output/hanja.json`, guarded by `skipif(not HANJA_JSON.exists())`. On a **clean CI checkout** the file doesn't exist → **SKIPPED**. It fails **only locally** because a stale `hanja.json` (built 2026-07-06) is present and missing 238 `gloss_kr` values. Local build-artifact staleness, unrelated to 045/046/047.
  2. `tests/test_resolve_cross_references_integration.py::test_prerequisite_error_when_corpus_not_loaded` — a documented **test-isolation flake** (`FOLLOW_UPS.md` F-UP-003); **explicitly `--ignore`d in CI** (`.github/workflows/ci.yml` runs `pytest tests -q --ignore=tests/test_resolve_cross_references_integration.py`). Confirmed it fails **identically on the untouched `rebuild` baseline** when run in isolation (`/tmp/km_p2g1ci_resolver_rebuild.log`: `1 failed, 4 passed`), so it is not introduced by this PR.

  Neither failure would appear in CI's ingest job (one skips on a clean checkout, one is ignored). Both are outside the remediation's scope.

### 3. db/tests migration chain — Docker (CI-equivalent)
Log: `/tmp/km_p2g1ci_db.log`.

```
32 passed in 26.00s
EXIT=0
```

Green — the full-chain migration appliers (with `--allow-destructive`) and 046/047 tests all pass. ✔

---

## New findings

- **None blocking.** The FK removal is domain-correct (verified against `grammarDrill.ts`, not merely test-appeasing). The down migration is consistent. Docs updated coherently.
- **Informational:** the local stale `tools/ingest/output/hanja.json` (238 missing `gloss_kr`) makes `test_hanja_hunmeum` fail on this machine only; harmless to CI/PR but worth a local `build_hanja.py` refresh at some point. Not a blocker and not in this fix's scope.

---

## Recommendation

**Approve / merge PR #88.** Both CI failures are genuinely remediated: server 991-pass/0-fail (incl. the two previously-red grammar files), db/tests 32-pass, and the seven ingest canonical-grammar errors are gone. No test was weakened — the grammar route tests pass because the domain-wrong FK was removed from migration 045, and the migration appliers correctly declare `--allow-destructive` only where they cross 045's `DROP TABLE`. The two residual local ingest failures are pre-existing, environmental, and off CI's path.
