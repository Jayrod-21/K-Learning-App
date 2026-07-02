# Review: TOPIK load — tests / fixtures / playbook / gitignore

Reviewer: independent senior engineer (did not author this code).
Branch: `topik-corpus-load-fixes` vs `rebuild`.
Scope: `tools/ingest/tests/test_load_topik.py`, the three new fixtures, `tools/ingest/TOPIK_OCR_PLAYBOOK.md`, `.gitignore`.
Cross-referenced against `loaders/models.py`, `loaders/load_topik.py`, migrations 029/030, and the pre-existing `topik_mini_reading.json` fixture.

## Summary verdict: PASS WITH CONDITIONS

The three underlying bugs each ship with a regression test that genuinely fails on the pre-fix code — none passes for the wrong reason. Fixtures are valid JSON, validate against the Pydantic models, and match the real TOPIK shape. The playbook is level-qualified everywhere and documents the writing vocabulary + provenance + char_range. `.gitignore` verifiably ignores `output/` and both existing sibling backup dirs (confirmed with `git check-ignore`), and no corpus JSON is tracked.

**0 BLOCKERS.** One SHOULD-FIX (test isolation / order-coupling, currently latent) and two NITs. The condition for a clean PASS is the SHOULD-FIX below.

## Bar checklist (testing items)

| Bar item | Rule | Verdict | Note |
|---|---|---|---|
| §5.2 [P0] every bug fix ships a test that fails on old code | Regression guard | **PASS** | All 3 bugs: see detailed findings. Each fails pre-fix. |
| §5.2 [P0] assert behavior/observable output | Behavior not impl | **PASS** | Asserts DB row counts, enum values, jsonb contents — observable state, not internals. |
| §5.4 [P1] real owned infra via Testcontainers | Integration realism | **PASS** | Real Postgres 16 via `PostgresContainer`; migrations applied from disk. Catches the constraint + enum-cast bugs a mock would hide. |
| §5.3 [P0] isolated — passes alone, any order, in parallel | Isolation | **FAIL** | Pre-existing tests 1 & 2 use **global** `COUNT(*)`; new tests add test-98 rows → they break under any non-definition order. See SHOULD-FIX 1. |
| §5.3 [P0] deterministic (no sleep/wall-clock/net) | Determinism | **PASS** | No sleeps; container is the only external and it is owned/ephemeral. |
| §1.3 [P0] Pydantic at boundary | Fixtures validate | **PASS** | All three fixtures validate against `TopikDocumentModel`. |
| §4.5 [P0] migration has tested downgrade | Migration hygiene | **N/A (spot-checked)** | 029/030 both have `.down.sql`; out of primary scope but present. |

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **Order-coupling: pre-existing tests 1 & 2 assert GLOBAL counts in a module-scoped shared DB; the two new tests now add rows that break them under reordering.** (`test_load_topik.py:98-99`, `:114`)

### NIT
1. `.gitignore` `output.*/` matches directories only — a tarball/file backup like `tools/ingest/output.tar.gz` would NOT be ignored (confirmed: `git check-ignore` returns nothing for it). (`.gitignore:24`)
2. The collision test's item-grain assertions (`==4` items, `==2` distinct source_ids) are not themselves regression guards — only `topik_tests==2` and the provenance assertion fail on old code. Fine as-is, but the test's teeth live entirely in those two lines. (`test_load_topik.py:140`, `:167-175`)

### PRAISE
- **The collision test asserts the right grain.** `COUNT(topik_tests WHERE test_number=98) == 2` (`test_load_topik.py:140`) is the single assertion that actually fails on the old code, and it targets the *constraint* dimension of the bug (migration 029 + the `ON CONFLICT` target moving in lockstep) rather than something incidental. Adding the distinct-`source_id` and provenance checks on top makes it a strong, multi-facet guard.
- **The writing test guards all three writing failure modes in one test without over-asserting:** enum collapse (`short_answer` → `short_answer_blanks`), `char_range` survival into `extra` (count + value), and it does so via observable DB state. Clean AAA.
- **Fixtures carry an in-file rationale.** `topik_mini_II_listening.json:11` embeds the *why* ("item numbers 1-2 collide across levels unless the level token qualifies the id") — the fixture documents the bug it exists to catch.

## Detailed findings

### SHOULD-FIX 1 — global-count assertions + shared module container = order-coupling

`pg_container`/`schema` are **module-scoped** (`test_load_topik.py:33-63`) and there is **no per-test truncation** (conftest only tweaks `sys.path`; no autouse cleanup). Data therefore accumulates across the four tests in one database.

- `test_topik_loader_writes_test_and_items` asserts `SELECT COUNT(*) FROM topik_tests == 1` and `... topik_items == expected` — **unscoped, global** (`:98-99`).
- `test_topik_loader_idempotent` asserts global `COUNT(*) FROM topik_items == len(99 fixture)` (`:114`).

The two new tests correctly scope everything to `test_number = 98`, so they are self-consistent. But they now **insert additional rows** (2 `topik_tests` + 4 `topik_items` for the collision test; 1 + 3 for the writing test). Under pytest's default definition order the suite is green (tests 1-2 run before any test-98 data lands). The moment collection order changes — `pytest-randomly`, `-p randomly`, `pytest-xdist` sharding, or simply running `test_topik_writing...` first with `-k`/node-id selection — tests 1 and 2 see a global count > 1 / > 3 and fail. That violates bar §5.3 [P0] ("passes alone, any order, in parallel").

`pytest-randomly` is **not** currently configured (no `addopts`, not in deps), so this is **latent, not active** — hence SHOULD-FIX, not BLOCKER. But the branch is what activates the latent coupling (before it, only test-99 data existed and the global counts happened to be correct).

Fix: scope the pre-existing assertions to their fixture's sitting, e.g.
`SELECT COUNT(*) FROM topik_tests WHERE test_number = 99` and the analogous item count via a join on `test_number = 99`. That makes all four tests order-independent and honors the same scoping discipline the new tests already follow.

### Why each new test is a genuine regression guard (verification of the core claim)

Because the reviewer's chief mandate is "would it FAIL under the old code, or pass for the wrong reason," here is the trace for each:

- **Bug 1 (level collision), `test_topik_same_sitting_both_levels_coexist:`** Old schema had `uq_topik_tests_number_section UNIQUE (test_number, section)` (per migration 029's own header) and the loader's `ON CONFLICT` targeted `(test_number, section)`. Loading TOPIK-I then TOPIK-II listening for sitting 98 → the second `INSERT` conflicts on `(98, listening)` → `DO UPDATE` → **one** `topik_tests` row. The assertion `... == 2` (`:140`) fails. The fix (migration 029 widens the key to include `topik_level`; loader `ON CONFLICT (test_number, topik_level, section)` at `load_topik.py:170`) yields 2 rows. The two are locked together: reverting only the loader OR only the migration produces "no unique constraint matching the ON CONFLICT specification" → loud failure, which the test also catches. Genuine guard. ✔

  Caveat (NIT 2): the fixtures carry *already-level-qualified* ids, so the item-grain source-id collision (bug 1's data dimension, which lives in the OCR/playbook, not loader code) cannot be reproduced through the loader — the item-count and distinct-source_id assertions would pass even on the old constraint. The real teeth are the `topik_tests==2` and provenance lines. This is acceptable: the loader-testable dimension (the constraint/ON-CONFLICT pairing) is what the test locks, and the data dimension is prevented in the playbook (see below).

- **Bug 2 (missing `short_answer` in the model Literal), `test_topik_writing_short_answer_and_char_range:`** The old `TopikItemModel.type` Literal lacked `"short_answer"`, so `model_validate_json` rejected the entire writing document and `load()` raised — `result["status"] == "complete"` (`:196`) never holds. Fixed: `models.py:170-180` includes `short_answer`; `_TYPE_TO_DB_ENUM` (`load_topik.py:57`) collapses it to `short_answer_blanks`; assertion `item_type_51 == "short_answer_blanks"` (`:206`) confirms the enum cast survives to the DB. Genuine guard. ✔

- **Bug 3 (`char_range` dropped by `extra="ignore"`), same test:** Old model had no `char_range` field, so `extra="ignore"` silently discarded it → `extra ? 'char_range'` count would be 0, not 2 (`:209-218`) and `extra->>'char_range' == "200~300"` (`:226`) would be null. Fixed: `models.py:138` adds the field; loader packs it into the `extra` jsonb (`load_topik.py:298-305`). Genuine guard. ✔

- **Provenance (migration 030), collision test:** `provenance->>'transcript_available' == "true"` (`:167-175`) is null on old code (no column / dropped by `extra="ignore"` on `TopikSourceModel`). The TOPIK-II listening fixture supplies `transcript_available: true` + `note` + `transcript_source` (`topik_mini_II_listening.json:11-13`); loader writes only non-null keys into `topik_tests.provenance` (`load_topik.py:150-158`). `json.dumps(True)` → `"true"`, so the `->>'...'` text comparison is correct. Genuine guard. ✔

### Fixture validity (verified against the models)

- `topik_mini_I_listening.json` / `topik_mini_II_listening.json`: valid JSON; `source` has `test`/`level "TOPIK I|II"`/`section "listening"`; items omit `type` → `None` → `_resolve_item_type` infers `multiple_choice`. Level-qualified ids (`topik98-I-listen-001` vs `topik98-II-listen-001`) — exactly the pair that collided pre-fix. II file exercises the three provenance keys. **Valid.**
- `topik_mini_II_writing.json`: `type` values `short_answer` / `chart_description` / `essay` all in the model Literal; `options: []`, `answer: null`, `char_range` on #53/#54, `model_answer` as object (#51) and string (#53/#54) — all accepted by `Any | None`. Realistic: writing is TOPIK-II-only (Q51-54), items numbered 51/53/54, `total_questions: 3` = item count. **Valid.**
- All fixtures use `test: "98"`, disjoint from the pre-existing `topik_mini_reading.json` (`test: "99"`), so the new tests' scoped queries never read the reading fixture's data.

### Playbook (recurrence prevention)

Level-qualified id is enforced consistently, not just in one place:
- Template: `topik<test>-<I|II>-<read|listen|write>-<3-digit number>` (`:63`).
- Example: `topik102-I-read-031` (`:63`).
- Dedicated field rule with the collision rationale and the exact `UNIQUE (corpus, source_id)` failure mode (`:80-85`).
- Validation checklist item requiring the level token + cross-level uniqueness (`:152-153`).
- Output filename convention `topik_<N>_<I|II>_<section>.json` (`:34-35`, `:111`).

Writing vocabulary specified and consistent with the model + loader map: `short_answer` (51-52), `chart_description` (53), `essay` (54) (`:120-131`). `char_range` documented as the verbatim tilde-range for 53/54 (`:127-130`). Provenance `note` + `transcript_available`/`transcript_source` documented with when-to-use and where-persisted (`:97-103`). No stale or contradictory instruction that would reproduce any of the three bugs. Good.

### .gitignore (corpus leakage)

- `tools/ingest/output/` and `tools/ingest/output.*/` (`:23-24`) — verified with `git check-ignore`: `output/`, `output.pre-idfix.bak/`, and `output.rootbak/` are **all ignored** (the latter two exist on disk right now, so the pattern is load-bearing, not theoretical). `git ls-files tools/ingest/output` returns nothing — no corpus JSON is tracked.
- Copyrighted raw materials (`*.mp3`, `*.m4a`, `*.wav`, `TOPIK Tests/`, etc., `:10-18`) — belt-and-suspenders; the actual corpus lives outside the repo at `~/data/korean-master/corpus/` per the playbook, so these are defensive. Minor: the on-disk dir is `TOPIK TEST/` (playbook `:19`) while the ignore says `TOPIK Tests/` — mismatched, but moot since the corpus is out-of-repo. Not flagged as an action item.
- NIT 1: `output.*/` is directory-only; a file-form backup (`output.tar.gz`, `output.bak.json`) would slip through. Consider `tools/ingest/output.*` (no trailing slash) if file-form backups are plausible.

## Coordination observations

- The loader, model, migration 029, and migration 030 move as a **single coherent unit** — the `ON CONFLICT` target, the unique constraint, the Literal, the `_TYPE_TO_DB_ENUM` map, the `extra`/`provenance` writes, and the playbook instructions are mutually consistent. This is the strongest signal that the fix is real and not cosmetic.
- The one gap the review surfaces is not in the fix itself but in the **pre-existing** tests' use of global counts, which this branch inadvertently activates. Fixing those two assertions (SHOULD-FIX 1) is a ~4-line change that closes the only [P0] gap and should be done before merge, ideally alongside adding `pytest-randomly` so this class of coupling can't silently return.
- If a fix-pass touches this file, **do not** relax the collision test's `topik_tests == 2` assertion or the provenance assertion (NIT 2) — those two lines are the entire regression value for bug 1; the surrounding item-count checks are supporting, not load-bearing.
