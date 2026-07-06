# Progress + Today audit

Scope: `client/src/pages/Progress.tsx` (+ `.css`, `.test.tsx`), `client/src/pages/Today.tsx` (+ `.test.tsx`),
`server/src/routes/vocab.ts` (`/vocab/mastery`), `server/src/routes/diagnostic.ts` (`/diagnostic/history`,
`/diagnostic/latest`). Read-only review; no code changed. Cross-checked against live data in `km-db`
(user 1: 2 diagnostic snapshots, 242 vocab cards) and the existing Vitest suites.

## Verdict

Solid overall. Both screens already carry real edge-case handling (0/1/2-attempt trend chart, 0/242-card
mastery list, error-vs-empty distinction, abortable refetches) backed by tests that actually exercise those
paths — this is clearly past at least one prior `/fixpass` round (see `db/docs/FIX_REPORT_F013.md`,
`REVIEW_F013_FIXES.md`). No P1s found. One real P2 (light-theme contrast regression the prior F-013 fix
didn't fully cover) and two P3 copy/grammar nits. Verified against the live DB that the mastery bucket math
(194 new / 44 learning / 4 reviewing / 0 mastered = 242 total) matches the server's SQL exactly.

## Findings

### P2 — Word-mastery per-word badge text fails WCAG AA contrast in light theme
**File:** `client/src/pages/Progress.css:321-331` (`.km-mastery__badge`, `.is-learning`, `.is-mastered`)
**Repro:** Open Progress in light theme with any vocab cards banked (the real test user has 44 "Learning"
cards, the largest non-new bucket). Each row's bucket badge (`New`/`Learning`/`Reviewing`/`Mastered`) uses
the raw brand accent as *text* color on the `--ink-1` card paper (`#F3ECD5`):
- `Learning` badge: `--ochre` `#B07A1F` on `#F3ECD5` → **3.15:1** (fails AA 4.5:1 for normal text; the badge
  is 11px, not "large text")
- `Mastered` badge: `--moss` `#5C7548` on `#F3ECD5` → **4.34:1** (fails, barely)
- `New` badge (default `--paper-mute`): `#7C7058` on `#F3ECD5` → **4.12:1** (fails, barely)
- `Reviewing` badge: `--indigo` `#2E4F70` on `#F3ECD5` → **7.20:1** (passes)
Dark theme is fine across the board (6.5–9.3:1).

**Why it matters:** the earlier F-013 review (`REVIEW_F013_FIXES.md`) caught and fixed exactly this class of
bug once already — chip *counts* and the active-chip border were using `--ink` (a surface token) instead of
`--paper` and were unreadable. That fix only touched `.km-mastery__chip`/`.km-mastery__chip b`. The sibling
per-word-row **badge** classes (`.km-mastery__badge.is-learning`/`.is-mastered`, plus the default `new`
badge) still use the plain brand accent / `--paper-mute` directly as text color and were never re-validated
the way the trend-chart series colors were (Progress.css's own header comment documents CVD/contrast
validation for the *chart* palette, not this one). Net effect: with a friend tester's real card mix (mostly
`new`/`learning` early on), the badge tags on most rows will look washed out in light mode / bright light —
not unreadable, but a measurable regression below the app's own accessibility bar.
**Will a tester hit it:** yes — any tester in light theme who scrolls the word list will see it on most rows,
since `new`/`learning`/`mastered` are the common early-game buckets and only `reviewing` passes.

### P3 — "1 cards due" grammar (no singular form)
**File:** `client/src/pages/Today.tsx:242` (aria-label) and `:247` (visible label)
```
242  aria-label={`Open review — ${String(today.data.reviewCount)} cards due`}
...
247  {today.data.reviewCount} cards due
```
**Repro:** any day the FSRS queue has exactly 1 card due → tile and its screen-reader label both read
"1 cards due" instead of "1 card due".
**Will a tester hit it:** plausible but not guaranteed — depends on hitting exactly `reviewCount === 1`,
which is common on a light review day or right after a fresh account. Minor, purely cosmetic; no functional
impact.

### P3 — Stale "Read/Listen" copy in the Word Mastery empty state
**File:** `client/src/pages/Progress.tsx:824-826`
```
No vocab cards yet — tap a word in Read/Listen and add it to your
review deck, and its mastery shows up here.
```
**Repro:** a friend with 0 vocab cards opens Progress → sees this invite text. There is no "Read" tab in
the current nav (`client/src/lib/nav.ts:150-156` — the tab is named **Listen**, path `/ttmik`; `/reading`
is a redirect-only legacy route per `App.tsx:79-85`, not a visible nav item). Tap-to-bank (`WordPopover`)
today only lives on the Listen (`Ttmik.tsx`) and Images (`Images.tsx`) screens, not a "Read" screen.
**Will a tester hit it:** yes, for any tester who opens Progress before banking their first word (very
likely to be the *first* thing a new tester sees on this screen) — they'll look for a tab called "Read"
that doesn't exist. Confusing but harmless; easy one-line copy fix (not made, per read-only scope).

## Checked-and-clean

- **Trend chart sparse-data handling** (`Progress.tsx:140-173, 269-286`): 0 attempts → `EmptyBlock` invite
  card, no chart/table rendered (verified: `queryByRole('table')` absent). 1 attempt → markers-only chart
  (line requires `run.length >= 2`), "One attempt so far" note, comparison card correctly hidden
  (`n >= 2` gate), attempts table still lists the single row. 2 attempts (the real user's actual state,
  verified live in `km-db`: snapshots `2026-07-02`/`2026-07-04`, all 4 dimensions present both times) →
  chart lines, comparison block, and table all render correctly; no NaN/crash. All three states have
  passing tests that actually assert the DOM (`Progress.test.tsx:264-317`), not just "doesn't throw."
- **Diagnostic history fetch failure vs. empty state** (`Progress.tsx:186-192`): a real fetch error is
  never dressed up as "no history yet" — `fatalError` is set whenever `hist.error !== null` AND there's
  nothing to show, independent of the mock's intentionally-empty fallback. Tested and correct.
- **Word Mastery pagination math**: server (`vocab.ts:890-899`, `LIMIT/OFFSET` + `COUNT(*) OVER()`) and
  client pager (`Progress.tsx:869-895`, `offset+1`–`min(offset+30,total)` of `total`) verified against a
  direct DB query against user 1's real 242 cards / 44-row "learning" bucket — counts match exactly
  (194/44/4/0/242). Prev/Next disabled-state boundaries are correct at both ends.
- **Bucket filter reset-to-page-1**: `selectBucket` resets `offset` synchronously in the same handler as
  `setBucket` (not a separate effect) — confirmed no double-fetch and no stale-offset-into-empty-page trap
  when switching from a large bucket to a small one (this was an explicit BLOCKER-adjacent fix in the prior
  F-013 pass; re-confirmed still in place).
- **Refetch-error degradation** (`Progress.tsx:815-841`): a bucket/page refetch failure after initial load
  keeps the previously-loaded list/bar/pager fully rendered and shows a small inline
  `role="alert"` "Couldn't refresh…" banner with its own Retry — it does NOT fall back to the full
  `ErrorCard` and does NOT wipe `page` to null. Confirmed both in code and via the
  `'keeps the loaded list when a REFETCH fails'` test (`Progress.test.tsx:419-436`), which is exactly the
  regression-guard the earlier independent re-reviewer flagged as missing (`REVIEW_F013_FIXES.md` New
  finding #1) — it has since been added.
- **0 vocab cards / "no cards yet"**: gated on `page.summary.total === 0` (the *global* bucket sum, not the
  filtered page total), so it can't misfire while a filter is merely narrow. Tested.
- **DB parity**: `GET /vocab/mastery`'s summary query and the `BUCKET_CASE`/`BUCKET_PREDICATE` used for the
  per-word list are textually identical fragments (`vocab.ts:817-829`) — summary and filtered list can never
  disagree with each other, and manual re-execution of both queries against `km-db` for user 1 reproduced
  the exact same numbers the API would return.
- **Today tile routing post Read→Listen migration**: `Today.tsx:167-168` sends both the Reading task tile
  and the Listening task tile to `nav: '/reading'`, which is a deliberate redirect to `/ttmik`
  (`App.tsx:79-85`, "Read is retired — its content lives in Listen"). Confirmed this is intentional, not a
  dead link — `reading` (one TTMIK lesson) and `listening` (one Iyagi episode) tasks both belong on the
  unified Listen screen per `server/src/routes/plan.ts:9-11`. No 404, no stale label. (Tiles don't deep-link
  to the specific suggested lesson/episode — they land on the Listen browse view — but this matches the
  `TodayTask` type, which carries no id/slug to deep-link with, and the Writing tile behaves identically;
  this is a pre-existing design choice across all three tiles, not a Progress/Today-specific regression.)
- **Today skills-snapshot / review-queue / task-tile empty & loading states**: skeleton cards on load
  (`aria-busy`), "no diagnostic yet" nudge card when `dimensions.length === 0`, `ErrorCard` + independent
  `refetch` when either of the two fetches (`today`, `today.snapshot`) fails — each screen fails
  independently, confirmed by the docstring and by the two-key mock in `Today.test.tsx`. Null tasks (empty
  corpus) are omitted rather than faked (`Today.tsx:171-172`, tested at `Today.test.tsx:‘omits a task tile
  whose server task is null’`).
- **`largestGap` default / precedence** (`Today.tsx:84-106`): defaults to `Listening` only when the user has
  no diagnostic snapshot (`today.data?.largestGap ?? 'Listening'`), and the gap tile's "Largest gap" pill
  correctly outranks Writing's standing "Register drill" identity when Writing itself is the weakest skill.
  Tested both ways.
- **`GET /diagnostic/history`** (`diagnostic.ts:1349-1379`): user-scoped, parameterized, soft-delete filtered,
  deterministic tiebreak on `id` for same-timestamp snapshots. No BOLA/IDOR surface (no client-supplied id).
- **SkillsCompare bars** (used in Today's compact skills snapshot): fixed 0–100 scale, no ratio-based
  division — no div-by-zero risk from a zero-value reference.
- **Number/NaN safety**: `MasteryBar`'s denominator is `Math.max(1, summary.total)` (no div-by-zero even at
  0 cards); `overallOf`/`scoreOf` return `null` (rendered as `—`) rather than `NaN` for missing dimensions;
  `formatDay` returns `—` on an invalid date rather than "Invalid Date".
