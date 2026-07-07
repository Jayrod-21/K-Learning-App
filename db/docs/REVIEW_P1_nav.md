# REVIEW — Overhaul P1.1 nav/routing/migration slice (commit 891a001)

Reviewer: independent (did not write this). Scope: `client/src/lib/nav.ts`,
`App.tsx`, `lib/redirects.tsx`, `components/BottomNav.tsx`,
`pages/ReviewLibrary.tsx` + `pages/Reading.tsx` placeholders, `Reference.tsx`
`?tab=`, and the whole-codebase `/review`→`flashcards` call-site migration.
Overriding requirement: zero regressions, no orphaned/broken routes.

## VERDICT: PASS

Blockers: 0. Should-fix: 0. Nits: 4. Verified in Docker (node:20-slim):
`tsc --noEmit` = 0, full `vitest run` = **832/832 pass, 79 files**.

## Definitive answers to the three probe questions

**(a) Any `/review`/flashcards call site missed or misrouted? NO.**
Grepped whole client for `'/review'`, `"/review"`, `` `/review` ``,
`navigate('/review`, `to="/review`, `navItem('review')` in non-test code —
every hit is a comment, `nav.ts:84` (the library NavItem, correct), or
`redirects.tsx` doc prose. Flashcards-intent sites repointed:
`Today.tsx:413` review-queue CTA → `/learn/vocab`. Library-intent: only
`nav.ts` itself + BottomNav via the manifest. Legacy flat paths
(`/topik /ttmik /grammar /writing /hanja /mistakes /reading`) — zero
remaining non-test literals anywhere in client src (the one grep hit,
`services/hanja.ts:101 api.get('/hanja')`, is a server API path, not a
route; likewise all `server/` hits are Express route paths). Router-state
deep links survive: `Review.tsx:602` → `navigate('/learn/grammar',
{state: {drillTarget…}})` lands on the real route (no redirect hop, so
state is preserved); `Grammar.tsx` reads `location.state.drillTarget` and
its scrub uses `location.pathname` (path-agnostic). `AskAboutThisButton`
still pins `CHAT_PATH = '/chat'` untouched, seeds via router state —
hard contract intact. Repo-wide sweep (PWA manifest `start_url: '/'`, no
`shortcuts`, no nginx/client-route coupling) clean.

**(b) All redirects + new routes resolve, no orphans? YES.**
`redirects.tsx` table: `topik→/learn/topik`, `ttmik→/learn/listen`,
`reading→/learn/listen` (correctly repointed from the old `/reading→/ttmik`
shim), `grammar→/learn/grammar`, `writing→/learn/writing`,
`hanja→/learn/hanja`, `mistakes→/review/mistakes` — every target is a real
route in `App.tsx:98-114`. `/review` and `/chat` deliberately NOT shimmed
(tested at `redirects.test.tsx:40`). `*→/` intact (`App.tsx:118`).
Component mapping all correct: `/learn/vocab→Review` (the FSRS flashcards
page), `/learn/listen→Ttmik`, `/learn/topik→Topik`, `/review→ReviewLibrary`,
`/review/mistakes→Mistakes`, `/learn/reading→Reading` placeholder. Every
NavItemId path has a route; every route has an element. `redirects.test.tsx`
walks the whole table against the REAL Route elements App mounts.

**(c) Any path lighting the wrong bottom-nav tab? NO.**
`matchActiveId` (BottomNav.tsx:121-140) does longest-prefix with a real
segment-boundary check (`pathname === it.path || startsWith(path + '/')`,
`/` matched only exactly). Verified per-path: `/review/mistakes` → Review
(tested, BottomNav.test.tsx:63); `/progress` → Progress only (no prefix
collisions exist among `/`, `/progress`, `/review`, `/settings`);
`/learn/*` → no tab, hexagon gets `--current` (tested, :71); menu open →
only hexagon reads active (tested, :94). `/reference`, `/diagnostic`,
`/images`, `/chat` light nothing — matches spec ("light none" on
non-primary). `/review-history`-style false-positive explicitly defended
(comment + boundary check). Bare `/learn` would set the hexagon current but
is unreachable — wildcard bounces it to `/` first.

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. **nav.ts:253-288** — the compile-time disjointness guard catches an id
   missing from all buckets (`_MissingFromBuckets`) and an id in TWO
   DIFFERENT buckets (`_Overlap*`), but a duplicate WITHIN one bucket
   (`['topik','topik',…]`) passes tsc — `satisfies ReadonlyArray<NavItemId>`
   allows repeats and `Extract` can't see them. Covered at runtime by
   `nav.test.ts:27` (`Set(buckets).size === buckets.length`), so the
   combined guard is sound; the doc comment could say "cross-bucket" to be
   precise about what tsc alone guarantees.
2. **nav.ts:290-303** — union↔`NAV_ITEMS` completeness is not a tsc
   guarantee either (an id could exist in the union but be absent from the
   array); guarded by the `navItem` throw + `nav.test.ts:33`. Acceptable and
   honestly documented in the code — noting for the record.
3. **Today.tsx:300** — the "Reading" task tile navigates to `/learn/listen`,
   not `/learn/reading`. Intentional and commented (retired Read screen's
   content lives in Listen; the new Reading page is an empty placeholder),
   and it matches the `/reading→/learn/listen` shim. Remember to repoint
   this tile when the real Reading page lands (P6).
4. **Reference.tsx:110-115** — `?tab=` is consumed once on mount; a
   same-route navigation that only changes the search param would not switch
   tabs. Unreachable today (ReviewLibrary is the only `?tab=` producer and
   the user always transits `/review`, unmounting Reference in between), and
   the comment states the one-shot semantics. Fine for P1.1; revisit if
   P1.2 adds another `?tab=` producer.

### PRAISE
- Migration hygiene is exemplary: zero stale path literals in non-test
  code, and the tricky id swap (`review` repurposed, `flashcards` new) is
  consistent across nav.ts labels/icons/eyebrows, routes, LearnMenu, tests,
  and comments.
- `redirects.tsx` as a testable data table mounted verbatim by App, with
  the test asserting exactly-7 coverage AND the negative contracts
  (`/review`, `/chat` never shimmed), is the right shape — a future rename
  can't silently drop a shim.
- No test was weakened. Every updated test (Today, Review, Topik, Grammar,
  Mistakes, AskAboutThisButton) is a pure path repoint with assertions
  intact; `Reference.test.tsx` gained real behavioural coverage (deep-link
  opens the tab AND renders its content; unknown `?tab` falls back to
  vocab). `Review.test.tsx` still asserts the drillTarget rides router
  state to `/learn/grammar`.
- ReviewLibrary's `?tab=` values (`vocab`/`grammar`/`dictionary`) all
  validate against Reference's `TABS` via the `isTab` guard — no dead tabs;
  coming-soon rows are inert non-buttons (tested).
- `matchActiveId`'s segment-boundary matching pre-empts the classic
  `startsWith` prefix bug, with the failure mode documented in place.

## Verification run
```
docker run --rm -v "$PWD":/repo/client -w /repo/client node:20-slim \
  sh -ec 'npm ci … && npx tsc --noEmit; echo TC=$?; npx vitest run | tail'
TC=0
Test Files  79 passed (79)
     Tests  832 passed (832)
```
