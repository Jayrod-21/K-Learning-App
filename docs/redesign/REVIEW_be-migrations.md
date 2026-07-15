# DB Migration Review — feat/backend-batch @ 6d05e93 (migrations 059/060/061)

**Reviewer:** independent senior DB engineer (read-only review, no code changes made)
**Scope:** `db/migrations/059_hanja_attempts.*`, `060_reading_attempts.*`, `061_listening_attempts.*`, `db/migrations/README.md`, and `db/tests/test_migration_{059,060,061,055,058}.py`
**Diff base:** `git diff rebuild -- db/migrations db/tests`

## Verdict: PASS (0 BLOCKER, 1 SHOULD-FIX, 1 NIT, praise noted)

All three migrations are genuinely additive (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + one trigger each on 060/061, nothing else) and safe to deploy to a live blue/green color. FK and CHECK posture is correct, including the specific "CHECK vs. FK SET-NULL" anti-pattern the task asked me to probe — 060/061 both dodge it correctly and prove it under test. The only test failures are the two pre-identified ones (`test_055`, `test_058`), and I confirmed the exact mechanism. One real (if minor) gap: migration 059 is missing its own `db/migrations/README.md` row even though 060/061 (same batch) got theirs.

---

## 1. Per-migration checklist

### 059 — `hanja_attempts`

| Check | Result |
|---|---|
| Additive/expand-only (no ALTER of an existing table) | **PASS** — one `CREATE TABLE IF NOT EXISTS hanja_attempts`, one `CREATE INDEX IF NOT EXISTS`. Nothing else touched. |
| Zero-downtime on shared DB | **PASS** — pre-059 server code never references the table; only this same PR's code writes/reads it. Safe on one color while the other runs old code. |
| `user_id` FK posture | **PASS** — `ON DELETE CASCADE ON UPDATE RESTRICT` to `users(id)` (059_hanja_attempts.up.sql:123-125). Correct: attempt history has no standalone value once the owner is gone. |
| Soft FK to reloadable corpus/user table | **PASS** — `card_id` → `vocab_cards(id)` `ON DELETE SET NULL ON UPDATE RESTRICT` (:126-128), mirroring `writing_attempts.prompt_id`'s precedent as the header claims. |
| `char` decoupled from corpus reload | **PASS** — plain `TEXT NOT NULL`, not FK'd to `hanja_characters`, mirroring `hanja_progress.char` (016). Correct call: a `build_hanja.py` corpus rebuild must never orphan/erase attempt history. |
| CHECK constraints | **PASS** — `ck_hanja_attempts_char_single: CHECK (char_length(char) = 1)` (:129-130). This CHECK depends only on `char`, which no FK ever touches (only `card_id` is a SET-NULL target) — no interaction risk with the soft FK's degrade path. Verified live: `test_059_card_fk_sets_null_on_delete` deletes the card and the row survives with `card_id` nulled and `char` untouched. |
| Enum reuse | **PASS, praiseworthy** — reuses the existing `fsrs_rating` enum (001_core_schema) instead of a fresh TEXT+CHECK; one source of truth for the rating domain, same validation `card_reviews.rating` already gets. |
| Index | **PASS** — `ix_hanja_attempts_user_created ON hanja_attempts (user_id, created_at DESC)` (:156-157), matches the stated `GET /hanja/attempts` query shape. |
| Down migration | **PASS** — `DROP TABLE IF EXISTS hanja_attempts;` (059_hanja_attempts.down.sql:26). Reversible, idempotent (`IF EXISTS`), no top-level `BEGIN`/`COMMIT` per ADR-013. |
| README.md entry | **MISSING** — see §3 SHOULD-FIX below. |

### 060 — `reading_attempts`

| Check | Result |
|---|---|
| Additive/expand-only | **PASS** — one `CREATE TABLE IF NOT EXISTS`, one index, one `CREATE OR REPLACE TRIGGER`. No ALTER of `reading_chapters`/`generated_stories`/`users`. |
| Zero-downtime | **PASS** — storage-only migration per its own header; no route ships in this file. |
| `user_id` FK | **PASS** — CASCADE (060_reading_attempts.up.sql:320-322). |
| Soft FKs to reloadable/user-deletable rows | **PASS** — `chapter_id → reading_chapters(id) ON DELETE SET NULL` and `story_id → generated_stories(id) ON DELETE SET NULL` (:324-329). Correct posture: a book re-load replaces `reading_chapters` wholesale (044's own contract) and a user can delete a generated story; neither should RESTRICT (block the reload/delete) nor CASCADE (silently erase history). |
| **The CHECK-vs-FK-SET-NULL anti-pattern (explicit probe target)** | **PASS, correctly avoided.** `ck_reading_attempts_target_not_both: CHECK (NOT (chapter_id IS NOT NULL AND story_id IS NOT NULL))` (:345-346) is deliberately an "at most one," **not** "exactly one" (XOR) constraint. The header (:333-344) correctly reasons that Postgres re-checks every table CHECK on any UPDATE to the row, and an `ON DELETE SET NULL` action **is** an UPDATE to the referencing row — so a strict XOR CHECK would abort a legitimate chapter/story delete the instant it tried to null the FK column. I verified this is not just a comment but an enforced/tested invariant: `test_060_chapter_delete_degrades_without_violating_check` and `test_060_story_delete_degrades_without_violating_check` (test_migration_060.py:1411-1455) each seed an attempt, `DELETE` the parent row, and assert the delete succeeds, the FK column goes NULL, and `title_snapshot` survives — both PASSED in the run below. This is exactly the failure mode `reading_positions` (051) documents avoiding, applied correctly to a two-target table. |
| Other CHECKs | **PASS** — `ck_reading_attempts_source_kind` (closed 2-value set), `ck_reading_attempts_title_len` (1..500), `ck_reading_attempts_passage_positive` (`passage_number IS NULL OR > 0`), `ck_reading_attempts_version_positive`. All sensible, none interact with a SET-NULL FK path. |
| `title_snapshot` provenance | **PASS** — documented as server-derived only, never client-supplied; consistent with the rest of the schema's display-string provenance convention. |
| IDOR posture | **PASS, reasoned correctly** — ownership enforced at the route (mirrors `reading.ts`'s existing `assertOwnedUpload` gate), not a composite-FK owner-guard; the header explains why adding that guard here is out of this migration's additive scope and unnecessary given the soft FK + route check combination. Nothing to verify at the DB layer here since it's a route-layer control — flagging only that this is out-of-band and not testable at the DB layer, which is fine and expected. |
| Index | **PASS** — `ix_reading_attempts_user_completed (user_id, completed_at DESC)`. |
| Audit columns / trigger | **PASS** — `created_at`/`updated_at`/`version` + `trg_reading_attempts_updated_at` BEFORE UPDATE trigger, calling the existing `set_updated_at()` (001). Verified live: `test_060_up_checks_and_lifecycle` asserts `updated_at` bumps after an UPDATE. |
| Down migration | **PASS** — `DROP TABLE IF EXISTS reading_attempts;`, correctly documented as tripping the destructive gate on purpose. |
| README.md entry | Present (line 69). |

### 061 — `listening_attempts`

| Check | Result |
|---|---|
| Additive/expand-only | **PASS** — same shape as 060: one table, one index, one trigger. No ALTER of `ttmik_lessons`/`iyagi_episodes`/`users`. |
| `user_id` FK | **PASS** — CASCADE (061_listening_attempts.up.sql:539-541). |
| Soft FKs, deliberate departure from `topik_responses` RESTRICT posture | **PASS** — `lesson_id → ttmik_lessons(id) ON DELETE SET NULL`, `episode_id → iyagi_episodes(id) ON DELETE SET NULL` (:544-549). The header (:463-473) explicitly and correctly distinguishes this from `topik_responses.topik_item_id`'s RESTRICT posture (015), on the stated grounds that `ttmik_lessons`/`iyagi_episodes` are loader-populated and reloadable/prunable — correct reasoning, matches the scoping doc's carve-out. |
| CHECK-vs-FK-SET-NULL anti-pattern | **PASS, same pattern as 060, correctly avoided.** `ck_listening_attempts_target_not_both` (:564-565) is again "at most one," not XOR, for the identical reason. Verified live: `test_061_lesson_delete_degrades_without_violating_check` and `test_061_episode_delete_degrades_without_violating_check` (test_migration_061.py:1868-1911) — both PASSED, deleting the parent row succeeds, FK nulls, `title_snapshot` survives. |
| Other CHECKs | **PASS** — `ck_listening_attempts_source_kind`, `ck_listening_attempts_title_len`, `ck_listening_attempts_version_positive`. Sensible; no `passage_number` analog here by design (binary completion signal, documented rationale). |
| IDOR posture | **PASS, reasoned correctly** — the header correctly identifies `ttmik_lessons`/`iyagi_episodes` as public licensed corpus content with no per-user ownership to check, unlike 060's user-owned targets; only an existence check (404 on garbage id) is needed at the route. Consistent, no DB-level gap here. |
| Index | **PASS** — `ix_listening_attempts_user_completed (user_id, completed_at DESC)`, serves both `GET /ttmik/attempts` and `GET /iyagi/attempts`. |
| Audit columns / trigger | **PASS** — same shape as 060, verified live. |
| Down migration | **PASS** — `DROP TABLE IF EXISTS listening_attempts;`, documented destructive-by-design. |
| README.md entry | Present (line 70). |

---

## 2. The 055/058 down-test failures — CONFIRMED, mechanism verified

Both test files (`test_migration_055.py`, `test_migration_058.py`) are **unmodified** by this diff — `git diff rebuild -- db/tests` shows only `test_migration_059.py`, `060.py`, `061.py` as new files; 055/058 are untouched. The failures are a side effect of appending three new *destructive-down* migrations after 055/058 in the chain, not a defect in 059/060/061 themselves.

**Mechanism, read directly from `db/migrate.py`:**

- `contains_destructive()` (migrate.py:84) matches `DROP TABLE`, `DROP SCHEMA`, `DROP DATABASE`, `TRUNCATE` — and 059/060/061's down bodies are each a bare `DROP TABLE IF EXISTS ...`, so all three trip it.
- `cmd_rollback()` (migrate.py:518-568), when given `--target N`, computes `to_rollback = [m for m in reversed(applied_in_order) if m.version > target]` (line 537) — i.e. it must roll back **every** migration strictly above the target, not just the named one.
- `rollback_one()` (migrate.py:411-430) checks `contains_destructive(sql)` **per migration**, in descending version order, and raises `DestructiveBlocked` the moment it hits one without the flag.

`test_055`'s down test targets `PRE_055 = "054"` and `test_058`'s targets `PRE_058 = "057"`. Both now must roll back 061 → 060 → 059 (all destructive) before ever reaching their own migration's down. Neither test passes `--allow-destructive`. I ran the suite and confirmed both fail at the exact same point — **061, the first migration rolled back** — not somewhere in 055/058's own logic:

```
{"error": "061_listening_attempts.down.sql is destructive by nature; pass --allow-destructive to confirm rollback.", "type": "DestructiveBlocked", ...}
FAILED db/tests/test_migration_055.py::test_055_down_drops_column_keeps_enum_then_reups
FAILED db/tests/test_migration_058.py::test_058_down_drops_column_then_reups
2 failed, 25 passed in 78.35s
```

This is exactly the predicted cause. **Fix is exactly as expected**: add `--allow-destructive` to those two tests' `migrate.main([...])` down invocations (a one-line change per test; the comment text ("no --allow-destructive needed... this invocation doubles as a regression probe on that classification") will also need a small rewrite since it's no longer accurate once 059-061 exist above them in the chain — the *tests'* own destructiveness-classification is still correct, but the invocation is no longer a pure probe of 055/058's own down body once later destructive downs sit above it). This is a **SHOULD-FIX**, not a BLOCKER — it does not affect any real deploy path (blue/green migrations are applied via `up`, never chain-rolled-back past several versions in production), it only affects these two dev-time regression tests now that the chain has grown past them.

59/060/061's **own** migration tests (test_migration_059.py, 060.py, 061.py) all pass in full — every up-schema, FK, CHECK/degrade, and down/re-up test in all three files is green.

---

## 3. Findings

### SHOULD-FIX
- **`test_migration_055.py::test_055_down_drops_column_keeps_enum_then_reups`** and **`test_migration_058.py::test_058_down_drops_column_then_reups`** fail against the full chain because rolling back to their target now also rolls back 059/060/061's destructive `DROP TABLE` downs, which require `--allow-destructive`. Fix: add `--allow-destructive` to both tests' `migrate.main([...])` down invocations, and touch up the "no --allow-destructive needed" comment in each (still true of the migration's *own* down body, no longer true of the invocation once later destructive migrations exist above it in the chain). Confirmed this is the sole cause — no other db-suite failures exist in this batch.

### NIT
- **`db/migrations/README.md` is missing a row for migration 059** (`hanja_attempts`). The table has rows for 060 (line 69) and 061 (line 70) — both landed in this same PR — but no row for 059, even though 059 is the first of the three and shares the identical additive/`--allow-destructive`-down shape that 060/061 both got documented rows for. (Note: rows for 056/057/058 are also absent from this table, but that gap predates this branch — `git diff rebuild` shows those three rows were never added to begin with, so that part is not a regression introduced by this batch. The 059 gap **is** new, since 059 is wholly new in this diff and its sibling migrations 060/061 both got entries.) Recommend adding a 059 row alongside 060/061 before merge, for the same reason the doc exists at all — the table is the fast human-readable index of what's in the migration chain and why.

### PRAISE
- **060 and 061's CHECK-vs-FK design is the correct, non-obvious answer**, and both migrations back it with an actual delete-and-assert test rather than just a comment — this is exactly the kind of guard that's easy to get subtly wrong (an "exactly one" XOR CHECK reads more "correct" at first glance, and would only fail in production the first time a corpus reload or story deletion tried to null a referencing row). The header commentary in both up-migrations explains *why* the naive stricter constraint would be wrong, not just what the constraint is — genuinely useful for the next engineer who's tempted to "tighten" it.
- **059's reuse of the existing `fsrs_rating` enum** for `hanja_attempts.rating` instead of a parallel TEXT+CHECK is the right call — one domain, one source of truth, free validation parity with `card_reviews.rating`.
- Naming/numbering is clean and sequential (058 → 059 → 060 → 061), FK/index/constraint naming follows the established `fk_/ck_/ix_` conventions consistently across all three tables, and `schema_migrations` bookkeeping is unaffected (all three apply/rollback cleanly through the runner's existing bookkeeping path in the test run — confirmed by the full 61-version chain applying without any checksum or version anomalies in the log output).

---

## 4. db-suite run result

Command (per the harness in `Deploy/local-test.sh`'s `db_suite`, socket-mounted docker python):

```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)":/repo:ro -w /repo python:3.12 sh -ec \
  'pip install --quiet --no-cache-dir "psycopg[binary]==3.2.3" "structlog==24.4.0" \
     "testcontainers[postgres]>=4,<5" "pytest>=8,<10" && \
   python -m pytest db/tests/test_migration_059.py db/tests/test_migration_060.py \
     db/tests/test_migration_061.py db/tests/test_migration_055.py \
     db/tests/test_migration_058.py -p no:cacheprovider -q'
```

**Result: 2 failed, 25 passed in 78.35s** — matching the reported/expected count exactly:
- FAILED `test_migration_055.py::test_055_down_drops_column_keeps_enum_then_reups`
- FAILED `test_migration_058.py::test_058_down_drops_column_then_reups`
- All 25 other tests across `test_migration_059.py`, `test_migration_060.py`, `test_migration_061.py` (and the non-down tests in 055/058) passed.

Both failures traced to the same root cause (§2), confirmed via captured log output showing `DestructiveBlocked` on `061_listening_attempts.down.sql` in both runs.

---

## 5. Coordination

- No code changes made in this review (per instructions) — the SHOULD-FIX (055/058 test invocations) and NIT (059's README row) are both left for the batch author or a follow-up fix-pass to apply.
- Nothing here blocks the blue/green deploy: production's `up` path never invokes `down`, and the destructive gate on 059/060/061's *own* down files is working exactly as designed (deliberate, documented, correctly gated). The two test failures are dev-time-only regressions in test fixtures that predate this PR's migrations but were exposed by them.
- Recommend landing the 055/058 test fix and the 059 README row in the same PR (or an immediate fast-follow) so the db-suite is green before merge, per the project's fixpass-before-finalizing standing order.
