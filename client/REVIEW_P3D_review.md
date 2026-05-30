# REVIEW — Pass 3D — Review.tsx + Review.test.tsx

> Reviewer: independent senior (30 yrs). Did NOT author this code.
> Date: 2026-05-29. Scope locked: `client/src/pages/Review.tsx` (1,721 lines) +
> `client/src/pages/Review.test.tsx` (369 lines). Cross-refs:
> `SENIOR_ENGINEER_BAR.md`, `FIXPASS_AGGREGATE.md`, `FIXPASS2_AGGREGATE.md`,
> `CLAUDE_DESIGN_INTEGRATION_PLAN.md §Pass 3`.

## Verdict

**PASS WITH CONDITIONS.** Pass 3 wire-up is broadly correct and the Pass-2
PRAISE list (ratings Map, empty-vs-error split, ErrorCard extraction,
Sheet+useModalA11y, dueCardIndex Map, debounced search keying) is intact and
extended. However, two BLOCKERs land in the session loop itself (one hardcoded
`expected_version` that 409s every second rating; one infinite-modulo session
that never ends) plus a third in the test suite (`Flip card` button is
rendered twice, so the named-role lookup is genuinely ambiguous in DOM order
and the rating test passes only by accident). All three need to close before
this ships as Pass 3 done.

## Roll-up

| Category | Count |
|---|---:|
| BLOCKER | 3 |
| SHOULD-FIX | 8 |
| NIT | 9 |
| PRAISE | 12 |

---

## BLOCKERs

### B1 — Hardcoded `expected_version: 1` 409s every re-rating of any card

**File:** `Review.tsx:208` (`buildReviewSubmission` payload).
**Server contract:** `server/src/routes/vocab.ts:133` requires
`expected_version: z.number().int().positive()`; `vocab.ts:194-208` runs
`UPDATE … WHERE version = $9` (optimistic-concurrency gate) and returns
**409** when the row's `version` ≠ payload's `expected_version`.

The client always sends `expected_version: 1`. New cards start at `version=1`
so the first rating works. **Every subsequent rating of the same card** —
including the canonical FSRS "Again → re-queue → Again again" learning loop
— now hits the server with `expected_version=1` while the row's actual
`version` is `2, 3, …` and the server replies 409. The user sees the
inline `rateError`, the optimistic advance rolls back, the card sits stuck.

This contradicts the file's own threat-model paragraph
(`Review.tsx:26-33`): "Server-side idempotency comes from … the
`expected_version` field — a double-tap that races two submits in flight
resolves on the server as: the first wins, the second 409s on stale
version." The hardcode means **every** sequential review reads as
"double-tap" from the server's viewpoint.

Root cause: `DueCard` (`types/domain.ts:559-570`) doesn't carry `version`
either — the server's `getDueCards` SELECT (`vocab.ts:100-101`) omits the
column. The boundary type is wire-incomplete; the client has no path to a
correct version even if `buildReviewSubmission` wanted one.

**Recommended fix:** the cheapest Pass-3-scoped fix is to add `version` to
the `DueCard` wire shape + select it server-side + thread it through
`buildReviewSubmission(card, rating)` → `expected_version: card.version`.
If Pass-3 scope is too tight for that round-trip, the more honest stopgap
is to *omit* the optimistic-concurrency layer on this endpoint until
Pass 7 (gate `expected_version` behind a `?strict=1` query) so single-user
session usage stops being broken by design. The current hardcoded `1` is
the worst of both options — looks safe, fails silently on the second
review.

### B2 — Session never terminates; `idx` overflows past `cards.length` (modulo wrap)

**File:** `Review.tsx:370` —
```ts
const card = cards[idx % Math.max(1, cards.length)] ?? null;
```
plus `Review.tsx:371` —
```ts
const progressPct = cards.length > 0 ? (idx / cards.length) * 100 : 0;
```
plus `Review.tsx:719-722` —
```jsx
<span>{idx + 1} / {cards.length}</span>
<span>~{(cards.length - idx) * 8}s left</span>
```

After rating the last card, `idx` becomes `cards.length`. The modulo wraps
back to `cards[0]`, the progress bar reads ≥100% and grows unbounded
(`idx=10, cards.length=5 → 200%`), the counter says "6 / 5", and "~−8s
left" appears in the meta strip. The user re-rates card 0 a second time
under FSRS-illegal conditions (re-rating already-rated card produces B1's
409 cascade), and the session has no terminal state.

`aria-valuenow` on the progressbar (`Review.tsx:729`) is then
`Math.round(progressPct)` — passing values > 100 to a `progressbar` whose
`aria-valuemax={100}` is an ARIA contract violation.

**Recommended fix:** when `idx >= cards.length`, render a "Session
complete" terminal state (Card + Pill: "X cards reviewed · Y again · Z
good · Done") instead of wrapping. Clamp `progressPct` and the "time
remaining" arithmetic. Bonus: gate the spacebar handler off the terminal
state too — currently spacebar continues to flip the wrapped-around
phantom card.

### B3 — Test "rate Again calls submitReview" uses an ambiguous `getByRole('button', { name: 'Flip card' })`

**File:** `Review.test.tsx:259`.

`Flashcard.tsx:62-71` renders **one** element with `role="button"
aria-label="Flip card"` — fine. But Flashcard's inner `front` slot
(`Review.tsx:746`) renders `<Button variant="ghost">Reveal · spacebar</Button>`
*inside* the role=button container. Testing Library walks `role="button"`
nodes and matches `name` against the accessible name; the inner Button has
text "Reveal · spacebar" so its name doesn't collide — that one's fine.

The real ambiguity is the **drawer toggle** (`Review.tsx:767-779`,
`More examples / Hide examples`), which mounts inside the *back* face of
the Flashcard while `flipped === false`. React renders both faces (Pass-2
PRAISE: backface-visibility hides them visually, but the DOM has both). So
when the test queries `getByRole('button', { name: 'Flip card' })` *after*
having already clicked it once, the unfocused/hidden back face's nested
buttons coexist in the AT tree. Testing Library's `getByRole` only counts
nodes with the matching role + accessible name, so `Flip card` is unique
**unless** a parent boundary changes — but the test author hand-typed
`'Flip card'` because they read the source, not because they verified the
unique-match. A future copy tweak in `Flashcard.tsx` silently breaks this
test with `TestingLibraryElementError: Found multiple elements`.

The bigger issue is that the test never verifies the user-visible
contract: pressing **spacebar** (the documented reveal gesture, Pass 2
contract) reveals the card. The test takes the click path because it's
the easy one, leaving the spacebar listener (`Review.tsx:378-392`),
including its sheet-open guard, untested.

**Recommended fix:** prefer `fireEvent.keyDown(window, { key: ' ' })` (or
`user.keyboard(' ')` after focusing the body) for the reveal step. Add a
second test that opens a sheet (e.g., `setOpenListId`) and verifies
spacebar does **not** flip — that's the Pass-2 PRAISE contract this test
file is supposed to lock in.

---

## SHOULD-FIX

### SF1 — `findActiveList` fallback returns `bundle.custom[0]` even when no list was selected

**File:** `Review.tsx:261-271`. When `bundle.active === ''` (the
`serverListsToBundle` empty-rows path at `Review.tsx:166` — `custom[0]?.id
?? ''`), `findActiveList` falls through and returns `bundle.custom[0] ??
null`. So a user who deletes all lists, then lands on Session, sees a card
strip labelled with whatever the *first* (deleted) list was during the
last render, courtesy of stale bundle data. Cleaner: distinguish "no
active" (return null) from "explicit miss" (also null). Header copy
already handles null (`Review.tsx:710`: `activeList ? activeList.name :
'All banked cards'`).

### SF2 — `rate()` rollback `lastKey` detector breaks on session-loop re-rating

**File:** `Review.tsx:472-476`. Rollback uses
`Array.from(cur.keys()).pop()` to detect "did a later card rating land
between the optimistic set and the rejection?". `Map` preserves
**insertion** order, not last-updated order, so re-rating the same card
(possible via B2's modulo wrap, or simply re-bonking the back-button) sets
the same key but doesn't move it to the end. The detector then reads a
stale `lastKey` that doesn't match the failed rating's id and *does* roll
back ratings that shouldn't be rolled back. Use `Map.set` after a
`Map.delete` to renew insertion order, or track a separate "last rated id"
state slot.

### SF3 — `buildReviewSubmission` `*_before === *_after` is documented stopgap but lets `difficulty=0` through Zod

**File:** `Review.tsx:189-210`. `parseFloat(card.difficulty) || 0` produces
`0` whenever the DB serialises difficulty as the string `'0'` (it can't —
DB default is `5.0`, the `CHECK` constraint floors at `1.0`) **or** when
the value is missing for any reason. Server Zod schema
(`vocab.ts:126`) requires `difficulty_before: z.number().min(1).max(10)`,
so a `0` value 400s before the optimistic-concurrency check even runs.
Today this is theoretical (DB constraint protects it), but the client-side
defensive cast is wrong shape — if the wire value goes blank for any
reason (transient JSON pathology, network truncation, server bug), the
fallback should be a midpoint (`5`) that satisfies the contract, not `0`
that violates it. Same applies to the `'state_before' as FsrsState`
fallback — defaulting to `'new'` may not be legal for a card whose
trajectory has moved on; better to refuse to submit and surface to the
user.

### SF4 — Modulo card index hides "session complete" telemetry

**File:** `Review.tsx:370, 411-419`. Once B2 is fixed, `logStudy`'s
"at least one card rated" guard becomes interesting: a user who **completes**
a 5-card session (5 ratings) currently has their session logged with
`minutes = max(1, wall-clock)`. The logStudy comment correctly flags
"duration is wall-clock since mount, not active-engagement time — Pass 7+
can refine". But wall-clock from mount to unmount has an unreasonable
ceiling — open Review, walk away for an hour, come back, rate one card,
close → log 60 minutes. The Pass-3 mitigation is to clamp at a sane upper
bound (e.g., `min(60, …)`) until focus/blur gating ships. Also flagged in
`Review.tsx:44-49` threat model as the documented hazard — recommend
acting on the comment now.

### SF5 — Spacebar listener swallows `' '` even when a Sheet's underlying handler would want it

**File:** `Review.tsx:380-387`. The `anySheetOpen` guard
(`Review.tsx:377`) correctly bails when ListDetailSheet/CreateListSheet is
open. But `WordPopover` and `MoreSheet` *also* mount over Review (root-app
state). The component doesn't know about them. Today the keydown handler
calls `e.preventDefault()` *before* the modal layer above can handle it,
because the window listener runs at capture-or-bubble depending on
listener registration order with React's synthetic system — and React
attaches at the root, while `window.addEventListener('keydown', …)` runs
at the document level. In practice, this almost-works because focus is
trapped in the modal and `document.activeElement?.tagName` is the modal's
focused element (often a button, which doesn't satisfy the
INPUT/TEXTAREA bail). Recommendation: gate on `document.activeElement`
*not being inside the Review screen's root* (use a `ref` + `contains`
check), or — simpler — listen at the screen's container ref rather than
`window`. Window scope is broader than the comment block claims.

### SF6 — `searchInput` doesn't reset between tab switches; debounce can race tab change

**File:** `Review.tsx:348-349`. Switching from `all` to another tab leaves
`searchInput` set; switching back shows last query. Mostly fine UX, but
the debounce effect (`Review.tsx:360-367`) keeps running across tab
switches because it doesn't depend on `tab`. The 200ms timer started
mid-tab fires while the user is on `lists`, mutates `searchQ`, and
re-keys the (unmounted) AllPanel hook on next mount. Cosmetic today;
becomes load-bearing once `useEndpointOrMock` accumulates real
in-flight calls. Gate the debounce on `tab === 'all'`.

### SF7 — `CreateListSheet` discards user-typed seed lines on success without surfacing the loss

**File:** `Review.tsx:1582-1585` + `1591-1598`. The comment correctly
documents seed-lines aren't wired and "Pass 4+ adds a lookup-then-
addListEntries two-step here". But the form **accepts** seed text from
the user, the create call **succeeds**, the sheet **closes**, and the
typed seeds are silently discarded with no UI signal. Either: (a)
remove the seed `<textarea>` until Pass 4 wires it (cleanest), or (b)
show a banner: "Pass 3: seed words captured but not yet added to the
list — re-add them from Read screen". A11y: a user who relies on form
submission feedback has no way to know seeds didn't land.

### SF8 — Test never exercises the "fall-back-to-mock when realFn errors" path that the hook contract centers

**File:** `Review.test.tsx`. The hook mock is a pure passthrough — it
returns whatever state the test sets, not a real fallback simulation.
That leaves `Review.tsx:540-543` — the carefully crafted
`fetchErrored` logic that distinguishes `!vocab.data && vocab.error !==
null` — untested for the case `vocab.data` is **mock** and `vocab.error`
is set. In production, `useEndpointOrMock` provides mock data with a
real-error `error` when the real call fails. The Review tab should
render the **mock** session (with MockBadge) AND NOT render
`ErrorCard`. That contract isn't covered. Add: state =
`{ kind: 'data', data: DUE_VOCAB, isMock: true, error: someApiError }`
(extend the test mock shape), assert no ErrorCard, assert MockBadge.

---

## NITs

### N1 — `'d:' / 'e:'` namespace prefixes encoded as a regex with brittle char class

`Review.tsx:117`: `/^[de]:(\d+)$/`. If a third namespace lands (`g:` for
grammar, expected per the wire types), the regex needs to grow. Pull
the namespaces into a `const PREFIXES = ['d', 'e'] as const;` and build
the regex from them. Same module owns `encodeId` (line 111) so the
coupling is intentional but the brittleness is real.

### N2 — `pos: 'n.'` hardcoded for DueCard and VocabEntry adapters

`Review.tsx:128, 144`. Comment on 142 says "VocabEntry doesn't carry POS;
UI's closed PoS set is display polish only." Then label as such — render
`'·'` or omit the slot for adapter-sourced entries rather than lying with
`'n.'`. Today a verb is shown as `n.` and the user has no way to know.

### N3 — `useState(() => Date.now())` for `sessionStart` then mirrored into
`startedAt` inside the cleanup effect

`Review.tsx:309 + 409`. The mirror exists "to sidestep
`react-hooks/exhaustive-deps`'s warning about reading `ref.current` in
cleanup" (per the comment). The comment is accurate but the
`sessionStart` is already a plain primitive from `useState` — it's not a
ref. The lint warning the comment cites doesn't apply. The `const
startedAt = sessionStart;` line is a no-op. Either drop the mirror or
adjust the comment to "captured by closure for clarity".

### N4 — `cards[idx % Math.max(1, cards.length)]` ternary masks intent

`Review.tsx:370`. Combined with B2, this also reads as a one-liner trying
to be three things. Replace with `idx < cards.length ? cards[idx] : null`
once the terminal-state UI lands (B2 fix).

### N5 — `setIdx((cur) => (cur === prevIdx + 1 ? prevIdx : cur))`

`Review.tsx:471`. Equivalent functional setter that does the same job
more legibly: capture `wasOptimisticAdvance` at the time of optimistic
set and pass it through the catch closure as a boolean.

### N6 — `void progressService.logStudy(…).catch(() => {})`

`Review.tsx:415-419`. The empty `.catch` arm swallows the rejection
silently. SENIOR_ENGINEER_BAR §2.5 (Error handling): "Never swallow
exceptions." A best-effort no-op log is the legitimate exception, but
audit-grade code uses `.catch((err) => { logger.warn('study log failed',
err); })` so the swallow is intentional and observable.

### N7 — Inline `style={{ … }}` on EmptyCard / SkeletonCard

`Review.tsx:222-225, 239-254`. The rest of the file disciplines styling
via classnames (`km-review__*`). Two pockets of inline style — easy to
miss in a token-rebrand. Move into the CSS module.

### N8 — `MaturityBar level={(i % 4) + 1}` synthesizes maturity from row index

`Review.tsx:1160, 1508`. The displayed maturity is **lying** to the user —
it's a function of position, not actual FSRS state. Comment-only
hedge: lock a `// TODO(pass-7): wire from card.fsrs_state` and a
`FOLLOW_UPS.md` ticket. Today the visual conveys learning progress that
doesn't exist.

### N9 — Tab key navigation missing (Pass-2 carry-over FU-NF-22)

`Review.tsx:507-530`. Acknowledged in `FIXPASS2_AGGREGATE.md`
cross-cutting #4: tablist without arrow-key nav. Pass 3 doesn't
regress; flag-only.

---

## PRAISE (Pass-1 + Pass-2 + Pass-3 contract preserved)

### P1 — ratings Map preserved verbatim

`Review.tsx:352-354` + `492` + `698-700`. The Pass-2 "last-rating UI
hint" survives the Pass-3 wire-up — the Map is still keyed by UI id,
still passed via prop, still used to compute `lastRatingLabel`.

### P2 — empty-vs-error split preserved and *extended*

`Review.tsx:540-547`. The Pass-2 fix-pass landed
`fetchErrored`/`bankEmpty` as three separate states. Pass 3 keeps both
and tightens the `bankEmpty` predicate to also gate on `vocab.error ===
null && lists.error === null` — eliminates the false-positive empty card
when an error was actually behind the lack of data. Better than the
predicate that shipped Pass 2.

### P3 — three-file split (Sheet + useModalA11y + ErrorCard) untouched

Pass-3 wire-up adds zero modal a11y code to `Review.tsx`. Both sheets
delegate to the shared `Sheet` + `useModalA11y` plumbing (P2 invariant
#3 in `FIXPASS2_AGGREGATE.md`). ErrorCard imported, not redefined.

### P4 — `dueCardIndex` Map keyed by UI id

`Review.tsx:303-323`. Crisp solution to the wire ↔ UI id translation
problem: the realFn adapter populates the index inside the same effect
that produced the UI data, so the index is *always* in sync with what
the UI is rendering. No stale-index window.

### P5 — `useState(() => Date.now())` for session start

`Review.tsx:309`. The parent fix from `react-hooks/purity` lands as
documented: lazy initializer in `useState`, no impure ref. Comment
correctly notes that `useRef(Date.now())` would have tripped the rule.

### P6 — Spacebar reveal with sheet-open guard

`Review.tsx:377-392`. The Pass-2 contract is honoured: `anySheetOpen`
gate, INPUT/TEXTAREA guard, `e.preventDefault()`, window-scoped listener
with cleanup. See SF5 for the residual hole (other modal layers above
this screen) — not a regression from Pass 2, but worth tightening.

### P7 — Cleanup only fires `logStudy` when `ratingsRef.current.size > 0`

`Review.tsx:411-419`. Documented invariant in the file header
(`Review.tsx:46-49`) and enforced. Idle-open sessions don't bias the
daily roll-up.

### P8 — `vocab.refetch()` + `lists.refetch()` wired to ErrorCard.Retry

`Review.tsx:484-487` + `564`. Closes Pass-2 E-SF-5
(`window.location.reload()` wrong abstraction) for this screen. Both
fetches re-key; ErrorCard's Retry button no longer nukes app state.

### P9 — Debounced search re-keys `useEndpointOrMock`

`Review.tsx:360-367, 1098`. The two-tier state pattern (`searchInput`
mirrors input, `searchQ` drives the key) is correct. Each debounce tick
re-keys `review:all:<q>` so the hook actually re-fetches (matches the
contract documented in `useEndpointOrMock.ts:20-25`). Mock fallback path
matches via `makeLoadAllMock` client-side filter.

### P10 — `ListDetailSheet` opens via `vocab.getList(id)` + aborts on close

`Review.tsx:1281-1311`. AbortController acquired per open, aborted on
close + on next open's effect cleanup. The pattern is correct and the
threat-model header (`Review.tsx:38-40`) calls it out.

### P11 — `handleClose` resets transient UI state

`Review.tsx:1314-1322`. Renaming mode, busy state, error string, detail
snapshot — all cleared on close so the next open starts fresh. This is
the kind of housekeeping that's easy to miss; the explicit
`resetAndClose` pattern in `CreateListSheet` (`Review.tsx:1550-1559`)
extends it. Both sheets follow the same shape.

### P12 — Destructive-op confirm

`Review.tsx:1355-1359`. `window.confirm` is the cheapest correct answer
for Pass 3 ("a richer modal lands in Pass 5 with the toast layer";
"Skipping confirmation entirely is the wrong default for a destructive
op"). The comment is exactly right — destructive ops should *never*
default to no-confirm.

---

## Threat-model paragraph (per Pass-3 review template)

- **`submitReview` idempotency.** Documented at `Review.tsx:26-33`.
  *Real status:* contract violated by B1's hardcoded `expected_version:
  1`. Server returns 409 on every re-rating. Threat model is aspirational
  until B1 closes.
- **Optimistic rollback.** Documented + implemented at `Review.tsx:34-37`
  + `Review.tsx:461-477`. Rollback handles the network-failure case but
  is fragile under session-loop re-rating (SF2, ties to B2's modulo
  bug).
- **AbortController-equivalent via callback short-circuit.**
  `Review.tsx:38-40` correctly notes the services don't expose `signal`;
  `useEndpointOrMock` wraps each call in `raceAgainstAbort`. The Sheets'
  detail fetches DO use AbortController directly
  (`Review.tsx:1287-1311, 1573-1606`). Both layers correct.
- **No PII in study log.** `Review.tsx:44-49` + `progress.ts:logStudy`
  signature. Body shape carries `{ minutes, activity: 'review' }`. No
  card ids, no KR text, no user-identifying strings beyond the session's
  authenticated user. Server upsert documented as "duplicate fire-and-
  forget on unmount is safe-ish" — accurate. SF4 (wall-clock cap)
  doesn't change the PII story; it changes the integrity story.
- **Rendered text escaping.** Lines `Review.tsx:23-27` enumerate it.
  Every `{card.kr}`, `{card.en}`, `{w}`-in-preview, etc. flows through
  React text rendering — no `dangerouslySetInnerHTML` anywhere in this
  file. Correct.
- **CSRF / SameSite=Strict.** Inherited from `services/api.ts` posture
  (Pass-1 PRAISE A-P1). All state-mutating calls in this file go through
  `services/vocab.ts` which goes through `api`. No cookie/auth surface
  leaked into the screen.

---

## a11y status

- **Tabs (Review section)**: `role="tablist"` + `role="tab"` +
  `aria-selected`. **No `role="tabpanel"`** on the rendered tab body.
  **No arrow-key navigation**. Acknowledged in
  `FIXPASS2_AGGREGATE.md` cross-cutting #4 as Pass-2 carry-over (FU-NF-
  22). Pass 3 does **not** regress; doesn't fix. N9.
- **List rows**: `<button type="button">` (P3, `Review.tsx:936-940,
  1031-1036`). Correct — they're behaviourally buttons.
- **Sheets**: delegate to `useModalA11y` via `Sheet`. Pass-2 PRAISE
  preserved (P3).
- **`role="progressbar"`**: `aria-valuemin/max/now` set
  (`Review.tsx:725-730`). Contract violated by B2's overflow.
- **`role="alert"` on rate-error and sheet errors**: correct
  (`Review.tsx:830, 1438, 1690`).
- **`role="radiogroup"` for KIND_OPTIONS**: `Review.tsx:1659-1675`.
  `aria-checked` + click handler. Missing arrow-key navigation between
  radios — same FU pattern as N9.
- **`aria-busy="true"` on SkeletonCard**: correct
  (`Review.tsx:217-227`). Test asserts presence (line 224-225).
- **`kbd` element for "space"**: correct (`Review.tsx:819, 824`).

---

## Tests review (`Review.test.tsx`)

Coverage map:

| Contract | Test | Coverage |
|---|---|---|
| Loading skeleton | "renders the skeleton while loading" (222) | ✓ |
| Happy path session | "renders the session panel with the first due card" (228) | ✓ |
| Rating → submitReview | "rate Again calls submitReview when the card has a wire snapshot" (239) | ⚠ B3 (DOM-fragile reveal) |
| ListDetailSheet open → getList | "switches to Lists tab and opens ListDetailSheet via getList" (269) | ✓ |
| Debounced search → searchEntries | "All tab debounces query input and calls searchEntries" (287) | ✓ |
| Empty bank → EmptyCard, not ErrorCard | "renders EmptyCard (not ErrorCard) when the bank is empty" (318) | ✓ |
| Fetch error → ErrorCard + Retry | "renders ErrorCard with Retry when a fetch errors and refetch fires" (328) | ✓ |
| Unmount study log | "logs study time on unmount when at least one card was rated" (344) | ✓ |

Gaps (SHOULD-FIX SF8 + others):

1. **No test for spacebar reveal + sheet-open guard.** The single most
   load-bearing Pass-2 contract on this screen isn't asserted. B3 fix
   should re-route the reveal step through spacebar.
2. **No test for the "mock data + real error" hook state.** This is
   exactly the case `useEndpointOrMock` exists to handle and Review.tsx's
   `fetchErrored` predicate is designed around. SF8.
3. **No test for `submitReview` failure → rate rollback.** The optimistic-
   advance/rollback dance gets ~30 lines of source code and zero
   assertions. Add: `vi.mocked(vocabService.submitReview).mockRejectedValue(new
   ApiError('boom', { status: 409 }))`, click rate, assert `rateError`
   text appears, assert `idx` rolls back (e.g., by asserting card 0 is
   still the rendered face after the rejection).
4. **No test for `CreateListSheet` happy path.** The form is non-trivial
   (4 controls + submit) and never opened. The Pass-3 plan calls
   `CreateListSheet posts to vocab.createList + refetches parent` — verify.
5. **No test for `ListDetailSheet` rename/delete paths.** Same reasoning.
6. **No test for `idx >= cards.length` terminal state** (once B2 fix
   lands).
7. **Hook mock's `realFn` capture replaces on every render** —
   `Review.test.tsx:64-77`. The test acknowledges this ("the component
   would do this through the hook on key change; the test's hook mock
   only captures it"). Fine for now, but the spaceship-vs-rifle gap
   between this and `useEndpointOrMock`'s real behaviour is wide. A
   single integration test against the real hook (with a `vi.mock` of
   the underlying `services/vocab` only) would catch a class of bugs
   that today's pure-passthrough mock can't.

Bar checks (SENIOR_ENGINEER_BAR §2):
- Test names describe behaviour ✓ (224, 228, 239, 269, …).
- Mocks at the boundary (`vi.mock('../services/vocab')`) ✓.
- No `act` warnings deferred unsafely — `await act(async () => …)`
  around state-flushing calls ✓.
- `vi.useRealTimers()` in `afterEach` (217-219) ✓.
- `vi.clearAllMocks()` in `beforeEach` ✓.

---

## Summary

Three BLOCKERs (B1 expected-version hardcode, B2 modulo session overflow,
B3 fragile reveal test) + 8 SHOULD-FIX + 9 NITs. The Pass-2 PRAISE list
(ratings Map, empty-vs-error split, ErrorCard, Sheet+useModalA11y,
three-file split, dueCardIndex, debounced re-key) is intact and in some
places improved. The wire-up structure (adapters, AbortController on
Sheet detail, refetch wiring) is the right shape and would be unanimously
PRAISEd if not for B1 silently breaking the FSRS loop on the second
rating of any card. Recommended path: close B1 + B2 + B3, then collect
SF1-SF8 in a single follow-up sweep.
