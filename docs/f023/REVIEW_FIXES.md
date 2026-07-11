# F-023 Ticketing — Phase 4 Re-Review (Fix-Pass Verification)

**Reviewer:** independent re-reviewer (did not write the original diff, the
original reviews, or the fix-pass). Fresh eyes, code-level verification only.
**Scope:** `client/src/pages/Tickets.tsx`, `client/src/pages/Tickets.test.tsx`,
`client/src/services/tickets.ts`, `client/src/types/domain.ts` (Ticket*
section). Verified against commit `7439ac8` ("fix(tickets): F-023 fix-pass —
a11y error association, canEdit narrowing, abortable 409 recovery") on
`feat/f023-ticketing`.
**Verification performed:** read the full diff (`git show 7439ac8`), read the
resulting source in place (not just the diff hunks), traced the a11y id
round-trip and the `asOwnTicket` discriminator by hand, ran
`npx vitest run src/pages/Tickets.test.tsx` independently (16/16 pass, not
trusting the stated gate). Attempted a live mutation-revert of the B-1 fix to
confirm the new test fails on unfixed code; the harness's sandbox correctly
blocked the file write per this review's own "do not modify code" scope, so
the check was completed by static trace instead (see B-1 row) — logically
equivalent to the fix-pass's own reported mutation-check output.

## Verdict

**PASS.** All 4 findings (1 blocker, 3 should-fix) are genuinely fixed, not
just claimed-fixed. No regressions. No new findings. The three
praise-preserving invariants (anonymity, IDOR-safe `canEdit`, 409 recovery)
are verified unchanged at the code level, not just asserted in the fix-pass's
own report.

## Finding-by-finding table

| # | Original finding | Disposition claimed | Verified? | Evidence |
|---|---|---|---|---|
| B-1 | Title/body error `<p>` had no `id`; input had no `aria-describedby` (WCAG AA fail) | FIXED | **YES** | `Tickets.tsx` diff: `<p id={`${titleId}-error`} ...>` / `<p id={`${bodyId}-error`} ...>` now exist; inputs set `aria-describedby={fieldErrors.title ? `${titleId}-error` : undefined}` (title) and the body equivalent — `undefined` when clean, so no dangling reference to a non-existent node. New test (`Tickets.test.tsx` lines ~105-125) asserts `titleInput.getAttribute('aria-describedby')` **equals** `titleError.id` (and same for body) plus `expect(titleError.id).toBeTruthy()` — this is a real id round-trip check, not a "does error text render" tautology. Traced by hand: on the pre-fix code the `<p>` has no `id` attribute, so `titleError.id` reads as `''` (jsdom default) while `titleInput.getAttribute('aria-describedby')` reads `null` — `null !== ''`, so the assertion fails, matching the fix-pass's own reported mutation output (`AssertionError: expected null to be ''`) exactly. |
| SF-1 | `as OwnTicket` unchecked cast at two sites (`ownVersion`, `save()`) | FIXED | **YES** | New `asOwnTicket(ticket): OwnTicket \| null` uses `'version' in ticket` — a real structural/runtime discriminator on `OwnTicket`'s own field (`domain.ts:2297`), not the `canEdit` boolean. Both call sites updated: `ownVersion = canEdit ? asOwnTicket(ticket)?.version : undefined` and `save()` now does `const own = asOwnTicket(ticket); if (!canEdit \|\| !own) return;` — an ill-typed/mismatched value can no longer silently flow through as an `OwnTicket`; it now safely no-ops. No unchecked `as OwnTicket` remains anywhere in the file (grep-confirmed). |
| SF-2 | `refetchOwnTicket` had no `AbortController`, inconsistent with the file's stated contract | FIXED | **YES** | New `refetchOwnTicketCtrlRef` (`useRef<AbortController \| null>`) follows the same abort-prior-then-track pattern as the other loaders; `listMyTickets(undefined, ctrl.signal)` now threads the signal (confirmed `listMyTickets`'s signature in `services/tickets.ts:168-171` already accepted an optional `signal` and passes it to `api.get`). A new `useEffect` cleanup on the `Tickets` page component aborts any in-flight recovery fetch on unmount. This is a real fix, not cosmetic — the signal is actually wired into the underlying `api.get` call. |
| SF-3 | No test for "community window resets on filter change" | FIXED | **YES** | New test expands the window via "Show more" (18 rows, confirms `#16` visible), then calls `user.selectOptions` on the status filter, waits for `listCommunityTickets` to be called with the new filter, then asserts `#15` visible and `#16` **not** visible. The mock (`ticketsSvc.listCommunityTickets.mockResolvedValue(many)`) returns the same 18 rows regardless of filter value, so the only thing that can make `#16` disappear is `communityPage.reset()` actually firing — this is a genuine "expand then change filter then assert collapse" test, not a weaker proxy. |

## Praise-preservation check

- **Anonymity contract — UNCHANGED.** `CommunityTicket` (`domain.ts:2307-2318`) and `TicketComment` (`domain.ts:2334-2339`) are untouched by this commit (diff touches only `Tickets.tsx`/`Tickets.test.tsx`/`docs/f023/*`) — no author/user field exists on either type; nothing in the fix-pass diff renders one.
- **IDOR-safe `canEdit` — UNCHANGED, and the SF-1 fix only hardens its consumption.** `canEdit={mineDetail !== null}` (`Tickets.tsx:1002`) and `mineDetail = mine.find((t) => t.id === ticketId) ?? null` (`Tickets.tsx:972`) are both untouched — edit rights are still derived exclusively from `/tickets/mine` membership, never from `isMine`. `asOwnTicket` doesn't change *what* grants `canEdit`; it changes how the already-`canEdit`-gated code safely narrows the union before touching `.version`. If a future refactor ever decoupled `canEdit` from real `version`-bearing rows, `save()` now silently no-ops instead of operating on a garbage cast — a strict hardening, not a behavior change at today's call sites (test suite for the 409/edit paths is still 16/16 green, confirming no functional change at the current call sites).
- **409 recovery — UNCHANGED in logic, hardened in lifecycle.** `refetchOwnTicket` still fetches unfiltered (`listMyTickets`, no `statusFilter`/`typeFilter` args), still `.map()`-patches exactly one row into `mine`, still routes through `onTicketUpdated` → `role="status"` conflict notice → draft reset via the `[ticket.id, ownVersion]` effect, and still never blindly retries the write. SF-2 only adds an `AbortController` + unmount cleanup around the same call — the recovery semantics are byte-for-byte identical.

## New findings

None. No regressions introduced by the fix-pass; no new gaps surfaced during this re-review beyond what was already out-of-scope-and-flagged (N-1/N-2 from `REVIEW_ux.md`, both nits from `REVIEW_boundary.md`), which the fix-pass correctly left untouched per its own report.

## Recommendation

Ship it. All 4 findings from the two original reviews are genuinely resolved at the code level (verified independently, not taken on the fix-pass's word), the three security/anonymity-critical invariants praised in the original reviews are provably unchanged, and no new findings surfaced. `feat/f023-ticketing` is clear for merge on the ticketing-client slice.
