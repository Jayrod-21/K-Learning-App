# F-023 Ticketing Client — Fix-Pass Report

**Fix-pass agent:** independent (did not write or review the original diff).
**Scope reviewed against:** `docs/f023/REVIEW_ux.md` (CONDITIONAL PASS — 1 blocker, 3 should-fix),
`docs/f023/REVIEW_boundary.md` (PASS — 0 blockers, 2 nits).
**File(s) changed:** `client/src/pages/Tickets.tsx`, `client/src/pages/Tickets.test.tsx`.

## Findings & dispositions

| # | Finding | Severity | Disposition | Notes |
|---|---|---|---|---|
| B-1 | `FileTicketForm` title/body validation errors had no `id`/`aria-describedby` pairing — `aria-invalid` was set but the error text was never programmatically associated with the input (WCAG AA fail). | BLOCKER | **FIXED** | Mirrored `Login.tsx`'s established pattern: each error `<p>` now has `id={`${fieldId}-error`}`, and the corresponding input/`textarea` sets `aria-describedby={fieldErrors.x ? `${fieldId}-error` : undefined}`, conditional on the error being present (undefined when clean, so no dangling `aria-describedby` pointing at a node that doesn't exist). Applied to both the Title and Description fields. |
| SF-1 | `TicketDetail`'s `ownVersion`/`save()` narrowed `OwnTicket \| CommunityTicket` via an unchecked `as OwnTicket` cast, trusting the `canEdit` boolean prop rather than the type's own `version`-field discriminator. | SHOULD-FIX | **FIXED** | Added `asOwnTicket(ticket): OwnTicket \| null` (`'version' in ticket ? ticket : null'`) as the runtime discriminator. `ownVersion` now derives from `asOwnTicket(ticket)?.version`; `save()` computes `const own = asOwnTicket(ticket); if (!canEdit \|\| !own) return;` — the invariant ("edit rights only exist for a row that structurally carries `version`") is now compiler-narrowed instead of merely true-by-construction at the one current call site. No behavior change at today's call site (verified via the full targeted test run below); this is a safety net against a future refactor decoupling `canEdit` from `mine`-list membership. |
| SF-2 | `refetchOwnTicket` (the 409-recovery fetch) was the one fetch in the file with no `AbortController`, despite the module header's stated "every fetch is abortable" contract. | SHOULD-FIX | **FIXED** | Added a dedicated `refetchOwnTicketCtrlRef` (`AbortController \| null`), following the same abort-prior-then-track pattern as `loadMine`/`loadCommunity`/`CommentThread`'s loader. `listMyTickets` now receives `ctrl.signal`. A new `useEffect` cleanup on the `Tickets` page aborts any in-flight recovery fetch on unmount — the same "abort on unmount" contract every other loader in this file already honors. |
| SF-3 | No test exercised "the community window resets on filter change" (spec requirement; `communityPage.reset()` is called in both `onStatusFilterChange`/`onTypeFilterChange` but had no regression guard). | SHOULD-FIX | **FIXED** | Added `resets the expanded window back to the initial 15 when a filter changes` to the "Community windowing" describe block: expands the window to 18 visible via "Show more", changes the status filter (server mock returns the same 18 rows), and asserts the window collapses back to 15 (`#16` no longer rendered). This is a real regression guard — verified by hand that dropping either `.reset()` call would leave `count` at 30 and all 18 rows visible after the filter change, which this test would catch. |

## Praise items — verified NOT weakened

- **Anonymity contract**: `CommunityTicket`/`TicketComment` still have no author field; no touched code path renders one. Untouched by this fix-pass.
- **IDOR-safe `canEdit` derivation**: `canEdit={mineDetail !== null}` at the call site is unchanged. The SF-1 fix makes the *consumption* of that boolean inside `TicketDetail` more rigorous (discriminator-checked instead of blindly cast) — it does not touch how `canEdit` itself is computed, and does not relax the "edit rights come from `/tickets/mine` membership, never `isMine`" invariant. If anything this hardens it: a future bug that sets `canEdit=true` for a row lacking `version` will now safely no-op in `save()` instead of casting garbage.
- **409 optimistic-concurrency recovery**: `refetchOwnTicket`'s unfiltered single-row-patch behavior, the friendly `role="status"` conflict notice, and the "never blindly retry" catch structure are all unchanged — the SF-2 fix only adds a signal to the existing `listMyTickets()` call and an abort-on-unmount cleanup; the recovery logic itself (fetch unfiltered, `.map()` one row into `mine`, hand back to `onTicketUpdated`) is untouched.

## Out of scope (per instructions, not addressed)

- N-1 (`mine` has no windowing), N-2 (`GET /tickets/mine` load failure silently renders view-only), boundary review's N-1 (no unit test for `services/tickets.ts` mapping functions), and boundary review's N-2 (no runtime schema validation at the boundary — explicitly pre-existing app-wide policy, not to be changed).

## Verification gates (targeted, per fix-pass instructions — full suite left to the parent)

```
cd client
npm run lint                                                          → clean, 0 errors/warnings
npx tsc -p tsconfig.app.json --noEmit --incremental false             → clean, 0 errors
npx vitest run src/pages/Tickets.test.tsx src/pages/Settings.test.tsx  → 2 files, 66/66 tests passed
  (Tickets.test.tsx: 16/16 — 14 pre-existing + 2 new; Settings.test.tsx: 50/50, untouched)
```

## Mutation check (blocker fix)

Reverted the B-1 fix (removed the `id`/`aria-describedby` wiring on the Title field only) and re-ran the new
`programmatically associates each field error with its input via aria-describedby (WCAG AA)` test in isolation:

```
FAIL  Tickets — filing a ticket > programmatically associates each field error with its input via aria-describedby (WCAG AA)
AssertionError: expected null to be '' // Object.is equality
```

The test fails cleanly on the un-fixed code (asserts `titleInput.getAttribute('aria-describedby')` equals the
error node's real `id`; on unfixed code the attribute is `null`). Fix was then restored and the full targeted
suite re-verified green (16/16, 66/66 overall).
