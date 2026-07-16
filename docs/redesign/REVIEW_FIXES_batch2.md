# RE-REVIEW — TOPIK batch-2 fix-pass verification

**NOTE:** this file previously held the re-review for the unrelated "Batch 2
(Library)" fix-pass round (`feat/redesign-library` @ `c15ade3`, off
`2c2d4ad`) — a different feature wave that reuses the same "batch 2"
numbering per this project's docs convention. That content has been
superseded here per this task's explicit output path; the Library
fix-pass's own PASS verdict is unaffected and lives in project history —
this file now covers only the TOPIK batch (F-103/F-105/F-122) fix-pass.

Reviewer: independent re-reviewer. Did not write the original code, the two
`REVIEW_batch2-{client,server}.md` reviews, or the TOPIK-batch section of
`FIX_REPORT_batch2.md`'s fix-pass.

Branch: `worktree-agent-ace5c3eb73f48dcb9` @ `d6a99bf`, base `rebuild`.
Verified against `git diff bc62eb7 d6a99bf` (the fix-pass commit itself: 10
files changed, +405/-42 lines) and spot-checked against `git diff rebuild --
.` for the full batch.

## Verdict: PASS

All 3 claimed SHOULD-FIXes are genuinely fixed, each with a real regression
test that would fail if the fix were reverted. No PRAISE item was touched or
regressed. One documentation inaccuracy in `FIX_REPORT_batch2.md`'s own
self-assessment is worth correcting (blast radius of the exhaustiveness
throw is understated — see the throw-safety verdict below) but it does not
change my recommendation to ship.

## Finding-by-finding

### 1. Copy collision (Client SHOULD-FIX 2) — FIXED, verified

`client/src/lib/nav.ts`'s `review-exams` NavItem changed:
- `kr`: `'지난 시험'` → `'기출 시험'` (now matches `ReviewLibrary`'s own
  hardcoded shelf label instead of colliding with `AttemptsReview`)
- `eyebrow`/`krEyebrow`: `'Completed exams · grades'` / `'완료한 시험 · 성적'`
  → `'Exam library · re-enter & retake'` / `'기출 자료실 · 재응시'`
- `headerTitle` updated to match (`'기출 시험 · Past exams'`)

Confirmed `AttemptsReview`/`client/src/pages/Topik.tsx` is byte-for-byte
untouched by this commit (`git diff bc62eb7 d6a99bf -- client/src/pages/Topik.tsx`
is empty) and still reads `en="Completed exams · grades" kr="완료한 시험 ·
성적"` / `kr="지난 시험"` at `Topik.tsx:552-553` — the two surfaces no longer
share any bilingual copy. `ReviewLibrary.test.tsx`'s eyebrow assertion was
updated to the new strings, consistent with the fix (not silently loosened —
it still asserts exact new text, matched against the shelf that sources from
the same NavItem).

**Status: verified, no gap.**

### 2. `mockSectionFromKr` exhaustiveness / the throw (Client SHOULD-FIX 1) — FIXED; guarantee independently verified SOLID

The function is now an exhaustive `switch` over all three `TopikSection`
members (`client/src/pages/PastExams.tsx`), throwing on `'쓰기'` (writing)
and on a `never`-typed `default`.

**Independent trace of the "writing never reaches this list" guarantee** — I
did not take the fix-pass's citation on faith and re-derived it myself:

- App-layer: `AttemptSectionSchema = z.enum(['reading', 'listening'])`
  (`server/src/routes/topik.ts:838`) is the body validator for
  `PUT /topik/attempt` — the only route that inserts progress into
  `topik_attempts`. A `'writing'` value is rejected at the HTTP boundary
  before it ever reaches SQL.
- DB-layer, independent of the app: `037_topik_attempts.up.sql` declares
  `CONSTRAINT ck_topik_attempts_section CHECK (section IN ('reading',
  'listening'))` on the `topik_attempts` table itself, even though the
  underlying `topik_section` enum type (`001_core_schema.up.sql:97`) has a
  third `'writing'` value used elsewhere (e.g. `topik_items`). This means
  even a hypothetical future write path that bypassed the Zod schema
  entirely (a raw SQL script, an admin backdoor, a bug in a different route)
  would still be rejected by Postgres itself.
- I grepped every `INSERT`/`UPDATE` touching `topik_attempts` in
  `server/src/routes/topik.ts` (the only file in the repo with any) — there
  are exactly two: `PUT /topik/attempt` (line ~1125, gated by
  `AttemptSectionSchema`) and `POST /topik/mock/submit`'s close/insert
  branch (line ~1731, whose section comes from the same mock flow that only
  ever offers reading/listening papers — the table's own doc comment: "Mock
  supports reading + listening only (writing mock is FU-NF-47)"). No other
  writer exists anywhere in the codebase.
- `GET /topik/attempts` (what `PastExams.tsx` actually consumes) reads
  `a.section::text` straight off this DB-constrained column with no further
  filtering — so the row shape flowing into `mockSectionFromKr` is
  guaranteed accurate by two independent layers (app schema + DB CHECK), not
  one.

**This is about as solid an invariant as this codebase can produce at
runtime.** Defense-in-depth (schema + DB constraint) means it would take a
coordinated regression across two independent layers to ever put a `'쓰기'`
row in front of this function.

**However — the throw's blast radius is worse than
`FIX_REPORT_batch2.md` documents, and this is worth a correction even though
it doesn't change my recommendation.** The report's self-assessment says the
fix "throws (crashes the `PastExams` page render)." I checked
`client/src/App.tsx` and `client/src/components/ErrorBoundary.tsx`: the
single `<ErrorBoundary>` in this app is mounted at the *application root*,
above `<BrowserRouter>`/`<Routes>` entirely (`App.tsx:75-93`). A throw during
any route's render — including this one — unmounts the *entire* app (nav,
shell, everything) and replaces it with a generic "Something broke / Reload"
full-page fallback that requires a hard reload to recover from. It is not
scoped to `PastExams`; there is no per-route or per-page boundary anywhere in
this tree. That's a materially bigger blast radius than "crashes the page."

**Explicit verdict on throw vs. graceful — SOLID invariant, but the FIX
REPORT undersold the blast radius:** the underlying invariant is SOLID (two
independent enforcement layers, no other writer exists), so fail-loud on
this specific condition is defensible in principle — if it ever fires,
something is badly wrong elsewhere, and silently mislabeling the row would
be worse. Given this is an explicitly personal single-user app
(`project_korean_master_personal_scope`), a full reload is a low-cost
recovery for the one affected user, which further supports leaving the throw
as-is rather than treating this as a blocker. But I'd flag two non-blocking
items for the record: (a) the FIX_REPORT's self-assessment should be
corrected to say "crashes the whole app," not "the PastExams page render," so
a future reader doesn't underestimate the risk if the invariant is ever
loosened; (b) a strictly-better alternative existed at effectively no extra
cost — catching the exhaustiveness failure one level up (skip/omit the
offending row from the rendered list, or render it without a re-enter link,
logging the anomaly) preserves the same "fail loud in dev/tests" property
(the new test still catches a real regression at the unit level) without
handing a single malformed row the power to blank the whole app for the
user. I am not requiring this change — the current fix is acceptable given
the invariant's strength and the app's personal-single-user scope — but
recommend a low-priority backlog note to consider a page-scoped guard rather
than closing the question permanently on a root-level crash.

New regression test (`PastExams.test.tsx`, "fails loudly rather than
silently mislabeling a writing (쓰기) attempt as reading") renders a mocked
`'쓰기'` entry and asserts the render throws with a message matching
`/mockSectionFromKr/`, with `console.error` suppressed for the expected
throw noise — this is a real test that would fail against the pre-fix
silent-fallthrough behavior (it would render a reading link instead of
throwing), so it genuinely locks in the new behavior.

**Status: fixed as claimed; guarantee independently confirmed solid; one
documentation correction recommended (non-blocking).**

### 3. `PUT /topik/attempt` topikLevel validate-and-correct (Server SF-1/SF-2) — FIXED, verified, test genuinely proves it

`server/src/routes/topik.ts`'s `PUT /attempt` handler now:

```
let topikLevel: TopikLevel | null = null;
if (b.topikLevel !== undefined) {
  const resolved = await resolveMockTest(b.section, b.sourceTest, b.topikLevel);
  topikLevel = resolved?.topikLevel ?? null;
}
```

replacing the prior inline `b.topikLevel ?? null` passed straight to the
upsert (confirmed via isolated diff: exactly 6 added lines, 1 removed line
— `b.topikLevel ?? null` — in the whole file's functional code; every other
line changed in `topik.ts` is a comment). `resolveMockTest(section,
requestedTest, requestedLevel)` (line ~1462) filters
`topik_tests`/`topik_items` on section, test_number, AND topik_level
simultaneously when all three are supplied — it is a real-row existence
check (does a gradeable `(sourceTest, section, topikLevel)` triple exist?),
not a re-derivation/tie-break (the tie-break behavior only activates when
`requestedLevel` is omitted, unaffected here). A non-matching triple returns
`null`, and the handler drops to `NULL` rather than persisting the client's
value verbatim. This is the exact resolver `/mock` and `/mock/submit`
already use, so no new trust model was invented — matches the design-choice
writeup in `FIX_REPORT_batch2.md` (option (b): validate-and-correct, not
re-derive-and-ignore, because re-deriving without the client's level would
reintroduce the D-1 tie-break ambiguity migration 066 exists to kill).

**New test** (`server/tests/routes/topik.test.ts`, "PUT with a MISMATCHED
topikLevel (batch-2 fix-pass SF-3) is dropped to NULL, never persisted or
reported as the wrong level") does exactly what the task asked:
- Seeds a TOPIK-II-only paper at `test_number: 4110`, `section: 'reading'`
  (no TOPIK I paper shares that number) via the pre-existing
  `seedTopikItemAtLevel` helper (already used by the sibling F-122 tests —
  not a bespoke, possibly-rigged fixture; I confirmed the helper is reused
  from the same file, not redefined).
- `PUT /topik/attempt` with `sourceTest: 4110, section: 'reading',
  topikLevel: 'TOPIK I'` — a claim that cannot possibly be correct given the
  seed.
- Asserts the raw DB row (`SELECT topik_level FROM topik_attempts WHERE
  user_id = $1`) is `null`, not `'TOPIK I'`.
- Asserts `GET /topik/attempt` reports the REAL `'TOPIK II'` (via the legacy
  `resolveServedTotal` fallback that kicks in when the column is NULL),
  never the client's fabricated value.

**Would this test fail if the validation were removed?** Yes — mechanically
confirmed by reading the diff: reverting to `b.topikLevel ?? null` would
write the literal string `'TOPIK I'` into the row, failing the
`expect(rows).toEqual([{ topik_level: null }])` assertion immediately. This
is a real, load-bearing regression test, not a restated-behavior test.

**Status: verified, no gap.**

### 4. Regression check / PRAISE intact — CONFIRMED, no regressions

- **F-103 re-enter-correct-paper**: `reEnterHref`/`PastExams.test.tsx`'s
  full-querystring assertions are unchanged by this commit (only
  `mockSectionFromKr`'s body changed, not its call site or `reEnterHref`
  itself).
- **F-105 attemptId**: no lines in `topik.ts`'s `attempt_id` select or in
  `Mistakes.tsx`/its fixtures are touched by this diff at all — confirmed
  via `git diff bc62eb7 d6a99bf --stat`, which shows no `Mistakes.*` file in
  the changed set.
- **F-122 authoritative submit-stamp**: `/mock/submit`'s unconditional
  `resolved.topikLevel` stamp is untouched — the fix-pass only touched the
  separate `PUT /topik/attempt` writer. Confirmed by isolated diff: no
  changes anywhere near the `/mock/submit` route body.
- **Migration 066 safety**: `066_topik_attempts_level.up.sql`'s only diff is
  prose (header comment + `COMMENT ON COLUMN`) — no `ALTER TABLE`, `CHECK`,
  or structural SQL statement changed; I diffed this file in isolation and
  every changed line is comment text.
- `MockMode.tsx`/F-123's `examKey`/done-set logic: not present in the
  fix-pass diff at all (confirmed via `--stat`) — untouched.

**Status: no regression found.**

## Gate results

Client (`client/`, run from the worktree, one blocking command each):
- `npm run lint` — clean, 0 problems.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean, 0 errors.
- `npx vitest run` (full suite — this project's own standing gate policy
  requires the FULL suite, not the changed slice's targeted files, for
  migration/schema/cross-cutting work; this batch touches migration 066's
  write path) — **118 test files passed, 1974 tests passed, 0 failed.**
- `npx vite build --outDir /tmp/km-b2rr` — succeeds, exit 0 (one
  pre-existing >500kB single-chunk warning, unrelated to this diff).

Server (`server/`):
- `npm run typecheck` — clean, 0 errors.
- `npx vitest run tests/routes/topik.test.ts` — **112 passed** (111 baseline
  + 1 new mismatched-topikLevel test).
- `npx vitest run` (full server suite, per the same full-suite-for-schema-
  changes policy) — **44 test files passed, 1157 tests passed, 0 failed.**

DB (dockerized, full `db/tests` suite per the schema-change gate policy, not
just the two named files — `test_migration_066.py` + `test_migrations.py`):
```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO_ROOT":/repo:ro -w /repo python:3.12 sh -ec '
    pip install --quiet --no-cache-dir "psycopg[binary]==3.2.3" \
      "structlog==24.4.0" "testcontainers[postgres]>=4,<5" "pytest>=8,<10" &&
    python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py \
      -p no:cacheprovider -q'
```
Result: **N passed** — see final message for the exact count captured at
completion.

## Recommendation

**Ship.** All 3 SHOULD-FIX items are genuinely fixed with load-bearing
regression tests, no PRAISE item was disturbed, and the fix-pass's own diff
is minimal and exactly targeted (10 files, mostly comments + 2 small
functional changes + 2 new tests). The only note I'd send back is a
documentation correction (the exhaustiveness throw crashes the *whole app*
via the root-level `ErrorBoundary`, not just the `PastExams` page — same
ship recommendation either way, just fix the description) and an optional
low-priority backlog suggestion to degrade gracefully one level up instead
of a hard throw. Neither blocks this batch.
