# Fix Report — batch /fixpass (FSRS · TOPIK-UX · vocab-loader)

**Branch:** `fixpass-batch-review`
**Engineer:** independent fix-pass (did not author or review the batch)
**Scope:** the 4 SHOULD-FIX findings + the cheap NITs raised across the three
reviews. 0 blockers were reported; none were introduced. No praised behavior was
altered (server-authoritative scheduling + tamper test, the behavior-preserving
grammar extraction, the mock-wire answer strip, the loader's per-row
`MalformedEntryError` pre-validation are all untouched).

Landed as **two disjoint commits** so they can be shipped separately (the
vocab-loader + FSRS code is already merged to `rebuild`; the TOPIK-UX code is an
unmerged PR):

- **Commit A** (`topik-ux fixpass:`) — only `client/src/pages/topik/MockMode.tsx`
  and its test.
- **Commit B** (`fsrs+vocab fixpass:`) — only `server/src/services/fsrs.ts`
  (+ test), `tools/ingest/tests/test_load_vocab_2000.py` (+ new fixture), and a
  one-line comment in `server/src/routes/vocab.ts`.

---

## Findings & dispositions

| # | Finding (source review) | Severity | Disposition | Commit |
|---|---|---|---|---|
| 1 | FSRS-stability overflow — no upper clamp; a near-max `NUMERIC(10,4)` row × `easy` overflows → Postgres 22003 → 500 (REVIEW_BATCH_FSRS SHOULD-FIX #1) | SHOULD-FIX | **FIXED** | B |
| 2 | Mock timer counts interval ticks, not a wall-clock deadline → a throttled/backgrounded tab drifts and gains extra exam time (REVIEW_BATCH_TOPIKUX SHOULD-FIX #1) | SHOULD-FIX | **FIXED** | A |
| 3 | Timer a11y — per-second `aria-live="polite"` floods screen readers (REVIEW_BATCH_TOPIKUX SHOULD-FIX #2) | SHOULD-FIX | **FIXED** | A |
| 4 | Vocab proficiency level-aware terminal fallback is untested (source-default path short-circuits it) (REVIEW_BATCH_VOCABLOADER SF-1) | SHOULD-FIX | **FIXED** | B |
| N1 | `clamp()` not NaN-safe (REVIEW_BATCH_FSRS NIT #2) | NIT | **FIXED** | B |
| N2 | `ReviewBodySchema` deliberately non-`.strict()` — wants a cross-reference comment (REVIEW_BATCH_FSRS NIT #3) | NIT | **FIXED** | B |

NITs explicitly **not** taken (out of the assigned scope, and each is cosmetic):
`SECTION_MINUTES` vs `SECTIONS[].mins` duplication (TOPIKUX NIT #1), the interval
that keeps firing after 0 (TOPIKUX NIT #2), the count-mismatch structured-event
gap (VOCABLOADER N-1), and the unused `ReviewSubmission.duration_ms?` type field
(VOCABLOADER N-2). **DEFERRED** — none affect correctness or the fixed findings.

---

## What changed, per finding

### 1 + N1 — FSRS stability clamp + NaN-safe `clamp()` (Commit B)

`server/src/services/fsrs.ts`

- Added an exported `STABILITY_MAX = 36_500` (days, ~100 years) with a comment
  tying the value to the `NUMERIC(10,4)` ceiling (999,999.9999): even the largest
  multiplier (`easy` ×3.0) applied to the cap (109,500) stays an order of
  magnitude under the precision ceiling, so no reachable transition can overflow.
- Stability is now formed with `clamp(stability, 0, STABILITY_MAX)` (previously a
  bare `Math.max(0, …)`), so growth is bounded on write, not just floored.
- `clamp()` is now NaN-safe: a non-finite input resolves to the lower bound
  (`0` for stability, `1` for difficulty) — fail-to-safe, since each caller's
  lower bound is itself a valid, constraint-satisfying value. The module header's
  "no unbounded growth, no NaN / a corrupted row can never fail the constraints"
  claim is now literally true, including the precision-overflow case it previously
  did not cover.

Tests (`server/tests/services/fsrs.test.ts`): a near-max stability (`999_990`)
× `easy` now asserts the result clamps to `STABILITY_MAX` and stays `< 1_000_000`
(it would have computed `2,999,970` → 22003 on the pre-fix code); a repeated-easy
loop asserts the value holds at the cap; and a NaN-difficulty case asserts the
result is finite and floors to `1`.

### 2 — Mock timer wall-clock deadline (Commit A)

`client/src/pages/topik/MockMode.tsx`

- The countdown is now derived from a fixed `deadlineRef = Date.now() + budgetMs`
  captured on exam mount. The interval fires ~1×/s only to **re-sample**
  `ceil((deadline − Date.now()) / 1000)` (floored at 0) — it is a render trigger,
  not the source of truth. Auto-submit still fires when `remaining` hits 0. A
  throttled tab that skips fires lands on the correct remaining on its next tick
  and can never bank the skipped seconds as extra exam time. A guard skips the
  window before the deadline is established so a stray early fire can't read `0`
  and auto-submit instantly. The `h:mm:ss` / `mm:ss` format fix is preserved.

Tests: a new "throttled tab" test fakes **only** the interval and stubs
`Date.now`, advancing the wall clock 10 minutes while the interval fires once —
the deadline-based timer shows `1:00:00`; a tick counter (the pre-fix bug) would
show `1:09:59`. The existing per-second decrement and auto-submit tests still
pass unchanged.

### 3 — Timer a11y (Commit A)

`client/src/pages/topik/MockMode.tsx`

- The ticking `role="timer"` value is now `aria-live="off"` (polite still enqueues
  an announcement per tick — it only defers). Coarse spoken cues are emitted from
  a separate `km-sr-only` polite region at meaningful marks only (the final five
  one-minute boundaries, a 30-second warning, and time-up); between marks the
  string is empty so nothing is queued.

Tests: one asserts the timer carries `aria-live="off"`; another lands the wall
clock on the 60-seconds-remaining mark and asserts the polite region reads
"1 minute remaining." (never a per-second number).

### 4 — Vocab level-aware fallback coverage (Commit B)

`tools/ingest/tests/test_load_vocab_2000.py` +
`tools/ingest/tests/fixtures/vocab_mini_beginner_fallback.json`

- New fixture: the **same beginner corpus and the same four `source_id`s** as
  `vocab_mini_beginner.json` (so the beginner-corpus row count stays exactly 4 and
  no count-scoped sibling test is disturbed — `corpus_source_id` is 1:1 with the
  corpus enum), but with a **blank** header `default_proficiency`. That makes
  `normalize_proficiency` return `None` for both the row value and the source
  default, so the missing-proficiency word (`vocab-fix-0004`) must take the
  level-aware terminal fallback.
- New test loads it with `force=True` (so the last write is provably this
  blank-default file) and asserts, against the real Testcontainers DB, that
  `vocab-fix-0004` lands `basic` — the beginner branch of
  `_LEVEL_TO_FALLBACK_PROFICIENCY`, the second operand of the `or` that the
  existing source-default test short-circuits past. The existing source-default
  test is left intact (still covering the first operand).

### N2 — `ReviewBodySchema` non-`.strict()` cross-reference (Commit B)

`server/src/routes/vocab.ts` — added an inline comment stating the schema is
deliberately non-`.strict()` (unknown keys are stripped, not 400'd — this is the
tamper defense), warning a future reviewer not to "harden" it into `.strict()`
and 400 every legacy client, and contrasting the sibling `.strict()`
`MineBodySchema`.

---

## Verification (all suites, pinned CI containers per `Deploy/local-test.sh`)

| Suite | Toolchain | Result |
|---|---|---|
| Client (`npm ci → lint → tsc --noEmit → test → build`) | `node:20-slim` | **543 passed** (58 files); lint/tsc/build clean |
| Server (`npm ci → lint → typecheck → test`, Testcontainers) | `node:20-slim`, `--network host`, docker socket | **619 passed, 4 skipped** (42 files passed, 1 skipped) |
| Ingest (`pytest tests/test_load_vocab_2000.py`, Testcontainers) | `python:3.12` | **5 passed** (ordered and default order) |

Notes: the first client `lint` run flagged `react-hooks/rules-of-hooks` because the
new `useMemo` was placed after an early `return`; it was moved above the early
return (unconditional hook order) and the re-run is clean — no
`react-refresh/only-export-components` violation (the page still exports only its
component; `STABILITY_MAX` is a server-side, non-component export). The ingest
test count went 4 → 5, `fsrs.test.ts` 18 → 21, `MockMode.test.tsx` 9 → 12.

## Self-assessment

All four SHOULD-FIX findings and both cheap NITs are fixed atomically (code +
test), each fix honors the reviewers' stated intent, and every fix ships with a
regression test that fails on the pre-fix behavior (near-max overflow, tick-drift,
per-second announcement, missing fallback coverage). The two commits are disjoint
and land only the specified files. No praised behavior was undone; no blocker was
introduced. The one non-obvious design call was the vocab fixture: because
`corpus_source_id` is 1:1 with the corpus enum, a second beginner source file
would have broken the count-scoped sibling tests, so the new fixture reuses the
existing `source_id`s (count stays 4) and differs only in the header default —
verified order-independent. The deferred NITs are cosmetic and out of the assigned
scope.
