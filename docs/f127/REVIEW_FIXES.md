# F-127 Feedback FAB — Phase 4 Re-Review of Fix-Pass

Reviewer: independent senior review (fresh eyes — did not write the feature,
did not perform either original review, did not perform the fix-pass).
Scope: verifying `docs/f127/FIX_REPORT.md`'s claims against the actual
commit `474deb5` on `feat/f127-feedback-fab`, checked against the two
original PASS reviews (`REVIEW_client.md`, `REVIEW_backend.md`, both 0
blockers / 4 SHOULD-FIX total).

## Verdict

**PASS.** All 4 SHOULD-FIX findings are genuinely closed by non-tautological
tests that fail under the exact regression each guards against. The
fix-pass touched **only test files** (plus the review/report docs
themselves) — zero production or migration code was modified. No PRAISE
item, F-023 guarantee, or migration/immutability guarantee was weakened;
every new assertion is additive.

## Production code untouched? — CONFIRMED

```
git diff 474deb5~1 474deb5 --stat
 client/src/components/FeedbackFab.test.tsx | 104 ++
 client/src/lib/nav.test.ts                 |  44 ++
 docs/f127/FIX_REPORT.md                    |  62 ++
 docs/f127/REVIEW_backend.md                |  75 ++
 docs/f127/REVIEW_client.md                 | 216 ++
 server/tests/routes/tickets.test.ts        |  36 ++-
 6 files changed, 536 insertions(+), 1 deletion(-)
```
No `FeedbackFab.tsx`, `FeedbackFab.css`, `nav.ts`, `Tickets.tsx`,
`tickets.ts`, `PatchBodySchema`, or `058_ticket_source_page.*.sql` appears
in the diff. The FIX_REPORT.md claim ("no production/migration code
changed") is accurate, verified directly from the diff rather than taken on
faith.

## Finding-by-finding table

| # | Finding (original review) | Fix-pass claim | Independently verified? | Status |
|---|---|---|---|---|
| Backend SF-1 | No test asserts `source_page` rejected on PATCH | Added PATCH test, 400 + `validation_error`, ticket untouched | Yes — read the new test (`tickets.test.ts:387-413`): PATCHes `{title, source_page:'/hijack', expected_version:1}`, asserts 400 + code, then re-GETs and asserts `source_page`/`title` unchanged. `expected_version: 1` matches the file's own established convention for a freshly-created ticket (used identically at lines 71, 326, 344, 400) — not an invented assumption. `PatchBodySchema` (`tickets.ts:226-238`) confirmed to have no `source_page` key and `.strict()`. Test would fail (200 instead of 400) if `source_page` were ever added to the schema. | **FIXED** |
| Backend SF-2 | round-trip test doesn't re-assert anonymity on same payload | Added `assertAnonymized(community.body)` to the existing round-trip test | Yes — `tickets.test.ts:209`. `assertAnonymized` (line 41-45) is a structural whole-JSON-stringify check for `user_id`/`userId`/`email` substrings, already used identically at 5 other call sites in the same file (99, 154, 272, 432, 446) — this is the same real check, not a weaker local stand-in. Would fail if a future `SELECT t.*`-style refactor leaked `user_id` alongside `source_page` on the same community row. | **FIXED** |
| Client SF-1 | `pageNameForPath` tier-2 (prefix/segment-boundary) branch had zero coverage | 5 new tests in `nav.test.ts`, incl. `/uploads/42`→"Uploads" and longest-prefix-wins | Yes — confirmed against the real `NAV_ITEMS` manifest (`nav.ts`): `/uploads` (label "Uploads") exists exactly as the JSDoc's own example. `/review` (label "Library", 7 chars) and `/review/vocab` (label "Vocabulary", 13 chars) both genuinely exist as distinct-length NavItems, so the "longest-prefix-wins" test (`/review/vocab/123` → "Vocabulary", not "Library") is a real, non-vacuous exercise of the `p.length > best.path.length` comparison in `pageNameForPath` — not a coincidental single match. The segment-boundary negative (`/uploadsx` must NOT tier-2-match) and the "`/` never wins" guard are both real branches in the implementation (`nav.ts` lines ~409-426), correctly targeted. | **FIXED** |
| Client SF-2 | No dedicated `FeedbackFab.test.tsx`, no CSS-contract pin for top-right placement | New test file: a11y contract block + CSS-placement-contract block | Yes — read `FeedbackFab.test.tsx` in full. The a11y block renders the real component in a `MemoryRouter`, confirms `<button>`/`type=button`/`aria-label`/`.focusring` class, and — notably — the keyboard-activation tests are genuinely behavioral, not mocked: pressing Enter/Space fires the real `onClick` → real `navigate('/tickets', {...})` → `FeedbackFab`'s own `useLocation()`-driven `isHiddenPath` check causes it to render `null` post-navigation, and the test asserts the button *leaves the DOM* as proof, rather than spying on a callback. The CSS-contract block reads the actual `FeedbackFab.css` off disk, regex-asserts `position: fixed`, a `top:` anchor, a `right:` anchor, and explicitly asserts the *absence* of a `bottom:` declaration (ChatFab's anchor) — this would fail immediately if the rule were ever changed to `bottom:`, exactly the collision regression the module header claims can't happen. | **FIXED** |

## New findings

None. No new BLOCKER, SHOULD-FIX, or NIT surfaced during this re-review.
Two minor observations, neither rising to a finding:

- The FeedbackFab keyboard-activation tests assert absence of the button
  from the DOM as a proxy for "navigation occurred," rather than asserting
  the router's resulting path directly (e.g. via a test-only route probe).
  This is sufficient given `isHiddenPath`'s own coverage elsewhere
  (Shell.test.tsx's `/tickets` matrix), but a slightly more direct
  assertion (e.g. rendering a sibling `<Routes>` with a `/tickets` marker
  element) would be marginally more explicit about *why* the button
  disappeared. Not worth blocking on — the causal chain is short and
  already independently verified (module source read above).
- All 4 NIT items and the 2 DEFERRED-vs-REJECTED items from the original
  reviews were correctly left untouched, matching the "test-coverage gaps
  only, no behavior changes" scope the fix-pass set for itself. Confirmed
  by inspection: `Tickets.tsx`, `Tickets.css`, migration files, and
  `tickets.ts` (production route logic) are absent from the diff.

## Regressions / weakened guarantees check

- F-023 (anonymity, `canEdit`-from-version, 409 recovery): untouched —
  confirmed no lines in `Tickets.tsx` or the 409-path handler appear in the
  diff.
- Migration 058 / `source_page` immutability: untouched — no migration
  file in the diff; `PatchBodySchema` unchanged; the new PATCH test
  independently re-verifies immutability rather than assuming it.
- `assertAnonymized` usage: strictly additive (one new call site, same
  function, same semantics as its 5 existing uses).
- No `.only`/`.skip`/`xdescribe`/`xit` introduced anywhere in the 3 changed
  test files (checked directly).

## Recommendation

Ship as-is. All 4 SHOULD-FIX findings are closed with real, falsifiable
regression tests; zero production/migration surface was touched; no prior
guarantee was relaxed. No conditions attached.
