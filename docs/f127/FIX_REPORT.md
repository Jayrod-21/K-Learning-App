# F-127 Feedback FAB — Fix-Pass Report

Fix-pass against `REVIEW_client.md` and `REVIEW_backend.md` (both PASS, 0
blockers). Scope: every SHOULD-FIX across both reviews. NITs and PRAISE items
left untouched per instructions (no code-behavior changes — test-coverage
gaps only).

| # | Finding | Disposition | Self-assessment |
|---|---|---|---|
| Backend SF-1 | No test exercises PATCH-time rejection of `source_page` (immutability guarantee unverified by the suite) | **FIXED** | Added `rejects source_page on PATCH — page context is set once at filing, never rewritten` to `server/tests/routes/tickets.test.ts`'s `PATCH /tickets/:id` block. Asserts 400 + `validation_error` code when `source_page` rides along on a PATCH, and that the ticket's `source_page`/`title` are untouched afterward. **Verified the test is load-bearing**: temporarily added a `source_page` key to `PatchBodySchema` (simulating the exact regression the review warned about — a future "re-tag the page" feature loosening the schema) and reran; the test failed (`expected 200 to be 400`). Reverted; suite green again. |
| Backend SF-2 | The `source_page` + `/community` round-trip test doesn't call `assertAnonymized()`, so "carries source_page" and "still identity-free" are never asserted on the same payload | **FIXED** | Added `assertAnonymized(community.body)` to the existing `a ticket filed with source_page carries it on /mine and /community` test in `server/tests/routes/tickets.test.ts` (retitled to name the SF explicitly). **Verified load-bearing**: temporarily added `t.user_id` to the `/community` SELECT (simulating a careless `SELECT t.*`-style refactor) and reran; the test failed (`json contains 'user_id'`). Reverted; suite green again. |
| Client SF-1 | `pageNameForPath`'s tier-2 (prefix/segment-boundary) branch had zero test coverage — every existing test hit tier 1 (exact) or tier 3 (raw fallback) | **FIXED** | Added a `pageNameForPath` describe block to `client/src/lib/nav.test.ts` with 5 tests: (a) the JSDoc's own `/uploads/42` → "Uploads" example, (b) longest-prefix-wins when two NavItems both prefix-match (`/review/vocab/123` → "Vocabulary", not "Library"), (c) a segment-boundary negative (`/uploadsx` must NOT tier-2-match `/uploads`), (d) `/` must never win a spurious longest-prefix contest, (e) full tier-3 fallback. **Verified load-bearing**: weakened the `p.length > best.path.length` longest-match comparison to first-match-wins and reran; the longest-prefix test failed (`expected 'Library' to be 'Vocabulary'`). Reverted; suite green again. |
| Client SF-2 | `FeedbackFab` had no dedicated test file (unlike sibling `ChatFab`) and no CSS-contract pin for its top-right placement claim | **FIXED** | Added `client/src/components/FeedbackFab.test.tsx`: an a11y-contract block (real `<button>`, correct `aria-label`, shared `.focusring` class, keyboard activation on both Enter and Space — mirrors the house `HanjaCell.test.tsx` convention) and a CSS-placement-contract block that reads `FeedbackFab.css` from disk and regex-asserts `position: fixed`, a `top:` anchor, a `right:` anchor, and the **absence** of any `bottom:` declaration (ChatFab's anchor — the exact overlap regression the module header claims is impossible). **Verified load-bearing**: temporarily changed `top:` to `bottom:` in `FeedbackFab.css` (simulating the FAB drifting into ChatFab's corner) and reran; the placement test failed (missing `top: max(`). Reverted; suite green again. |
| Client NIT — `Tickets.tsx:867-876` comment overstates itself ("not trusted with a bare `as` cast" directly above a bare `as` cast) | **DEFERRED** | Out of scope: not a test-coverage gap, and fixing it means editing `Tickets.tsx`, a file untouched by this fix-pass (scope was SHOULD-FIX only; NITs are in-scope only when trivially fixable in a file already being edited). No code in `Tickets.tsx` was touched, so this stays deferred to a future pass. |
| Client NIT — duplicate `.km-tickets__file-source` / `.km-tickets__detail-source` CSS rules | **DEFERRED** | Same reasoning: requires editing `Tickets.css`, not touched by this pass. Low-cost, no urgency per the original review. |
| Client NIT — `FeedbackFab.tsx`'s inline `onClick` isn't memoized | **REJECTED** (as a fix target) | Reviewer explicitly noted this is "consistent with house convention, not a regression" and "irrelevant for a component this cheap to re-render." No action warranted; would be scope creep to "fix" a non-issue. |
| Backend NIT N-1 (`char_length` vs `length` naming) | **DEFERRED** | Style-only, migration-file inconsistency; not a test gap, not touched by this pass (no migration files edited). |
| Backend NIT N-2 (plain `ADD CONSTRAINT` vs `NOT VALID` + `VALIDATE CONSTRAINT`) | **DEFERRED** | Reviewer confirmed this is consistent with existing house precedent (migration 055) and negligible at current single-user/beta scale — not a regression, not touched by this pass. |

## Verification

**Client** (`cd client`):
- `npm run lint` — clean, 0 errors/warnings.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean, 0 errors.
- `npx vitest run src/components/Shell.test.tsx src/pages/Tickets.test.tsx src/lib/nav.test.ts src/components/FeedbackFab.test.tsx` — **4 test files passed, 59 tests passed, 0 failed.**

**Server** (`cd server`, Docker testcontainer):
- `npx tsc --noEmit` — clean, 0 errors.
- `npx vitest run tests/routes/tickets.test.ts` — **1 test file passed, 34 tests passed, 0 failed.**

## Regression-proof confirmation

Each of the 4 fixed tests was verified to actually fail when the guarded
behavior is broken, by temporarily reintroducing the exact regression the
review warned about, rerunning the single test, observing the failure, then
reverting:

1. Backend SF-1 test: added `source_page` to `PatchBodySchema` → test failed
   (`expected 200 to be 400`). Reverted.
2. Backend SF-2 test: added `t.user_id` to the `/community` SELECT → test
   failed (`json contains 'user_id'`). Reverted.
3. Client SF-1 (longest-prefix) test: changed the longest-match comparison
   to first-match-wins → test failed (`expected 'Library' to be
   'Vocabulary'`). Reverted.
4. Client SF-2 (CSS placement) test: changed `FeedbackFab.css`'s `top:` to
   `bottom:` → test failed (missing `top: max(`). Reverted.

`git status` after all reverts shows only the intended 3 file changes
(`client/src/lib/nav.test.ts`, `client/src/components/FeedbackFab.test.tsx`,
`server/tests/routes/tickets.test.ts`) — no stray edits left over from the
regression probes.

## Praise / F-023 / migration-guarantee integrity

No PRAISE item from either review was undone — no production code
(`FeedbackFab.tsx`, `FeedbackFab.css`, `nav.ts`, `Tickets.tsx`,
`tickets.ts`, migration 058) was modified by this fix-pass; only test files
gained new assertions. F-023 (anonymity, `canEdit`-from-version, 409
recovery) and the migration/immutability guarantees are untouched —
confirmed both by `git diff --stat` (only test files changed) and by the
new tests themselves, which independently re-verify (rather than weaken)
those exact guarantees.
