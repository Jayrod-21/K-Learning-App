# Phase 3B Fix-Pass Report

Fix-pass agent (did not author or review this code). Branch `feat/phase3b-library`.
Scope = all 14 SHOULD-FIX across the four reviews (0 blockers). NITs out of scope
except where trivially co-located; 19 PRAISE items preserved.

Verification (targeted, full suite runs at the parent gate):
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors**
- `npm run lint` → **clean**
- Targeted vitest, 8 files → **136/136 pass** (Mistakes 16 · ReviewVocab 26 ·
  ReviewDictionary 13 · ReviewGrammar 20 · Uploads 12 · ReviewLibrary 10 ·
  LibrarySubnav 4 · UploadViewer 35)
- Mutation check: temporarily reverted the Mistakes limit fix + the
  ReviewDictionary retry fix → the 3 new tests covering them FAILED as required,
  then restored + re-ran green. The Tabs test fails structurally on the old
  strip (`getByRole('tabpanel')` cannot resolve — no tabpanel existed).

## Dispositions

### Cluster A — stale "Review" → "Library" copy (landing review SF-2/SF-3/SF-5)

| Finding | Disposition | What was done |
|---|---|---|
| Landing SF-2 — stale eyebrows on 3 browse sub-pages | **FIXED** | `ReviewVocab.tsx`, `ReviewDictionary.tsx`, `ReviewGrammar.tsx`: hand-written `"Review library / 복습 자료실"` eyebrow → manifest pair via `const LIBRARY_NAV = navItem('review')` (`label`/`kr` = Library/자료실) — rename-proof, same pattern the landing uses (P-1). ReviewVocab.test.tsx eyebrow test re-pinned to the new pair + asserts the stale pair does NOT linger. |
| Landing SF-3 — BackButton labels stale + inconsistent | **FIXED** | `Mistakes.tsx`, `Uploads.tsx`, `ReviewVocab.tsx`, `ReviewDictionary.tsx` (`label="Review"`) and `ReviewGrammar.tsx` (`label="Review library"`) → all `label={LIBRARY_NAV.label}` ("Back to Library" accessible name). All 5 pinned test expectations updated. `UploadViewer.tsx:601` bare "Back" left as-is per scope (multi-entry detail view — correct). |
| Landing SF-5 — LibrarySubnav landmark name | **FIXED** | `LibrarySubnav.tsx` `aria-label="Review library section"` → `"Library sections"`. New LibrarySubnav test pins the landmark name (fails on old code). ReviewGrammar's F-054 negative guard now checks BOTH vintages absent so neither can creep back. |

### Cluster B — code fixes

| Finding | Disposition | What was done |
|---|---|---|
| Mistakes SF-1 — silent limit=100 truncation presented as period total | **FIXED** | `Mistakes.tsx`: `fetchMistakes({ limit: MISTAKES_FETCH_LIMIT })` (200 = server max, documented constant); when `mistakes.length >= limit` the all-sessions stat softens to "Your most recent N missed" / "최근에 틀린 N문제" instead of claiming a 30-day total. 2 new tests: (a) realFn wire contract `{ limit: 200 }` (hook-options capture — MUTATION-VERIFIED failing on unfixed code); (b) 200-row log renders the softened copy and NOT "in the last 30 days". |
| Mistakes SF-2 — groupSessions aggregation untested | **FIXED** (test-only, no prod change needed) | 2 new tests: (a) two same-day same-mode misses (+1 other-session miss) → exactly one "2 missed" option, both tiles rendered under that filter in insertion order (`compareDocumentPosition`), other session excluded; (b) data reshape under a selected session → selector falls back to `''` "All sessions" with the full list + total stat, not an empty filter. Fixture timestamps 5 min apart so any real UTC offset keeps them same-local-day. |
| Vocab SF-1 — ReviewDictionary error path had no retry | **FIXED** | Mirrored ReviewVocab's `reloadTick` pattern: monotonic state + fetch-effect dep + `onRetry={retry}` on the ErrorCard (503 path retry-capable too — the KRDICT load may have finished by the retry). 2 new tests, MUTATION-VERIFIED failing without the fix. |
| Vocab SF-3 — ReviewDictionary coverage thin | **FIXED** | 5 new tests: typed-search-supersedes-초성 (incl. the real regression pin — after clearing the search no fetch resurfaces the stale `initial`, "전체" pressed); 503 copy + Retry recovery; generic 500 fixed-copy + Retry recovery; pager Prev/Next with offset assertions + "1–30 of 90"/"31–60 of 90" range copy; 초성 surviving a genre pivot and reapplying (pressed + `initial` param) on clear. File: 4 → 13 tests. |
| Grammar SF-1 — hand-rolled `role="tablist"` without the ARIA tabs contract | **FIXED** | Mounted shared `components/Tabs.tsx` (F-032 — built for exactly this) in controlled mode: `active={view}`, onChange narrowed onto the closed `View` vocabulary, render-function children switching Browse/Uploads. Full APG contract now: roving tabindex, Arrow/Home/End, `role="tabpanel"` + `aria-labelledby`/`aria-controls`. Bank-error card moved ABOVE the tabbed area (re-keyed panel must not unmount it mid-read). New keyboard test asserts roving tabindex, ArrowRight automatic activation (focus+selection+panel), Home return — fails structurally on the old strip. Existing `getByRole('tab', …)` tests unchanged and passing. |
| Grammar SF-3 — delete-confirm gate fails open | **FIXED** | `Uploads.tsx`: `typeof window !== 'undefined' ? window.confirm(…) : true` → `: false` + fail-CLOSED comment. **No new test**: the `window === undefined` branch is unreachable in jsdom (vitest always defines `window`; existing tests stub `confirm` itself and fully cover cancel/accept/failure). One-token defensive default; asserting it would require deleting the jsdom global mid-render — a test of the test env, not the component. |

### Cluster C — ticket-reference reconciliation (tickets verified present in `BUGS_AND_FEATURES.md`)

| Finding | Disposition | What was done |
|---|---|---|
| `/images` orphan → F-102 | **FIXED** | `ReviewLibrary.tsx` header: Scan-images-row removal now cites F-102 as the re-entry ticket. |
| Past-exams stub → F-103 | **FIXED** | `ReviewLibrary.tsx` (header + SECTIONS `exams` comment) and `ReviewLibrary.test.tsx` stub-pinning comment: "reported follow-up ticket / see the P3B ticket in the report" → concrete F-103. |
| KM-3B-M1 → F-104 | **FIXED** | `Mistakes.tsx` ×4 (module header, groupSessions comment, stat-line comment) — all cite F-104; "see the final report" pointer dropped. |
| KM-3B-M2 → F-105 | **FIXED** | `Mistakes.tsx` ×2 (module header, MistakeSession doc). |
| KM-3B-M3 → F-106 | **FIXED** | `Mistakes.tsx` ×2 + `Mistakes.test.tsx` section comment. Repo-wide grep: zero `KM-3B` refs remain. |
| F-053/F-056 provenance → F-107 | **FIXED** | `ReviewVocab.tsx` SavedFromUploads stub ("proposed ticket in the P3B report" → F-107); `ReviewGrammar.tsx` header distinguishes F-107 (user-saved provenance) from F-108 (extraction), matching the ticket's own "distinct from" note. |
| F-059/U2 extraction → F-108 | **FIXED** | `UploadViewer.tsx` (module header §OCR + inline F-059 comment) and `ReviewGrammar.tsx` (header, U1 scaffolding comment, GrammarUploads section banner) — every U2 mention now carries F-108. |
| F-058 respec → F-109 | **FIXED** | `Uploads.tsx` module header: "ticketed, see the F-058 disposition note in the phase report" → "F-058 is done-as-respecced to this viewable-rendition filter; literal source-format filter → ticket F-109". |

## Not done (deliberate)

- **NITs**: none applied. The only NIT living in a file I edited whose fix is
  truly trivial (landing NIT-4, `queryByText('Review')` full-string match) also
  carries a false-positive risk the reviewer themself flagged — left for a
  follow-up rather than risk churn. BottomNav/nav.ts comment NITs (NIT-1/2) are
  in files outside this fix-pass's diff.
- **`.km-resources__tabs`** (`styles/index.css:4610`) is newly orphaned by the
  Tabs mount (ReviewGrammar was its only consumer). Left in place per the
  documented parallel-build policy (`ReviewLibrary.css:4-8`) — joins the
  existing F-097 dead-CSS sweep set. Recorded here for F-097's executor.
- **UploadViewer.test.tsx comments** still say "U2" without the F-108 ref —
  comment-only, file otherwise untouched, out of scope.

## Praise-preservation check

Verified against all 19 PRAISE items: manifest-driven landing intact (extended
to the sub-pages, not replaced); Mistakes stub honesty/live-region/disclosure
untouched (stat line still only ever shows missed counts); derived stale-key
fallback untouched (now test-pinned); pagination-honesty contract, F-053 null
stub, showGrammar default, ResultPage union, boundary guards all untouched;
rotation geometry/zoom/cache-bust untouched (comment-only edits in
UploadViewer); F-054 removal-as-regression tests strengthened, not weakened;
fixed-copy discipline extended to the new error tests. Full suites for every
touched page pass unchanged except the deliberately re-pinned copy strings.

## Self-assessment vs the bar

- WCAG AA / ARIA: improved — real APG tabs on ReviewGrammar, honest landmark
  name on LibrarySubnav, retry affordance on ReviewDictionary errors.
- Strict TS at boundaries: `Tabs.onChange` string narrowed onto the closed
  `View` vocabulary; no new `any`/casts; tsc clean with `--incremental false`.
- No swallowed errors: ReviewDictionary error path now has recovery; no catch
  blocks added or loosened.
- Tests: every behavioural fix ships with a test that fails on the un-fixed
  code (mutation-verified for the two non-structural ones); new tests assert
  wire params, ARIA state, and DOM order — no tautologies.
- Co-located CSS: no CSS changes needed (Tabs brings its own co-located sheet);
  orphan recorded for F-097.
- No scope creep: diff confined to the 14 findings + their pinned tests.
- No console.log; zero TODOs; every pending-work comment now cites a concrete
  F-1xx ticket that exists in `BUGS_AND_FEATURES.md`.
