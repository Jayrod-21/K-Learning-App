# Review — CI: `ingest-checks` actually runs the ingest test suite

Reviewer: independent senior CI/GitHub Actions + Python test-infra review. Read-only.
Scope: commit `05e4630` ("ci(ingest): actually run the ingest test suite"), branch
`chore/ci-ingest-tests` — `.github/workflows/ci.yml` (`ingest-checks` job),
`tools/ingest/requirements-dev.txt` (new), `FOLLOW_UPS.md` (F-UP-002, F-UP-003).

## Verdict

**Approve, with two SHOULD-FIXes on the follow-up ticket and one on the dependency
manifest.** The gate itself is sound and **not** false-green: I reproduced the
author's clean-checkout validation independently (fresh `python:3.12-slim`
container, `pip install -r requirements-dev.txt`, testcontainers Postgres via the
host Docker socket) and got **273 passed, 3 skipped, 0 failed** running the exact
`--ignore`d command from `ci.yml` — consistent with the commit's claimed 272/4.
Removing any one `--ignore` reintroduces real, non-swallowed failures (I verified
this directly), and the step has no `|| true`/`continue-on-error`, so a real
regression in the ~273 non-excluded tests genuinely fails the build.

However: **I traced the actual root cause of all 13 quarantined test failures
myself, and FOLLOW_UPS.md's F-UP-002 diagnosis is wrong for both quarantined
files.** Neither failure is the described "`ON CONFLICT` COALESCE expression has
no matching unique index" bug. Quarantine-with-a-ticket is still the right
engineering call — this commit shouldn't have to fix a pre-existing, unrelated
test failure just to turn the gate on — but the ticket describing *why* they're
quarantined needs to be rewritten, because its prescribed fix (add a migration
creating an expression-based unique index) would not make either file pass. See
SHOULD-FIX 1 and 2 below for the real causes, with exact file:line evidence.

## Findings

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — F-UP-002 misdiagnoses `test_link_topik_dependencies.py` (7 of 13 failures).**
The real cause has nothing to do with `link_topik_dependencies.py`'s production
upsert. Every DB-backed test in this file calls the test's own `_seed_topik_item`
helper before it ever reaches `ltd.write_deps()` (the code under test), and that
helper (`tools/ingest/tests/test_link_topik_dependencies.py:216`) does:
```sql
ON CONFLICT (test_number, section) DO UPDATE
```
This target was valid when migration 005 created `topik_tests` with
`uq_topik_tests_number_section UNIQUE (test_number, section)`
(`db/migrations/005_lesson_podcast_topik.up.sql:337`), but **migration 029**
(`db/migrations/029_topik_tests_level_unique.up.sql`) dropped that constraint and
replaced it with `uq_topik_tests_number_level_section UNIQUE (test_number,
topik_level, section)` — a real, deliberate, and already-documented fix for a
genuine TOPIK-I/TOPIK-II collision bug. Migration 029's own docstring says
*"load_topik.py's ON CONFLICT target is updated in lockstep"* — but this test
fixture's hand-written SQL was not. The result: `psycopg.errors
.InvalidColumnReference` fires on `INSERT INTO topik_tests` **before** the
`link_topik_dependencies.py` code under test ever executes (confirmed via full
traceback — the exception originates at
`tests/test_link_topik_dependencies.py:211`, called from `_seed_topik_item`,
which every failing test calls first).

Separately, I confirmed the actual code FOLLOW_UPS.md accuses
(`tools/ingest/link_topik_dependencies.py:488-492`'s `_INSERT_DEP_SQL`, `ON
CONFLICT (topik_item_id, dep_type, COALESCE(grammar_entry_id, 0),
COALESCE(vocab_entry_id, 0))`) already has a **matching** unique index —
`db/migrations/008_topik_dependencies.up.sql:175-176`:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_topik_dependencies_natural_key
    ON topik_dependencies (
        topik_item_id, dep_type,
        COALESCE(grammar_entry_id, 0), COALESCE(vocab_entry_id, 0)
    );
```
Column list and expressions match exactly. No later migration touches
`topik_dependencies` (grepped all of `db/migrations/*.sql` — only 007 and 008
reference it, and 007 is an explicit no-op placeholder). So the "pre-existing
bug" F-UP-002 names for this file may not exist at all; the tests simply never
reach that code path to exercise it.

**Fix:** one-line test-only change — `tests/test_link_topik_dependencies.py:216`,
`ON CONFLICT (test_number, section)` → `ON CONFLICT (test_number, topik_level,
section)`. Low-risk, no production code touched. This is small enough it
arguably could have shipped in this same commit rather than being quarantined.

**SF-2 — F-UP-002 misdiagnoses `test_canonical_grammar_db.py` (the other 6 of 13
failures).** The actual failure is a `pydantic_core.ValidationError`, not an
`InvalidColumnReference`, and it happens with **zero database interaction**:
```
cluster_canonical_grammar.py:292: in _build_clusters
    clusters.append(CanonicalCluster(
E   pydantic_core._pydantic_core.ValidationError: 2 validation errors for CanonicalCluster
E   members.0
E     Input should be a valid dictionary or instance of PatternOccurrence [type=model_type, ...]
```
Root cause: `tools/ingest/cluster_canonical_grammar.py:73-92` has a dual-import
fallback —
```python
try:
    from tools.ingest.canonical_grammar import (..., PatternOccurrence, ...)
except ImportError:
    from canonical_grammar import (..., PatternOccurrence, ...)
```
Neither `tools/__init__.py` nor `tools/ingest/__init__.py` exists, so
`tools.ingest.canonical_grammar` resolves as a PEP 420 implicit namespace
package import and **succeeds** (no `ImportError`) once `_REPO_ROOT` is on
`sys.path` (added at `cluster_canonical_grammar.py:68`). Meanwhile
`tests/test_canonical_grammar_db.py:46` imports the bare form:
`from canonical_grammar import (...)`. Python now has **two separate module
objects** in `sys.modules` — `canonical_grammar` and
`tools.ingest.canonical_grammar` — each executing `canonical_grammar.py`
independently and each defining its own, distinct `PatternOccurrence` class
(`canonical_grammar.py:356`) and `CanonicalCluster` class (`canonical_grammar.py
:375`). Same name, same code, different identity. Pydantic's `isinstance` check
on `CanonicalCluster.members: list[PatternOccurrence]` then rejects the test's
instances because they come from the "other" `PatternOccurrence`. This is a pure
Python import-identity bug, unrelated to `ON CONFLICT`, unrelated to any
migration, and would reproduce with no database at all.

**Fix:** not a migration. Either (a) make `tools`/`tools.ingest` real packages
(add `__init__.py`s) and drop the bare-import fallback branch, or (b) have the
test import via the same spelling `cluster_canonical_grammar.py` resolves
(`tools.ingest.canonical_grammar`), or (c) have `cluster_canonical_grammar.py`
try the bare import first since that's what test/script invocation actually
uses. Any of these is a real fix; F-UP-002's proposed unique-index migration is
not, and would leave these 6 tests exactly as red as they are today.

**Recommendation:** rewrite F-UP-002 into two correctly-diagnosed, separately-
tracked items (or fold SF-1's one-line fix into this PR now, since it's trivial
and low-risk) so a future engineer doesn't spend time on the wrong fix.

**SF-3 — `pydantic` and `anthropic` are unpinned in `requirements-dev.txt`
despite gating test collection.** The file's own header says pydantic, httpx,
defusedxml, pypdf, PyMuPDF, and anthropic "are imported by the runtime loaders
at MODULE LOAD... required merely to COLLECT the test suite" — i.e. an
incompatible major bump in any of these breaks the *entire* gate (a collection
error, not a single test failure), not just one test. Yet only
`psycopg[binary]`, `structlog`, `testcontainers`, and `pytest` are pinned;
`pydantic`, `httpx`, `defusedxml`, `pypdf`, `PyMuPDF`, and `anthropic` float on
"latest compatible." I confirmed this drift is not hypothetical: my clean-room
run resolved `pydantic==2.13.4`, `anthropic==0.116.0`, `pypdf==6.14.2`,
`pymupdf==1.28.0` and produced **273 passed / 3 skipped**, one test off the
commit message's claimed **272 passed / 4 skipped** — harmless today, but
concrete proof that two "clean checkout" runs of this exact command, days apart,
already resolve different dependency graphs. `anthropic` in particular is
already flagged elsewhere in `FOLLOW_UPS.md` as a fast-breaking SDK ("the SDK API
changed a lot across that range — bump carefully"); leaving it and `pydantic`
unpinned in a collection-critical manifest is inconsistent with that same
document's own caution, and with SENIOR_ENGINEER_BAR §1.1/§3.11/§5.9 (pin +
lockfile, deliberate bumps, reproducible installs). Recommend pinning at least
`pydantic` and `anthropic` to exact versions, matching the treatment already
given to `psycopg`/`structlog`/`testcontainers`/`pytest` in the same file.

### NIT

- `FOLLOW_UPS.md`'s F-UP-002 "Evidence" line — *"13 tests fail — all of
  `tests/test_link_topik_dependencies.py` and `tests/test_canonical_grammar_db.py`"*
  — reads as if every test in both files fails. In fact 6 pure-unit tests in
  `test_link_topik_dependencies.py` (no DB fixture, e.g.
  `test_skill_tag_mapping_includes_known_tags`,
  `test_dependency_xor_enforced_in_python`) pass fine. Minor wording clarity, easy
  to fix alongside SF-1/SF-2's rewrite.
- `tests/test_hanja_hunmeum.py` already self-guards with
  `@pytest.mark.skipif(not HANJA_JSON.exists(), ...)` (line 46), so `--ignore`ing
  it in `ci.yml` is redundant-but-harmless belt-and-suspenders. The other two
  `output/`-scanning exclusions (`test_topik_item_type_validation.py`,
  `test_resolve_cross_references_integration.py`) have no such guard and
  genuinely need the `--ignore` (they'd hard-fail, not skip, on a clean
  checkout). Consider adding the same `skipif` guard to all three for
  consistency — would let two of the three exclusions be dropped from the CI
  command entirely.

### PRAISE

- **No `|| true` / `continue-on-error` on the new pytest step** — a deliberate,
  correctly-labeled contrast with the intentionally-soft `ruff check` and
  `pip-audit --strict` steps in the same job. I confirmed empirically (running
  the suite with the two DB-quarantined files *included*) that a real failure
  produces a non-zero pytest exit and a `FAILED` summary — this step will
  genuinely block a PR.
- **Faithful clean-checkout validation methodology** (`git archive HEAD` before
  testing) is exactly right — it's the only way to be sure `.gitignore`d
  artifacts and local-only state aren't silently propping up a "passing" run.
  I independently reproduced this methodology (fresh container, host Docker
  socket, no bind-mounted host state beyond a read-only source copy) and got a
  consistent result.
- **Real, substantial coverage**: 18 of 23 test files / ~273 tests actually run
  in this gate — this closes a real gap, not a token one. `requirements-dev.txt`
  is complete: collection succeeds with no `ModuleNotFoundError`s.
- `requirements-dev.txt`'s header comment explaining *why* each package is
  needed merely to **collect** (vs. just run) the suite is exactly the kind of
  "why, not what" documentation SENIOR_ENGINEER_BAR calls for.
- The `ci.yml` exclusion comments are specific (exact file names) and
  cross-reference `FOLLOW_UPS.md` ticket IDs — good traceability infrastructure,
  even though the ticket content itself needs correcting (SF-1/SF-2).
- Precedent for testcontainers-in-GitHub-Actions already exists via the
  unchanged `db-checks` job; I additionally re-verified testcontainers + Postgres
  works cleanly end-to-end in a vanilla `python:3.12-slim` container using only
  the host's Docker socket — the same mechanism `ubuntu-latest` runners provide
  out of the box.

## Detailed (file:line)

- `.github/workflows/ci.yml:99-121` — new "Ingest tests" step; no
  `continue-on-error`, correctly inherits `working-directory: ./tools/ingest`
  from the job-level `defaults` (`ci.yml:78-81`); `setup-python@v5` pins `3.12`
  (`ci.yml:83-85`).
- `tools/ingest/requirements-dev.txt:12-22` — pinned: `psycopg[binary]==3.2.3`,
  `structlog==24.4.0`, `testcontainers[postgres]>=4,<5`, `pytest>=8,<10`.
  Unpinned (SF-3): `psycopg_pool`, `pydantic`, `httpx`, `defusedxml`, `pypdf`,
  `PyMuPDF`, `anthropic`.
- `tools/ingest/link_topik_dependencies.py:482-507` — `_INSERT_DEP_SQL`, the
  `ON CONFLICT` target FOLLOW_UPS.md blames; verified it has a matching index
  (below) and is never reached by the currently-failing tests (SF-1).
- `db/migrations/008_topik_dependencies.up.sql:175-183` — matching
  `uq_topik_dependencies_natural_key` unique index already exists.
- `db/migrations/005_lesson_podcast_topik.up.sql:337` — original
  `uq_topik_tests_number_section UNIQUE (test_number, section)`.
- `db/migrations/029_topik_tests_level_unique.up.sql` — drops that constraint,
  adds `uq_topik_tests_number_level_section UNIQUE (test_number, topik_level,
  section)`; the actual proximate cause of SF-1, via the un-updated test fixture.
- `tools/ingest/tests/test_link_topik_dependencies.py:211-221` — `_seed_topik_item`
  helper with the stale `ON CONFLICT (test_number, section)` target (line 216);
  called by every failing test in this file before `ltd.write_deps()` is
  reached (e.g. line 401).
- `tools/ingest/cluster_canonical_grammar.py:64-92` — dual sys.path insertion +
  try/except dual-import of `PatternOccurrence`/`CanonicalCluster`, the root
  cause of SF-2's module-identity mismatch.
- `tools/ingest/canonical_grammar.py:356,375,401` — `PatternOccurrence`,
  `CanonicalCluster`, and its `members: list[PatternOccurrence]` field —
  duplicated at runtime under two module identities.
- `tools/ingest/tests/test_canonical_grammar_db.py:45-46` — bare imports
  (`import cluster_canonical_grammar as ccg`, `from canonical_grammar import
  ...`) that collide with the package-qualified import
  `cluster_canonical_grammar.py` resolves internally.
- `FOLLOW_UPS.md` (root, "F-UP-002" section) — root-cause text to be corrected
  per SF-1/SF-2; F-UP-003 (3 `output/`-scanning exclusions) verified accurate —
  `tools/ingest/output/` is genuinely gitignored (`.gitignore:23`, confirmed via
  `git check-ignore -v`).

---

## Re-review

Scope: commit `291863b` ("fix(ingest): green the tests the CI gate surfaced; pin
collection-critical deps") on `chore/ci-ingest-tests`. The author chose to **fix +
un-quarantine** rather than ship the misdiagnosed ticket — the stronger call.

**Verdict: PASS.** All 3 SHOULD-FIXes correctly resolved; no regressions; no new
false-green risk introduced (the `--ignore`→`--deselect` switch is strictly
*safer* than what it replaced). Two NITs, both deferrable. I independently
reproduced the clean-checkout run from a fresh `git archive 291863b` (pinned
deps, testcontainers Postgres): **290 passed, 4 skipped, 2 deselected, 0 failed,
exit 0** — matching the author's claim exactly.

### Per-concern findings

**(1) SF-2 bare-first flip — does it break the production `-m` invocation or
re-open a module-identity split? — SAFE (verified).** I ran the actual production
module path in a clean container: `python -m tools.ingest.cluster_canonical_grammar
--help` imports OK, and an identity probe shows both `PatternOccurrence.__module__`
and `CanonicalCluster.__module__` resolve to the **single** bare `canonical_grammar`
module — `sys.modules` holds exactly one `canonical_grammar` identity, no
`tools.ingest.canonical_grammar` twin. The reason it's robust: `_HERE`
(`tools/ingest/`) is inserted onto `sys.path` (`cluster_canonical_grammar.py:64-66`)
*before* the import under all three invocation modes, so the bare import always
succeeds and the `tools.ingest.canonical_grammar` fallback branch is now
effectively unreachable (dead but harmless). I also grepped the whole repo: the
**only** importers of `canonical_grammar`/`cluster_canonical_grammar` are
`cluster_canonical_grammar.py` itself and the three test files — nothing outside
`tools/ingest/` and no sibling that imports the *package* spelling. So no
production consumer can create the "other" identity. Since `cluster_...` now
imports bare regardless of how `cluster_...` itself was imported, even a
hypothetical future cluster-module split could not reintroduce a *PatternOccurrence*
split. This was the concern flagged as most worth a second set of eyes — it holds.

**(2) SF-1 conflict target vs migration 029 — EXACT (verified).** Fixture now
reads `ON CONFLICT (test_number, topik_level, section)`
(`test_link_topik_dependencies.py:216`); migration 029 defines
`uq_topik_tests_number_level_section UNIQUE (test_number, topik_level, section)`
(`029_topik_tests_level_unique.up.sql:22-23`). Column set matches exactly —
neither over- nor under-specified. The `DO UPDATE SET topik_level = EXCLUDED
.topik_level` is now slightly vestigial (topik_level is part of the key so a
conflict implies it already matched) but harmless.

**(3) The 2 `strategy_c` deselects — genuine deferred bug, not a missed trivial
fix (verified).** I traced the actual cause and it is real, non-trivial, and
correctly *not* hacked in this PR. `strategy_c_claude` extracts a Hangul fragment
via `_HANGUL_RE` (`link_topik_dependencies.py:653`) then drops anything under
`_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS = 3` (line 666). For the seeded canonical
pattern `-(으)면` the fragment is `-(으)면` → `hangul_only = "으면"` = **2**
syllables → dropped before the DB lookup ever runs → `deps == []`, which is
exactly the `AssertionError: 0 >= 1` at test line 829. So the min-3-syllable
discriminating filter (added by REVIEW_C4 F3 to reject 1-char fragments like
`오`) is too aggressive for legitimate 2-syllable patterns — a genuine
linker/design conflict, not a fixture typo. (The cap test fails relatedly: the
proxy returns the raw option `오는데` whose fragment isn't a substring of the
seeded canonical `는데` patterns.) Resolving this means a real decision about
fragment extraction + the length threshold, appropriately deferred with a ticket
rather than rushed into a CI-plumbing PR. F-UP-002's rewritten hypothesis space
("normalization mismatch, wrong lookup table, or the dep insert silently
no-op'ing") is in the right ballpark; NIT below sharpens it.

**(4) False-green risk from `--ignore`→`--deselect` — REDUCED, not increased
(verified).** `--deselect` targets two exact nodeids; every *other* test in
`test_link_topik_dependencies.py` — including the 11 previously-masked tests and
any test added to that file in future — now runs. The old whole-file `--ignore`
would have silently skipped all of them. I also tested the stale-target failure
mode directly: pytest treats a `--deselect` nodeid that matches nothing as a
no-op (warning, exit 0) — which is *fail-safe* here, because a renamed/mistyped
target means the intended test is **not** deselected and therefore **runs**; if
it's still broken the build goes red. There is no path by which a stale deselect
hides a real failure.

### Residual findings (NIT only — do not block)

- **NIT (sharpen F-UP-002):** the precise root cause of the `strategy_c` failures
  is now known (above) — the `_HANGUL_RE` + `_STRATEGY_C_MIN_FRAGMENT_HANGUL_CHARS
  = 3` filter rejecting the 2-syllable `으면`, plus the cap test's proxy fragment
  (`오는데`) not being a substring of the seeded canonical `는데` patterns. Folding
  those two file:line specifics into the ticket would save the next engineer the
  re-trace.
- **NIT (cleanup coupling):** the two `--deselect` lines in `ci.yml` become stale
  no-ops the moment `strategy_c` is fixed and/or those tests are renamed. When
  F-UP-002 lands, remove them in the same change so the gate doesn't carry dead
  exclusion flags. (Same housekeeping note applies to the three `output/` `--ignore`s
  under F-UP-003.)

### Confirmed clean
- No `|| true` / `continue-on-error` on the pytest step — still blocking.
- `requirements-dev.txt` pins now cover every collection-critical lib
  (`pydantic==2.13.4`, `anthropic==0.116.0`, `httpx==0.28.1`, `defusedxml==0.7.1`,
  `pypdf==6.14.2`, `PyMuPDF==1.28.0`, `psycopg_pool==3.3.1`), matching the exact
  versions my clean run resolved; `testcontainers`/`pytest` intentionally left as
  ranges to mirror `db-checks`. The two-runs-drift SF-3 flagged is closed.
- FIX_REPORT_CI_INGEST.md and the rewritten FOLLOW_UPS.md F-UP-002 accurately
  describe the dispositions.
