# Independent Review — Test-suite integrity under vitest 2 → 4 upgrade

**Reviewer:** Independent senior reviewer (did not author the change)
**Scope:** Test-suite integrity slice of the server dependency bump (worktree `agent-a866a005817c1f492`, branch `worktree-agent-a866a005817c1f492`, off `rebuild` @ `a41e6a9`).
**Date:** 2026-07-09

---

## Summary verdict: **PASS**

The vitest 2 → 4 upgrade preserves full test coverage. I ran the complete suite in the
worktree and reproduced the claimed result exactly: **52 files passed / 1 skipped, 980
tests passed / 4 skipped, exit 0** (Duration 713.72s). The single skipped file and its 4
skipped tests are the pre-existing opt-in real-Anthropic smoke suite — not a
newly-dodged vitest-4 failure. The config migration (`singleFork` → `fileParallelism:
false`, `isolate: true` retained) is correct and does not mask coverage: the two
`vi.mock` suites genuinely execute and exercise their mocks under v4's rewritten mocker.
The `real_smoke.test.ts` change is behavior-preserving.

**BLOCKER count: 0.**

---

## Findings

### PRAISE

- **P1 — Config comment is load-bearing and accurate.** `server/vitest.config.ts:11-20`
  documents precisely *why* `fileParallelism: false` replaces `singleFork` and *why*
  `isolate: true` is kept (per-file module-registry isolation required for the
  `vi.mock('node:fs/promises')` / `vi.mock('node:child_process')` suites). I verified
  each claim against the vitest 4 source (below). The comment is correct, not
  hand-waving.

- **P2 — `real_smoke.test.ts` change correctly diagnoses a latent bug in the old
  setup.** The old code constructed the proxy at collection time and *only* passed
  because sibling files' env stubs leaked through `singleFork`'s shared process
  (`server/tests/services/claude/setup.ts:15-16` sets `ANTHROPIC_API_KEY` /
  `DATABASE_URL`). Moving `makeProxy()` into `beforeAll` (`real_smoke.test.ts:51-53`) is
  the right fix — a skipped suite must not depend on env leakage. The comment
  (`real_smoke.test.ts:44-49`) explains this honestly.

### SHOULD-FIX

- None.

### NIT

- **N1 — Stale comment in `tests/setup.ts:5`.** The global setup file still says "The
  suite runs single-fork (vitest.config.ts), so every test shares one Node process."
  Under the new config each file runs in its own isolated fork (`isolate: true`), so
  tests do **not** share one process — the rate-limiter reset is now per-file-process,
  not process-global. The reset is still correct and necessary (each fork's module
  registry has its own in-memory limiter store), so behavior is unaffected, but the
  rationale sentence is now inaccurate. Cosmetic; not part of the diff under review, but
  the config change is what invalidated it. `server/tests/setup.ts:5`.

---

## Detailed verification (adversarial)

### 1. Full suite runs green — real numbers confirmed

`cd server && npm test` (i.e. `vitest run`), vitest **4.1.10**, node v20.20.2, Docker
29.6.1 available for testcontainers:

```
Test Files  52 passed | 1 skipped (53)
      Tests  980 passed | 4 skipped (984)
   Duration  713.72s
EXIT=0
```

Matches the claimed 52/1, 980/4, exit 0 exactly. Not a hang, not a flake — full
testcontainers Postgres path exercised (per-file `postgres:16-alpine`).

### 2. Coverage NOT silently reduced

- **Test-file diff vs `rebuild` is a single file.** `git diff rebuild --numstat --
  tests/` shows **only** `tests/services/claude/real_smoke.test.ts` changed (11 insertions,
  2 deletions). No test file was deleted, and no other test file was touched.
- **No test was `.skip`/`.todo`/`.only`/`it.skipIf`-gated to dodge a v4 failure.** A repo-wide
  scan `grep -rnE '\b(it|test|describe)\.(skip|todo|only|skipIf|runIf|fails)\b' tests/`
  returns exactly one hit: `real_smoke.test.ts:43 describe.skipIf(!RUN)` — the
  **pre-existing** opt-in gate, unchanged in this diff. Nothing new was skipped.
- **The changed file still contains the same 4 `it()` cases** it had on `rebuild`
  (`enrich`, `recognizeGrammarPattern`, `gradeWriting`, `generateGrammarDrill →
  scoreGrammarDrill` — `real_smoke.test.ts:55/68/79/99`). The diff only relocates
  `makeProxy()` from a top-level `const` into `beforeAll`; it neither adds nor removes a
  test. Total test count is therefore identical to baseline (984).

**The 1 skipped file + 4 skipped tests, enumerated:**

- **File `tests/services/claude/real_smoke.test.ts` (1 skipped file, all 4 of its
  tests).** Confirmed by running it in isolation: `vitest run
  tests/services/claude/real_smoke.test.ts` → `1 skipped (1)` file / `4 skipped (4)`
  tests. This is the OPT-IN live-Anthropic smoke suite, gated on
  `process.env.ANTHROPIC_SMOKE === '1'` (`real_smoke.test.ts:25,43`). It is skipped by
  design in a normal `vitest run` / CI so it never spends API tokens or needs network
  (documented in the file header, `real_smoke.test.ts:14-15`). This is a legitimate,
  long-standing opt-in — **not** a vitest-4 failure that was suppressed. The 4 skipped
  tests are precisely this suite's 4 `it()` cases; there are no other skips anywhere in
  the suite.

### 3. `fileParallelism:false` + `isolate:true` — correct, not a mask

Verified against the installed vitest 4 source:

- **`fileParallelism: false` genuinely serializes files.** `node_modules/vitest/dist/
  chunks/coverage.DM_a_rWm.js:223-224`: `if (!(options.fileParallelism ?? mode !==
  "benchmark")) resolved.maxWorkers = 1;` — setting it false forces `maxWorkers = 1`,
  overriding any user maxWorkers. Files therefore run strictly one at a time, so the
  per-file testcontainers Postgres instances in `server/tests/helpers/pg.ts:21-39`
  (`startPostgres()` → fresh container per file) cannot race, and the in-process
  rate-limiter stores stay deterministic (`tests/setup.ts:14-16` resets per test). This
  is exactly what `singleFork` provided for ordering. The 713s serial wall-clock is
  consistent with strictly-sequential file execution.
- **`isolate: true` is the real default and is preserved.** `node_modules/vitest/dist/
  chunks/defaults.9aQKnqFk.js:47`: `isolate: true` in `configDefaults`; the config does
  not override it, so each test file gets a fresh fork with its own module registry.
  This is the material difference from `singleFork` (one shared process) and is what the
  `vi.mock` suites require.
- **Both `vi.mock` suites PASS and genuinely exercise the mock under v4 (not
  no-op'd).** Ran them standalone: `vitest run tests/services/pdfPageRender.bounds.test.ts
  tests/routes/uploads.test.ts` → **2 passed / 68 passed**. Crucially, these pass
  *because* the mock applies, provable by the fixtures used:
  - `pdfPageRender.bounds.test.ts` mocks `node:child_process` + `node:fs/promises`
    (`:39-50`) and feeds `FAKE_PDF = '%PDF-1.4 fake bytes, never actually parsed'`
    (`:116`). Every assertion reads `execFileMock.mock.calls` / `fsMocks.*` (e.g.
    `:132-133`, `:145-150`, `:161`, `:213-220`). Poppler **is** installed on this host
    (`/usr/bin/pdftoppm`, `/usr/bin/pdfinfo`), so if v4's mocker had silently failed to
    intercept the builtins, the real `pdfinfo` would run against garbage bytes and the
    `execFileMock.mock.calls` assertions would see an empty call log → the suite would
    FAIL, not pass. Green here proves the builtin mock is live.
  - `uploads.test.ts` mocks `../../src/services/pdfPageRender.js`'s `renderPdfPagesToJpeg`
    (`:71-74`), then asserts `vi.mocked(renderPdfPagesToJpeg).toHaveBeenCalledWith(TINY_PDF)`
    (`:288`) and drives it with `mockResolvedValueOnce([jpegPage1, jpegPage2])` (`:278`).
    If the module mock were a no-op, the real renderer would run against `TINY_PDF` (a
    real 1-page PDF, `:84-92`) via the installed poppler and return one real JPEG — the
    `toHaveBeenCalledWith` / two-synthetic-page expectations would then throw. Green
    proves the module mock applied. `beforeEach` also calls
    `vi.mocked(renderPdfPagesToJpeg).mockReset()` (`:141`), which only succeeds on a real
    mock.

### 4. `real_smoke.test.ts` change is behavior-preserving

- With the suite skipped (default, no `ANTHROPIC_SMOKE`), `beforeAll` never runs — vitest
  does not execute lifecycle hooks for a skipped `describe`. Confirmed empirically: the
  standalone run reported `tests 0ms` and `4 skipped`, i.e. no proxy construction, no
  `loadConfig()`, no env read. This is the whole point of the move: under v4's per-file
  forks a skipped suite must not touch the environment (it previously only "worked" via
  `singleFork` env leakage). `real_smoke.test.ts:44-53`.
- Under `ANTHROPIC_SMOKE=1` the four assertions are byte-for-byte unchanged from
  `rebuild` — the diff (`git diff rebuild -- .../real_smoke.test.ts`) touches only the
  import line (adds `beforeAll`) and the proxy-construction site (top-level `const proxy
  = makeProxy()` → `let proxy!…; beforeAll(() => { proxy = makeProxy(); })`). No `expect`
  was added, removed, or softened. `makeProxy()` itself is untouched
  (`real_smoke.test.ts:30-38`).

### 5. Nothing unrelated in the test diff

`git diff rebuild -- server/tests/` touches only `real_smoke.test.ts`. `git diff rebuild
-- server/vitest.config.ts` is only the `singleFork` → `fileParallelism: false` swap plus
its explanatory comment. The remaining diff (`package.json`, `package-lock.json`) is the
dependency bump proper (out of this slice's scope). No assertion changes, no fixture
changes, no snapshot changes hidden in the test tree.

---

## Coordination observations (for the other reviewers)

- **`pg` version is unchanged** by this diff (8.21.0 in both `rebuild` and worktree
  lockfiles) — the "server dependency-vuln bump" here is `@anthropic-ai/sdk`
  ^0.80.0→^0.110.0, `uuid` ^10→^14 (with `@types/uuid` dropped, now bundled), and
  `vitest` ^2.1.8→^4.1.10. The pre-existing `pg@9.0` deprecation warnings
  ("Calling client.query() when the client is already executing a query") stream
  throughout the run but are **pre-existing** and originate in test code
  (`db/migrations` apply loop / helpers), not introduced by this bump. Out of my slice;
  flagging for whoever owns the runtime-deps review.
- **`@vitest/coverage-v8` / `-istanbul` appear only as optional peer entries** in the
  vitest-4 lockfile metadata; they are not installed (same as `rebuild`, which had 0
  references). The `test:coverage` script has never had a provider installed — pre-existing
  gap, unchanged, not a regression.
- **CI runs `npm test` (`.github/workflows/ci.yml:67`)** = `vitest run`, the exact command
  I ran. No CI-specific vitest flags that could diverge from local behavior.
- **`tests/setup.ts:5` comment is now stale** (see N1) — a docs-only follow-up for the
  builder if they touch that file; does not block.

---

## Bottom line

The upgrade is a clean, honest migration. Full suite reproduced green (52/1 files, 980/4
tests, exit 0). No coverage was silently reduced: the only skipped tests are the
pre-existing opt-in real-API smoke suite, the two `vi.mock` suites demonstrably still
intercept their mocks under vitest 4, and the `real_smoke.test.ts` refactor is
behavior-preserving with no softened assertions. **PASS, 0 blockers.**
