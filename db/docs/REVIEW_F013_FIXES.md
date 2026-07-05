# Re-review — F-013 word mastery fix pass

**Reviewer:** independent re-reviewer, fresh eyes, no code changed. Verified against
`SENIOR_ENGINEER_BAR.md`, the two original reviews (`REVIEW_F013_BACKEND.md`,
`REVIEW_F013_FRONTEND.md`), and `FIX_REPORT_F013.md` — the fix report's claims were
treated as unverified assertions and checked one-by-one against the actual diff on
`feat/word-mastery`, plus a full run of both test suites and both typechecks.

## Verdict

**PASS.** The BLOCKER is genuinely resolved and every SHOULD-FIX disposition holds up
against the real code — no regressions found. Server suite: 72/72 passed (including
both new backend tests). Client suite: 586/586 passed across all 60 files (including
3 new mastery tests). Both `tsc` builds are clean. One real gap remains: the graceful-
error behavior (S3) is correctly implemented in code but has **zero test coverage** of
the actual scenario it fixes — see New findings below.

## Finding-by-finding

### BLOCKER — CSS contrast (bucket-count text + active-chip) — **FIXED**
`client/src/pages/Progress.css:297-298`:
```css
.km-mastery__chip b { color: var(--paper); font-weight: 700; }
.km-mastery__chip.is-active { border-color: var(--paper); color: var(--paper); }
```
Confirmed against `client/src/styles/index.css:20-29` (light) and `:59-67` (dark):
`--ink`/`--ink-1`/`--ink-2`/`--ink-3` are surface tokens (comment literally says
"Surfaces"), `--paper` is the text-ink token (comment says "Type — sumi ink"), defined
distinctly in both `:root,[data-theme="light"]` and `[data-theme="dark"]` blocks — so
`var(--paper)` resolves to a real, high-contrast text color in both themes, not a
copy-pasted surface value. Grepped the entire mastery CSS block (and the whole file)
for remaining `--ink*` usage: only two hits, both legitimate surface roles —
`stroke: var(--ink-1)` (line 107, an SVG line, not the mastery block) and
`background: var(--ink-2)` (line 214, unrelated card background). **No remaining
`--ink`-as-text misuse anywhere in the mastery CSS.**

### Double-fetch on bucket tap — **FIXED**
`client/src/pages/Progress.tsx:770-773`: the separate offset-reset effect is gone.
`selectBucket` now does `setBucket(next); setOffset(0);` synchronously in one handler.
The single fetch effect (`:782-808`) has deps `[bucket, offset, nonce]`. Because both
setters are called in the same event-handler tick, React 18 batches them into one
commit, so the effect's cleanup+run fires exactly once per tap — not twice. Traced the
toggle-off path (`selected === b ? null : b`) and the paginate-then-switch-bucket path;
both also collapse to one commit, one fetch. No way found for a single tap to still
double-fetch.

### Dead `ctrlRef` — **FIXED**
`client/src/pages/Progress.tsx:782-808`: `ctrlRef` is gone. `ctrl` is now a plain local
`const` scoped to each effect invocation; the effect's own `return () => { ctrl.abort(); }`
(`:805-807`) closes over that specific run's controller. This is strictly safer than the
old ref-based version — there is no shared mutable ref to reason about, so no
set-state-after-unmount or cross-run race is possible. Every `.then`/`.catch` branch
still re-checks `ctrl.signal.aborted` before calling `setState` (`:793, 798`).

### Graceful error (stale-data preservation) — **FIXED in code, UNTESTED for the actual scenario**
`client/src/pages/Progress.tsx:815-839`: the outer branch is gated on `page === null`
(first-load loading/error), and only when `page !== null` does a later `error !== null`
render the small inline `role="alert"` stale banner (`:828-839`) with the previously
loaded `MasteryBar`/list/pager still fully rendered underneath. Confirmed `setPage`
is only ever called from the success branch (`:794`) — it is never reset to `null` on
error, so a refetch failure can't wipe good data. The initial-load error path (`page
=== null && error !== null`) still renders the full `ErrorCard` (`:819`), matching the
brief. **This part of the fix is correct.** See New findings for the test-coverage gap.

### Tests — backend — **FIXED, ran green, assertions are meaningful**
Ran `npx vitest run tests/routes/vocab.test.ts` directly (testcontainer Postgres):
**72/72 passed**, including the two new tests:
- `buckets exactly at the 21-day maturity threshold (>= is mature)`
  (`server/tests/routes/vocab.test.ts:1110-1132`) — seeds `stability=21` and
  `stability=20.9` on two `review`-state cards, asserts via a stability→bucket map that
  `21 → mastered` and `20.9 → reviewing`. This is a precise boundary assertion (not
  just a bucket count) and would fail immediately if any of the three call sites
  (`BUCKET_CASE`, `BUCKET_PREDICATE`, summary `FILTER`) were flipped from `>=` to `>`.
- `excludes non-vocab (topik) cards from the summary and list`
  (`:1134-1149`) — seeds one real vocab card plus a raw `INSERT` with `topik_item_id`
  set and no `vocab_entry_id`, asserts `summary.total === 1` and `words.length === 1`.
  This does prove the leak-detection property (if the topik card counted, total would
  be 2), though it doesn't additionally assert *which* card survived by id — a minor
  softness, not a defect.

### Tests — frontend — **FIXED, ran green, one test is weaker than its name implies**
Ran `npx vitest run src/pages/Progress.test.tsx` (bundled into the full client run
below): all mastery tests pass. Of the 3 new tests:
- **Toggle-off** (`Progress.test.tsx:365-386`) — genuinely meaningful: asserts
  `fetchMastery` was called with `bucket: 'mastered'` on the first tap, then with
  `expect.not.objectContaining({ bucket: expect.anything() })` on the second tap. This
  would fail on a broken toggle.
- **Pager** (`:388-417`) — genuinely meaningful: asserts `fetchMastery` called with
  `offset: 30` after clicking Next. Would fail on broken pager math.
- **Error/retry** (`:350-363`, `'shows an error card on failure and recovers on
  retry'`) — this test only exercises the **initial-load** failure path
  (`page === null && error !== null` → full `ErrorCard` → retry → success). That
  behavior was never broken, pre- or post-fix — it's the same branch in both versions
  of the code. **It does not exercise S3's actual fix** (a refetch failing *after*
  `page` is already populated, which should now show the inline stale-banner and keep
  the list visible, not the full `ErrorCard`). This test would pass identically against
  the *pre-fix* code, since it never gets the component into a `page !== null` state
  before triggering a second failure. See New findings.

**Full client suite:** `npx vitest run` → **586 passed, 60 test files, 0 failed.** No
regressions anywhere else in the app.

**Typecheck:** `tsc -b --noEmit` (client) and `tsc --noEmit -p tsconfig.build.json`
(server) both exit 0, clean.

### Rejected should-fix — reuse `useEndpointOrMock` — **Disposition is sound, stated rationale is incomplete**
Read `client/src/hooks/useEndpointOrMock.ts` in full. The fix report's stated reason
("that hook mandates a mockFn and falls back to it on failure... showing fake mastery
numbers would misrepresent progress") is technically true but slightly thin — this
file already demonstrates the counter-pattern one section up: `loadProgressHistoryMock`
(`Progress.tsx:120-125`) passes an **empty** mock (`{ snapshots: [] }`) through the same
hook precisely to avoid fabricating data, combined with a `fatalError` gate. So "the
hook always fabricates data" is not quite accurate as a blocking reason on its own.

The stronger, undocumented reason: `useEndpointOrMock`'s contract **unconditionally
resets `data` to `null` on every `key` change** (`useEndpointOrMock.ts:25-28, 176-185`,
explicitly documented: "Key changes reset `data` and `isMock` to their initial values
immediately"). Word Mastery's `bucket`/`offset` would have to be folded into `key` to
drive refetches on chip-tap/pagination — which means *every* bucket switch or page turn
would flash the loading skeleton and wipe the list to null, directly undoing the S3
graceful-degradation fix (keep the last good page visible across a param change). The
hand-rolled effect is therefore the *more* defensible choice than the fix report's
rationale suggests, not a dodge — but the documentation given for the rejection isn't
the real blocking reason, and a future reviewer citing only the fix report's stated
rationale could reasonably re-litigate it. Recommend strengthening the code comment
(and the fix report) to name the `key`-reset incompatibility explicitly.

### Regressions — **None found**
- Full client suite (586/586) and full server route file (72/72) both green.
- `tsc` clean on both sides.
- Offset-reset-on-bucket-change behavior (praised in the original frontend review) is
  preserved — `selectBucket` still resets offset to 0, just in the handler instead of a
  second effect, so switching from a many-page bucket to a short one still can't 404 into
  an empty page.
- No new BLOCKER introduced by any of the fixes.

## New findings

1. **NEW-SHOULD-FIX — S3's actual regression-prevention scenario has no test.**
   `Progress.test.tsx` has no test that: (a) lets `fetchMastery` succeed once so `page`
   is populated, then (b) makes a subsequent call (retry or bucket switch) reject, then
   (c) asserts the list/bar/pager are *still rendered* and only the small inline
   `role="alert"` banner appears (i.e., `ErrorCard` does NOT replace the card). Per
   SENIOR_ENGINEER_BAR §5.2 ("every bug fix ships with a regression test that fails on
   the old code"), this is exactly the missing case — the existing error/retry test
   would pass unchanged against the pre-fix implementation. Add: seed
   `mockResolvedValueOnce(MASTERY_DEFAULT)` then `mockRejectedValueOnce(...)`, trigger a
   second fetch (bucket tap or `retry()`), and assert `screen.getByText('사랑')` (the
   stale word) is still present alongside the "Couldn't refresh…" text, and that
   `ErrorCard`'s distinguishing content (e.g. the "Retry" button rendered by
   `ErrorCard` vs. the inline `km-mastery__retry` button) is NOT the full-card variant.

2. **NIT — rejected-should-fix rationale (S5) should name the real reason.** See above;
   not blocking, but worth a one-line comment update so the decision doesn't get
   re-litigated on a shaky premise.

## Recommendation

Ship it. The BLOCKER is resolved with the correct token in both themes, the double-fetch
and dead-ref SHOULD-FIXes are cleanly fixed with no regressions, and the graceful-error
behavior is correctly implemented in code even though its test coverage has a gap.
Before or shortly after merge, add the one missing regression test (New finding #1) so
the S3 fix is actually pinned — right now it's protected only by manual code inspection,
which is exactly the situation SENIOR_ENGINEER_BAR §5.2 exists to prevent.
