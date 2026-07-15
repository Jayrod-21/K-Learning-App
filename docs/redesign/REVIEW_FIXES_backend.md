# Re-Review — Fix-Pass Verification, `feat/backend-batch` @ e80e560 (fix-pass on 6d05e93)

**Reviewer:** independent re-reviewer (fresh — did not write the code, the 4 original reviews, or the fix-pass).
**Scope:** `git diff 6d05e93 e80e560` in full, cross-checked against the 4 original reviews
(`REVIEW_be-{migrations,server,integration,ingest}.md`, all 0-BLOCKER PASS).

## Verdict: **PASS** — ready to deploy migrations to the live DB

---

## 1. The 055/058 fix — REAL, not a dodge

Read both test files' diffs directly (`git diff 6d05e93 e80e560 -- db/tests/test_migration_055.py db/tests/test_migration_058.py`).

The change in each test is exactly one thing: `--allow-destructive` was inserted into the
`migrate.main([...])` argument list immediately before `"down"`:

```
rc = migrate.main(
    ["--migrations-dir", str(full_dir), "--target", PRE_055, "--allow-destructive", "down"]
)
```

Everything else in each test body is untouched:
- `test_055_down_drops_column_keeps_enum_then_reups`: still seeds a real user+conversation+title,
  still runs the real down migration, still asserts the `title` column is gone, the CHECK constraint
  is gone, the `name_conversation` enum value is deliberately retained, the conversation row survives
  (count == 1), then re-runs `_full_up` and asserts the column/CHECK come back with `is_nullable == YES`.
- `test_058_down_drops_column_then_reups`: same shape, own migration's assertions unchanged.

No `pytest.skip`, no `xfail`, no deleted/weakened assertions, no mock of `migrate.main`. The only other
edit is the header comment above `PRE_055`/`PRE_058`, correctly updated to explain *why* the flag is now
needed (059/060/061's destructive `DROP TABLE` downs sit above 055/058 in the chain, and `down --target`
rolls back everything strictly above the target) — this matches the root-cause the original migrations
review (`REVIEW_be-migrations.md` §2) had already diagnosed and prescribed as the fix.

**Targeted db-suite run (this session, python:3.12 container, real testcontainer Postgres):**

```
db/tests/test_migration_055.py test_migration_058.py test_migration_059.py
test_migration_060.py test_migration_061.py
-> 27 passed in 79.02s (0 failed, 0 skipped)
```

Isolated re-run of just the two previously-failing tests, verbose:

```
db/tests/test_migration_055.py::test_055_down_drops_column_keeps_enum_then_reups PASSED
db/tests/test_migration_058.py::test_058_down_drops_column_then_reups PASSED
2 passed in 10.14s
```

Before the fix-pass (per `REVIEW_be-migrations.md` §4): 25 passed, 2 failed (055/058), both failing at
`061_listening_attempts.down.sql is destructive by nature` before ever reaching their own migration's
down logic. After: 27 passed, 0 failed, 0 skipped — the count increased by exactly 2 (the two fixed
tests), nothing was removed or downgraded to skip. **This is a genuine fix, not a dodge.**

## 2. Stale comments corrected — comment-only, confirmed

`git diff 6d05e93 e80e560` on `client/src/services/{hanja,reading,ttmik}.ts` and
`client/src/pages/Ttmik.tsx`:
- `hanja.ts:314-320`, `reading.ts` (tail of `listReadingAttempts` doc), `ttmik.ts` (tail of
  `listListeningAttempts` doc): each previously said the history read was "not currently rendered by
  any screen" / "out of this ticket's scope" — now correctly say they're consumed by `Today.tsx`'s
  Hanja/Reading/Listening "done today" rows, matching `REVIEW_be-integration.md`'s SF-1 finding exactly.
- `Ttmik.tsx:391-399` (`parsePositiveInt` docblock): expanded to note the 4-digit cap is intentionally
  shared/generous across TTMIK lesson numbers and Iyagi episode numbers, matching `REVIEW_be-server.md`
  N-1 / the integration review's N-1.

No function bodies, exported signatures, or behavior changed in any of these four files — verified by
reading the full diff hunks, not just the stat summary.

## 3. Migration 059 README row — added

`db/migrations/README.md` diff adds exactly one new table row:

```
| 059 | `hanja_attempts` | F-171 | Append-only log of completed hanja FSRS card reviews: ... Down → --allow-destructive |
```

Matches the NIT from `REVIEW_be-migrations.md` §3 (059 was the only migration in this batch missing its
row; 060/061 already had theirs). Content is consistent in style/format with the 060/061 rows immediately
below it.

## 4. No logic/behavior change anywhere else in the fix-pass diff

Full fix-pass diff stat (`6d05e93..e80e560`):

```
client/src/pages/Ttmik.tsx             |   6 +-   (comment only)
client/src/services/hanja.ts           |   7 +-   (comment only)
client/src/services/reading.ts         |   6 +-   (comment only)
client/src/services/ttmik.ts            |   7 +-   (comment only)
db/migrations/README.md                |   1 +   (new table row)
db/tests/test_migration_055.py         |  28 +++--- (flag + comment)
db/tests/test_migration_058.py         |  30 +++--- (flag + comment)
docs/redesign/REVIEW_be-ingest.md      | 119 ++   (new review doc)
docs/redesign/REVIEW_be-integration.md |  97 ++    (new review doc)
docs/redesign/REVIEW_be-migrations.md  | 131 ++    (new review doc)
docs/redesign/REVIEW_be-server.md      | 145 ++    (new review doc)
```

- Zero migration `.sql` files touched — 059/060/061's up/down bodies are byte-identical to 6d05e93.
- Zero server (`server/src`) files touched.
- Zero client page/service logic touched — the only 4 client files in the diff are comment-only edits,
  confirmed above.
- The 4 new `docs/redesign/REVIEW_be-*.md` files are the original-review artifacts this fix-pass is
  responding to (pure documentation, no code surface).

This matches the task's expectation exactly: tests + comments + README + review-doc trail, nothing else.

## 5. Working tree

`git status --short` shows only pre-existing untracked files unrelated to this branch's work
(`.claude/`, `REDESIGN_SEOUL_NEON_BRIEF.md`) — not created or touched by this review. No modifications
left behind by this verification pass.

---

## Recommendation

**Ready to deploy migrations to the live DB.** All four original reviews are 0-BLOCKER PASS on their own
merits (migrations additive/reversible-with-flag, server routes IDOR-safe and atomic, Today/deep-link
integration correct, ingest fix independently re-verified against real corpus data). The one item those
reviews left open — the 055/058 destructive-gate test failures — is now closed with a real fix (flag
added, assertions untouched, count went from 25/2-fail to 27/0-fail/0-skip), plus the two NITs (stale
comments, missing 059 README row) are both resolved. Nothing in this fix-pass diff touches migration SQL,
server routes, or client page logic, so the blue/green deploy risk profile is unchanged from what the
original 4 reviews already cleared.
