# F-023 Ticketing Client — UX/A11y/Correctness Review

**Reviewer:** independent senior reviewer (not the author)
**Scope:** `client/src/pages/Tickets.tsx`, `Tickets.css`, `Tickets.test.tsx`; sampled `Tabs`, `FilterSelect`, `BackButton`, `usePagination`/`ShowMore`; `server/src/routes/tickets.ts` contract.
**Branch:** `feat/f023-ticketing` vs `rebuild`. New files (no prior version to regress against).
**Verification performed:** re-read every reviewed file in full; ran `vitest run src/pages/Tickets.test.tsx` (14/14 pass) and `eslint` on the two client files (clean) independently, rather than trusting the stated gate.

## Verdict

**CONDITIONAL PASS — 1 BLOCKER, 3 SHOULD-FIX, 2 NITs.** The architecture is sound and the hard parts (409 optimistic-concurrency recovery, anonymity contract, IDOR-safe `canEdit` derivation, abortable fetches) are all correctly implemented and correctly tested. The one blocker is narrow and mechanical (a missing `aria-describedby` wire on two form fields) — not a design problem, a one-line-per-field omission that breaks this codebase's own established convention (`Login.tsx`).

## Bar checklist

| Item | Status |
|---|---|
| WCAG AA — labeled form controls (title/body/type/status) | PASS — every control has a real `<label htmlFor>` |
| WCAG AA — validation errors associated with their control | **FAIL** — see BLOCKER-1 |
| Keyboard-operable tabs + nested detail | PASS (via `Tabs` primitive, W3C APG roving-tabindex; sampled, unmodified) |
| ARIA correctness (status vs alert, live regions) | PASS — `role="status"` for loading/conflict-notice, `role="alert"` for errors, matches codebase convention |
| Strict TS at I/O boundaries (wire↔domain) | PASS — `services/tickets.ts` wire interfaces + explicit mapper functions, no `any` |
| Strict TS at internal prop boundaries | SHOULD-FIX — see SF-1 (`as OwnTicket` casts) |
| No swallowed errors; abortable fetch; real error+retry | PASS, with one gap — see SF-2 |
| 409 optimistic-concurrency recovery | PASS — refetches caller's own row unfiltered, patches one row (never clobbers a filtered board), friendly notice, re-editable |
| Tests exercise real behavior, not tautologies | PASS — all 14 tests assert on mock call arguments / rendered DOM state changes, not on trivially-true conditions |
| Co-located CSS | PASS — `Tickets.css`, BEM-ish `km-tickets__*` naming, no inline style leakage beyond what's already codebase-standard |
| No scope creep | PASS — touches `Settings.tsx`/`.css`/`App.tsx` only to add the entry point (routes to `/tickets`), explicitly deferred a bigger FAB entry to ticket F-127 |
| No `console.log` / TODO without ref | PASS — grep clean; the one deferred-work comment cites `F-127` |

## Findings by severity

### BLOCKER

**B-1 — Field-level validation errors are not programmatically associated with their inputs (`Tickets.tsx:315–358`).**
`FileTicketForm`'s title and body fields set `aria-invalid` on the input but the error `<p role="alert">` (lines 332, 354) has no `id`, and the input has no matching `aria-describedby`. A screen-reader user gets the error announced once (via the live `role="alert"` region firing on mount) but loses that association permanently afterward — tabbing back to the invalid field reads only "Title, edit text, invalid" with no indication of *what* is wrong, and there's no way to re-discover the message except visually. This is a regression against this codebase's own established pattern: `Login.tsx` wires `aria-describedby={error ? errorId : undefined}` on every comparable field (lines 264, 360, 379, 558, 574 — grep-confirmed). Fix is mechanical: give each error `<p>` an id (e.g. `${titleId}-error`) and add `aria-describedby` to the corresponding input, conditional on the error being present.

### SHOULD-FIX

**SF-1 — `TicketDetail`'s `canEdit`→`OwnTicket` narrowing relies on an unchecked `as` cast instead of the type's own runtime discriminator (`Tickets.tsx:562, 593`).**
`ownVersion = canEdit ? (ticket as OwnTicket).version : undefined` and `const own = ticket as OwnTicket;` inside `save()` both trust the `canEdit` boolean prop rather than a structural check. `OwnTicket` and `CommunityTicket` (`types/domain.ts:2291–2318`) already differ in a way TS can discriminate for free — `version` exists only on `OwnTicket`. A guard like `if (!('version' in ticket)) return;` (or narrowing on `'version' in ticket` before the cast) would make the invariant compiler-enforced instead of merely true-by-construction at today's one call site. Currently correct (verified: `canEdit={mineDetail !== null}` and `ticket = mineDetail ?? communityDetail`, so the cast is safe today), but it's exactly the kind of invariant that silently breaks under a future refactor of the caller.

**SF-2 — `refetchOwnTicket` (the 409-recovery fetch) is the one fetch in this file with no `AbortController` (`Tickets.tsx:835–845`).**
The module header explicitly claims "Every list/thread fetch takes its own `AbortController`, cancelled on unmount... mirrors every other page in this app," but `refetchOwnTicket` calls `listMyTickets()` with no signal. In practice this is low-risk (it's a one-shot, user-triggered recovery fetch, not a background poll, and React 18 silently no-ops a state update on an unmounted function component), but it's a real inconsistency with the file's own stated contract, and if `TicketDetail` unmounts mid-recovery (user hits Back while the conflict refetch is in flight) the in-flight request runs to completion for no purpose. Worth wiring an `AbortController` for consistency, even though nothing currently breaks.

**SF-3 — No test exercises "the community window resets on filter change" (spec requirement), even though the code (`onStatusFilterChange`/`onTypeFilterChange`, `Tickets.tsx:901–914`) calls `communityPage.reset()`.**
The existing windowing test (`Tickets.test.tsx:401–421`) only covers "shows N, Show More reveals N+step" — it never changes a filter mid-test to confirm the window collapses back to `initial` (15). The review brief specifically called out "verify the window math never over-claims + resets on filter change" as a thing to check; I traced the logic by hand and it is correct (`reset()` sets `count` back to `initial`), but there's no regression guard if a future edit drops the `.reset()` call from one of the two filter handlers.

### NIT

**N-1 — `mine` (My tickets) has no windowing at all**, unlike Community. This matches the module header's stated intent ("the feed can be long" refers specifically to Community) and is very unlikely to matter for a personal-beta ticketing surface, but if a heavy beta tester files 200+ tickets the "My tickets" tab renders them all unpaginated. Not a bug against spec — flagging only as a forward-looking scale note, not something to fix now.

**N-2 — When `GET /tickets/mine` fails to load (network error) while `GET /tickets/community` succeeds, a ticket the caller owns and is viewing from the Community tab silently renders view-only** (`canEdit` is `false` because the row isn't in the empty/errored `mine` array) with no indication that this is a *load failure* rather than "you don't own this." This fails safe (no false edit rights), so it's not a security issue, just a slightly confusing UX edge case that a retry on the My-tickets tab would silently fix.

## Detailed findings on the specific checks requested

- **File a ticket → POST /tickets:** form is fully labeled (`Type`/`Title`/`Description`), client-side validation mirrors server Zod bounds (`TITLE_MAX=200`, `BODY_MAX=5000`, `Tickets.tsx:130–131` vs `server/src/routes/tickets.ts:95–96`) as a courtesy cap only — correctly documented as non-authoritative. A failed submit preserves typed values and Retry resends the identical payload (`Tickets.test.tsx:137–169`, verified real: two distinct `createTicket` calls asserted). See BLOCKER B-1 for the one real gap.

- **Two views via `Tabs`:** `Tabs` primitive (sampled, unmodified in this diff) is a correct W3C APG tablist — roving tabindex, `aria-selected`, one `tabpanel` rendered, re-keyed per tab so state doesn't leak. `Tickets.tsx` fetches both lists unconditionally on mount so switching tabs is instant — verified this doesn't create a request storm since each loader has its own abortable single in-flight controller. Community windows via `usePagination(community, {initial:15, step:15, max:COMMUNITY_FETCH_LIMIT})`; since `COMMUNITY_FETCH_LIMIT` (100, the server's own list ceiling) is also the pagination `max`, the window can reveal every fetched row and never over-promises past what's actually in memory — `usePagination`'s own `remaining = min(step, limit - visibleCount)` (not the naive `total - visible.length`) is correctly wired straight to `<ShowMore remaining>` (`Tickets.tsx:1084–1089`). See SF-3 for the untested-but-verified-correct reset-on-filter-change path.

- **409 recovery:** this is the best-executed part of the diff. `refetchOwnTicket` deliberately calls `listMyTickets()` **unfiltered** and patches only the one matching row into `mine` via `.map()` (`Tickets.tsx:835–845`) rather than replacing the whole list — so an active status/type filter on the board can never hide the very row the recovery needs, and the recovery can never silently drop other rows the board was already showing. `TicketDetail.save()`'s 409 branch (`Tickets.tsx:619–639`) refetches, hands the fresh row back through `onTicketUpdated` (which flows down as a new `ticket` prop and resets the edit buffer via the `useEffect` at line 575), sets a friendly `role="status"` notice, and never blindly retries the write. Test (`Tickets.test.tsx:319–348`) genuinely exercises this: asserts the notice text, asserts the title input value became the *server's* fresh title (not merged with the user's draft), and asserts `listMyTickets` was called exactly twice (mount + recovery) — not a tautology.

- **Ticket detail (nested):** correctly derived from already-loaded lists rather than a nonexistent `GET /tickets/:id` (matches the server contract — there is no such route). `canEdit` is derived only from `mineDetail !== null`, never from `isMine` on a `CommunityTicket` row — verified this defeats the obvious IDOR-adjacent trap where a client-trusted flag could grant a fake edit UI. `BackButton` correctly round-trips `?tab=` so Back returns to the originating tab.

- **Comments (`GET`/`POST /:id/comments`):** thread reverses to newest-first for windowing purposes then re-reverses the visible slice back to chronological order for display (`Tickets.tsx:426–432`) — correctly matches the server's `ORDER BY created_at, id` (oldest-first) documented in `routes/tickets.ts:369`. Add-comment appends optimistically to local state on success (not a full refetch) — reasonable since the server response already carries the authoritative `id`/`created_at`/`is_mine`.

- **Anonymity contract:** verified end-to-end. `CommunityTicket`/`TicketComment` (`types/domain.ts:2307–2339`) structurally have no author field — there is nothing in the type for a future edit to accidentally render. Server queries (`routes/tickets.ts:184–196`, `365–370`) never `SELECT user_id` or join `users` in the anonymized paths. Test `Tickets.test.tsx:233–249` checks `document.body.textContent` doesn't match `/@/` and no `/^By /` text exists — a real (if blunt) regression guard.

- **Abort:** every fetch except `refetchOwnTicket` correctly takes its own `AbortController`, aborts the prior in-flight request before starting a new one, and aborts on unmount (`Tickets.tsx:791–892`, `395–420`). See SF-2 for the one exception.

- **Honest empty states:** correctly distinguishes "No tickets yet — file the first one" from "No tickets match these filters" via `hasActiveFilters` (`Tickets.tsx:1041–1043`, `1066–1068`), on both tabs.

## Coordination observations

- `App.tsx`/`Settings.tsx`/`Settings.css` changes are in-scope wiring (the `/tickets` route + a Settings entry point), not scope creep — the diff explicitly defers a more prominent global entry (FAB) to a named follow-up ticket (F-127), which is exactly the right way to bound scope without dropping the idea. This is good practice worth preserving through fix-pass.
- `usePagination`/`ShowMore`/`Tabs`/`FilterSelect`/`BackButton` are all consumed, not modified, by this diff — sampled each and found no coupling assumptions violated (e.g., Tickets never assumes `FilterSelect`'s `''` sentinel means anything other than "All", never fights `ShowMore`'s own focus-management contract).
- Fix-pass should preserve: the unfiltered single-row 409 recovery pattern (`refetchOwnTicket`), the `canEdit` derivation from `mine`-list membership rather than `isMine`, and the anonymity type-level guarantee (no author field exists to reach for). These are the parts most likely to look "over-engineered" to a fixer who hasn't read the threat-model comments and should not be simplified away.
