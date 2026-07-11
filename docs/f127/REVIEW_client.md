# F-127 Feedback FAB — Client Review

Reviewer: independent senior review (report-only, no code modified).
Scope: `client/src/components/{FeedbackFab.tsx,.css,Shell.tsx,Shell.test.tsx,Icon.tsx}`,
`client/src/lib/nav.ts`, `client/src/pages/{Tickets.tsx,.css,.test.tsx}`,
`client/src/services/tickets.ts`, `client/src/types/domain.ts`. Diff vs `rebuild`.

## Verdict

**PASS — no blockers.** The FAB is a real, keyboard-operable `<button>` with
a correct `aria-label`, visible focus via the shared `.focusring` primitive,
reduced-motion aware, and its hide-on-`/tickets` matching is segment-boundary
correct (verified both by trace and by the `/ticketsomething` negative test).
`pageNameForPath` is a pure function that cannot throw. The deep-link/compose
hand-off is correctly typed and defensively narrowed at the `Tickets.tsx`
boundary. F-023 (anonymity contract, `canEdit`-from-version, 409 recovery) is
untouched — confirmed by line-range diffing, not just claimed by comments.
Two SHOULD-FIX test-coverage gaps and a few NITs below; none block ship.

## Bar Checklist

| Item | Status |
|---|---|
| Real `<button>`, keyboard-operable | Pass |
| `aria-label` present and correct | Pass |
| Visible focus (`.focusring`) | Pass — shared, WCAG-1.4.11-validated token |
| Reduced-motion aware | Pass (`FeedbackFab.css` zeroes animation/transition) |
| No FAB/ChatFab/Topbar collision | Pass — verified by coordinate trace (below) |
| Renders on every page, hidden on `/tickets`(`/tickets/:id`) | Pass |
| Segment-boundary hide match (not naive `startsWith`) | Pass |
| `pageNameForPath` never throws, sensible fallback | Pass |
| Deep-link compose + sourcePage wiring | Pass |
| `sourcePage` display escaped / null-safe | Pass (React children; explicit `? :` guards) |
| F-023 preserved (anonymity, canEdit, 409) | Pass — untouched by diff |
| Strict TS at I/O boundary (router state, wire types) | Pass |
| No console.log / no TODO-without-ticket | Pass |
| Tests exercise real behavior, not tautologies | Mostly pass — 2 gaps noted |

## Findings by Severity

### BLOCKER
None.

### SHOULD-FIX

1. **`pageNameForPath`'s prefix/segment-boundary branch has zero test
   coverage.** `client/src/lib/nav.ts:409-426` documents three match
   tiers (exact → longest-prefix segment-boundary → raw-path fallback), but
   every test that exercises this function — across `Shell.test.tsx`,
   `Tickets.test.tsx`, and `nav.test.ts` itself (untouched by this diff) —
   uses either an exact manifest path (`/progress`, `/learn/topik`,
   `/learn/writing`, etc.) or a fully-unmapped path that falls straight to
   tier 3 (`/some/unmapped-route`). No test drives a nested path like
   `/uploads/42` or `/review/vocab/123` through tier 2 to confirm it
   resolves to "Uploads"/"Vocabulary" rather than falling through to the
   raw-path fallback. I traced the logic by hand and it is correct (the
   `p !== '/'` guard correctly excludes the root item from ever winning a
   "longest prefix" comparison it isn't a real candidate for), but the
   JSDoc's own example (`/uploads/42`) is not backed by an assertion
   anywhere in the diff.

2. **No dedicated `FeedbackFab.test.tsx` / CSS-contract pin, unlike its
   sibling `ChatFab`.** `ChatFab.test.tsx` exists as an isolated
   component test AND includes a "stylesheet contract" test
   (`client/src/components/ChatFab.test.tsx:210-232`) that reads
   `styles/index.css` from disk and regex-asserts the `.km-chatfab` rule's
   `position: fixed` and bottom-clamp formula, specifically because
   happy-dom does no layout and can't drive the real overlap scenario.
   `FeedbackFab` gets no equivalent: its only coverage is the new
   `describe` block inside `Shell.test.tsx`, and nothing pins
   `FeedbackFab.css`'s `top`/`right` values or `position: fixed`. Given the
   module header's explicit claim ("sits at the OPPOSITE corner from
   ChatFab's ~1/5-down right-edge dot so the two never collide"), a future
   edit to either stylesheet could silently reintroduce an overlap with no
   test catching it. I independently verified the current numbers are safe
   (see Coordination Observations below) — this is a regression-guard gap,
   not a live bug.

### NIT

1. **Tickets.tsx:867-876 comment overstates itself.** The comment reads
   "Narrowed defensively … rather than trusted with a bare `as` cast" but
   the very next line does `location.state as TicketsLocationState | null |
   undefined` — that IS a bare `as` cast. The actual protection is the
   `typeof` field checks that follow, which are real and correct (a
   malformed `sourcePage.path`/`.name` falls back to `undefined` cleanly).
   The comment's wording just misdescribes its own code; worth a rewording
   for a future reader who'll take "not trusted with a cast" at face value
   and go looking for a parser that isn't there.

2. **`.km-tickets__file-source` and `.km-tickets__detail-source`
   (`Tickets.css:141-153`) are byte-identical rules.** The comment
   preemptively justifies the duplication ("a dedicated class in case the
   two ever need to diverge") — reasonable, but as written today it's dead
   duplication that a linter/`stylelint` dedup pass would flag. Low cost
   either way.

3. **`FeedbackFab.tsx`'s inline arrow-function `onClick`** allocates a new
   closure every render (no `useCallback`), same as ChatFab's own `onClick`
   — consistent with house convention, not a regression, just noting it's
   not memoized (irrelevant for a component this cheap to re-render).

### PRAISE

- **Coordination discipline.** Both `FeedbackFab.tsx` and its CSS carry
  explicit, falsifiable claims about z-index tier, corner placement, and
  the ChatFab convention it mirrors (`isHiddenPath` shape, case-insensitive
  lowercasing rationale, focusring) — the kind of comment that lets a
  reviewer actually check the claim instead of taking it on faith.
- **`sourcePage` persistence design is correct and future-proof.** Only the
  `path` rides into the DB; the `name` is re-derived at render time via
  `pageNameForPath` from the stored path (`Tickets.tsx` header comment +
  `TicketRow`/`TicketDetail` call sites). This means a future rename in
  `nav.ts`'s manifest automatically relabels old tickets instead of leaving
  them frozen with a stale label — a real design decision, not an
  accident.
- **Wire-boundary hygiene.** `services/tickets.ts`'s `createTicket` and the
  server's Zod schema both independently omit the key entirely when
  `sourcePage` is absent (never sending `''` or a bare `undefined`), so the
  DB genuinely gets `NULL` rather than an empty string masquerading as
  "no context." Client (`CreateTicketBody.sourcePage?: string`), service
  layer, and server schema (`source_page: z.string().trim().min(1).max(200)
  .optional()`) all agree on this contract, and the DB CHECK constraint
  (migration 058, 1..200 chars) matches the Zod bound exactly — no daylight
  between the three layers.
- **Test that verifies the omitted key, not just a falsy value.**
  `Tickets.test.tsx`'s "omits source_page entirely" test asserts
  `toHaveBeenCalledWith({ type, title, body })` with no `sourcePage` key at
  all, which is the correct way to test "genuinely absent" rather than
  "present but empty/undefined" — a subtlety a lot of test suites get
  wrong.

## Detailed Findings Citing file:line

- `client/src/components/FeedbackFab.tsx:37-45` (`isHiddenPath`) — correct
  segment-boundary match (`path === p || path.startsWith(`${p}/`)`), same
  shape as `ChatFab.tsx:36-45`. Verified against the Shell test's
  `/ticketsomething` (visible) vs `/tickets`, `/tickets/5`, `/Tickets`
  (hidden) matrix — matches.
- `client/src/lib/nav.ts:409-426` (`pageNameForPath`) — pure, cannot throw;
  correctly special-cases `'/'` out of the prefix-match loop so root never
  wins a spurious "longest prefix" contest. See SHOULD-FIX #1 for the
  missing branch-2 test.
- `client/src/components/Icon.tsx:77-80` — new `alert` glyph is a bare "!"
  (two paths, not the `info` circle-i), rendered `aria-hidden` by default
  since `FeedbackFab.tsx:72` passes no `title` — correct, avoids the icon
  being separately announced alongside the button's own `aria-label`.
- `client/src/pages/Tickets.tsx:847-877` — `TicketsLocationState` narrowing:
  cast the raw `location.state`, then validate `sourcePage.path`/`.name`
  are both `string` before trusting them; `compose` checked with `=== true`
  (not merely truthy). Malformed/absent state degrades to the exact same
  render as a plain direct navigation. Type-safe at the boundary.
- `client/src/pages/Tickets.tsx:229-232`, `:733-737` — both display sites
  guard on `ticket.sourcePage` truthiness before calling
  `pageNameForPath(ticket.sourcePage)` (TS narrows to `string`, not `string
  | null`), and render through JSX children (`{...}`), so React
  auto-escapes — no injection surface even though the value is
  client-originated.
- `client/src/services/tickets.ts:157-181` (`createTicket`) — explicitly
  reconstructs the wire body (`type`/`title`/`body` + conditional
  `source_page`) rather than spreading the whole `CreateTicketBody`,
  so a future field added to the client type doesn't silently leak onto
  the wire un-translated.
- `client/src/types/domain.ts:2284-2291`, `:2308-2312`, `:2328-2331` —
  `sourcePage` is `string | null` (mandatory) on `OwnTicket`/`CommunityTicket`
  and optional (`sourcePage?: string`) on `CreateTicketBody` — correctly
  asymmetric (every ticket the server returns has a resolved value or
  explicit null; not every ticket-creation call has page context).

## Coordination Observations (FAB vs ChatFab vs Topbar)

Traced the actual geometry rather than trusting the comments:

- **ChatFab vs FeedbackFab:** `FeedbackFab.css` pins `top: max(14px, …)`
  (viewport-fixed, 38×38, top-right). `styles/index.css`'s `.km-chatfab`
  rule sits at `bottom: max(22%, calc(--shell-bottomnav-h + 12px + safe-area))`
  — i.e. anchored from the bottom, "~1/5 up the right edge" per its own
  comment. These are opposite anchors (`top` vs `bottom`) on the same
  `right` offset formula, so they cannot occupy the same vertical band on
  any viewport height where 22% of height plus the nav clamp doesn't
  exceed the ~52px FeedbackFab already occupies from the top — true for
  any realistic phone/desktop viewport. Confirmed no overlap.
- **FeedbackFab vs Topbar:** `Shell.tsx` renders a 54px
  `--shell-statusbar-h` spacer (`styles/index.css:756-759`) ABOVE the
  scrollable area that contains the per-page `Topbar`, which is
  `position: sticky; top: 0` *relative to that scroll container*
  (`styles/index.css:2279-2285`) with `padding: 18px 20px 12px` before any
  title/right-slot content starts. `FeedbackFab` occupies viewport
  `top: 14px` to `top: 52px` (38px tall). Topbar's own content therefore
  starts no earlier than viewport `y ≈ 54px` (statusbar spacer) + 18px
  padding, i.e. `y ≈ 72px` — after the FAB's band ends. Clearance is only
  ~2px in the zero-safe-area case, which is tight but never actually
  overlapping given the current constants; on notched devices both the
  statusbar spacer and the FAB's `env(safe-area-inset-top)` term grow
  together, preserving the gap. Per-page `Topbar` `right` slots
  (`Grammar.tsx:744-754`, `Chat.tsx:1715+`, `Topik.tsx`) are normal
  in-flow flex children (`align-items: flex-end` inside the row), not
  fixed-positioned, so they render even lower than the Topbar's own top
  edge — no horizontal+vertical collision in practice, confirmed by
  inspecting the row layout, not simulated (happy-dom can't lay this out,
  same limitation ChatFab's own stylesheet-contract test works around —
  see SHOULD-FIX #2 for the resulting coverage gap).
- **BackButton** (`BackButton.css`) is inline-flex, in normal document
  flow (top-left in practice, not fixed), so it cannot collide with either
  FAB.

## F-023 Regression Check

Diffed `Tickets.tsx` line-by-line against `rebuild`: every line touching
`canEdit`, the 409-conflict recovery path (`err.status === 409`,
`refetchOwnTicket`), the anonymized community `SELECT`
(server-side, `routes/tickets.ts`), and the `isMine`-only identity signal
is **outside** the diff's changed hunks. The only new server-side
`SELECT`/`RETURNING` additions are `source_page`/`t.source_page`, appended
alongside the existing anonymized column list with an explicit comment
confirming it's non-identity-bearing. No regression found.
