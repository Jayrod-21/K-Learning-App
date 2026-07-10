# Review — Phase 1 UI primitives, nav/interaction slice

**Branch:** `feat/phase1-ui-primitives` · **Commit under review:** `de6f618` ("feat(client): Phase 1 nav/interaction primitives")
**Scope:** `BackButton.{tsx,css,test.tsx}`, `CollapsibleTile.{tsx,css,test.tsx}`, `Tabs.{tsx,css,test.tsx}`, `SwipeCarousel` `loop`/`cornerSlot` extension (`.tsx`, `.css`, `.test.tsx` diffs vs `rebuild`)
**Reviewer:** independent senior review, 2026-07-09

## Summary verdict: PASS WITH CONDITIONS

Zero blockers. All four primitives are behaviorally correct, the SwipeCarousel
extension is provably backward compatible, and the tests are real (user events
and pointer sequences asserting observable ARIA/DOM state, not tautologies).
Three should-fix items — one genuine ARIA validity defect in Tabs (dangling
`aria-controls`), one CSS comment claiming a contrast validation the test suite
does not actually perform, and an unguarded `navigate(-1)` fallback that can
exit the PWA in exactly the deep-link scenario the component's own docs
describe. None blocks merge; all three should land before consumers mount
these primitives at scale.

## Gates (re-run, not trusted from prior reports)

| Gate | Result | Notes |
|---|---|---|
| TypeScript | **0 errors** | No `typecheck` npm script exists (see Coordination). Ran `npx tsc -p tsconfig.app.json --noEmit --incremental false` and same for `tsconfig.node.json` — both exit 0. (`npx tsc -b` also finds 0 type errors but trips the known root-owned `node_modules/.tmp` EACCES writing tsbuildinfo.) |
| ESLint | **0 problems** | `npm run lint` exit 0. |
| Targeted tests | **4 files, 41/41 pass** (822ms) | `npx vitest run src/components/BackButton src/components/CollapsibleTile src/components/Tabs src/components/SwipeCarousel` |

Working tree clean for all reviewed files; no `console.*`, `TODO`, or `FIXME`
in any of the eight source/CSS files or the four test files.

## Findings index

| ID | Severity | Where | One-liner |
|---|---|---|---|
| SF-1 | SHOULD-FIX | `Tabs.tsx:130` + `141-153` | Inactive tabs' `aria-controls` reference panel ids that don't exist in the DOM (only the active panel renders) — fails axe `aria-valid-attr-value` |
| SF-2 | SHOULD-FIX | `Tabs.css:9-11` | Comment claims accent-underline 3:1 vs surface is "validated by styles/tokensContrast.test.ts" — no such assertion exists |
| SF-3 | SHOULD-FIX | `BackButton.tsx:57` | Bare `navigate(-1)` fallback has no empty-history guard — at history index 0 it is a browser back and can exit the PWA |
| N-1 | NIT | `Tabs.tsx:94-108` | Arrow keys navigate relative to `rovingIndex` (selection), not the focused tab — diverges from APG in controlled-unsynced mode |
| N-2 | NIT | `Tabs.tsx:141-153` | Stale controlled `active` id → all tabs `aria-selected=false` while a panel renders with a dangling `aria-labelledby` |
| N-3 | NIT | `CollapsibleTile.test.tsx` | No assertion that `km-collapsible__body--collapsed` class is applied — visual collapse could regress with green tests |
| N-4 | NIT | `BackButton.tsx:62-67` | `to` mode renders a `<button>` where a router `Link` would give href semantics (middle-click, SR "link" role); trade is documented |
| N-5 | NIT | `SwipeCarousel.test.tsx:437-444` | No test covers the loop-disables-damping branch (`SwipeCarousel.tsx:198-200`); only the snap outcome is proven |
| P-1 | PRAISE | SwipeCarousel diff | Backward compatibility is airtight and verifiable (details below) |
| P-2 | PRAISE | `CollapsibleTile.tsx:84-99`, `.css:48-70` | Grid `1fr↔0fr` collapse with the two-wrapper padding fix is the robust form, correctly executed |
| P-3 | PRAISE | `Tabs.test.tsx:157-197` | Controlled-mode test asserts selection does NOT move until the prop updates — a real regression trap |
| P-4 | PRAISE | All four `.css` files | `prefers-reduced-motion: reduce` handled in every file that animates |

## Detailed findings

### SF-1 (SHOULD-FIX) — Tabs: dangling `aria-controls` on inactive tabs

`client/src/components/Tabs.tsx:130` puts `aria-controls={panelId(tab.id)}` on
**every** tab button, but the render-one-panel design (`Tabs.tsx:141-153`,
deliberate and well-argued in the header comment) means only the active
panel's id exists in the DOM. For a 3-tab strip, two tabs always carry an
`aria-controls` pointing at nothing. This is an ARIA validity violation that
axe flags as `aria-valid-attr-value` (severity: serious), and some AT will
announce "controls" relationships that lead nowhere.

Cheapest correct fix, keeping the single-panel design: render `aria-controls`
only on the selected tab (`aria-controls={tab.id === activeId ? panelId(tab.id) : undefined}`).
APG treats `aria-controls` on tabs as optional; a conditional one is strictly
better than a dangling one. Note the sibling primitive gets this right by
construction — SwipeCarousel renders all panels (hidden+inert), so its
`aria-controls` targets always exist (`SwipeCarousel.tsx:280-294, 315`).

### SF-2 (SHOULD-FIX) — Tabs.css: contrast claim not backed by the cited test

`client/src/components/Tabs.css:9-11` claims the active underline "(accent vs
surface clears the 3:1 non-text minimum in both themes)" as "validated by
styles/tokensContrast.test.ts". I read that test
(`client/src/styles/tokensContrast.test.ts`): it validates hue-ink on
hue-soft ≥ 4.5:1 (lines 100-104), `--paper-mute` ≥ 4.5:1 on every surface
(122-126), dim > mute on `--ink-1` (129-133), and `--focus-ring` vs `--ink`
≥ 3:1 across theme × accent combos (138-160). **Nothing asserts `--vermilion`
(the underline color, `Tabs.css:54`) vs a card surface at 3:1.** Because the
three accent presets (`coral`, `blue`, `mint` — tokensContrast.test.ts:146)
re-point `--vermilion`, a future preset could silently drop the underline
below 3:1 and no test would catch it. Either add the assertion (one more loop
in the existing accent × theme block) or correct the comment. The `--paper-dim`
rest-text claim, by contrast, IS transitively backed (mute ≥ 4.5 on `--ink-1`
and dim > mute on `--ink-1`), so this is the only overclaim.

### SF-3 (SHOULD-FIX) — BackButton: `navigate(-1)` fallback can exit the app

`client/src/components/BackButton.tsx:57` calls `void navigate(-1)` when `to`
is omitted. The component's own header (lines 5-11) correctly identifies the
danger — "inside the PWA shell a sub-page is often the FIRST entry in the
tab's history … so `history.back()` would exit the app" — and then relies
purely on caller discipline to avoid it. A deep link into a "multi-entry
wizard" page (the very flows meant to omit `to`) still lands at history
index 0, where `navigate(-1)` is a real browser back: exit the PWA or leave
the origin. A five-line guard closes the hole robustly:
check `window.history.state?.idx > 0` (react-router v7 data/browser history
maintains `idx`) and fall back to a home route (or a new optional
`fallbackTo` prop) when there is nothing in-app to go back to. Tests cover
the happy fallback (`BackButton.test.tsx:66-77`, MemoryRouter with 2 entries)
but not the empty-history case — add one alongside the guard.

### N-1 (NIT) — Tabs: arrows move relative to selection, not focus

`Tabs.tsx:94-108`: `onTabKeyDown` computes next from `rovingIndex` (derived
from `activeId`) instead of the index of the button that received the event.
With automatic activation in uncontrolled mode, focus ≡ selection, so
behavior is identical. But in controlled mode with a parent that defers or
rejects `onChange` (the mode the header comment at lines 29-31 explicitly
sanctions), clicking tab C leaves focus on C while `rovingIndex` stays on A;
ArrowRight then jumps relative to A, not C. APG specifies arrows relative to
the focused tab. Using `e.currentTarget` (or passing `i` into the handler,
as the click handler already does) removes the divergence.

### N-2 (NIT) — Tabs: stale controlled id degrades ARIA quietly

`Tabs.tsx:82-87` handles a stale/mistyped `active`/`defaultTab` for the
roving tabindex (first tab keeps a tab stop — good), but at `141-153` a
panel still renders for the bogus id with `aria-labelledby` pointing at a
nonexistent tab id, and every tab reads `aria-selected="false"` (invalid for
a tablist with automatic activation semantics). Worth either snapping
`activeId` to `tabs[rovingIndex].id` when `foundIndex === -1`, or at least a
dev-mode warning. Low priority; requires caller error to reach.

### N-3 (NIT) — CollapsibleTile tests don't pin the visual collapse

`CollapsibleTile.test.tsx` asserts `aria-expanded`, `aria-hidden`, and
`inert` — all real — but never that `km-collapsible__body--collapsed` lands
on the body (`CollapsibleTile.tsx:86-89`). Since jsdom can't observe the
grid animation, the class IS the testable proxy for the visual collapse;
if someone dropped it from the `cn()` call while keeping the aria wiring,
the suite stays green and the tile stops folding. One `toHaveClass`
assertion in the `defaultCollapsed` test closes this.

### N-4 (NIT) — BackButton `to` mode as `<button>` vs `Link`

`BackButton.tsx:62-67`: when `to` is provided there IS a stable href, so a
router `Link` would give middle-click/new-tab and "link" semantics. The
header comment (lines 13-15) makes a defensible uniformity argument
(one element for both modes); recording as a preference, not a defect.

### N-5 (NIT) — Loop damping branch untested

`SwipeCarousel.tsx:198-200` disables edge damping under `loop` — correct,
and the rationale comment is right — but no test observes `dragX` (via the
track transform) during a loop-mode edge drag, so a regression re-enabling
damping there would pass the suite (the wrap snap tests at
`SwipeCarousel.test.tsx:407-437` only check the landed page). Cheap to
cover by asserting the track transform mid-drag, as the existing
non-loop overscroll test presumably does for the damped case.

### P-1 (PRAISE) — SwipeCarousel backward compatibility, proven not asserted

The default-path claim holds under scrutiny, on three independent axes:

1. **Logic:** with `loop=false`, `goTo` (`SwipeCarousel.tsx:129-138`)
   reduces to exactly the old `clamp(next, 0, maxIndex)`, and the overscroll
   expression (`:198-200`) reduces to exactly the old
   `(index === 0 && dx > 0) || (index === maxIndex && dx < 0)`. With
   `cornerSlot` undefined, the `!= null` check (`:271-273`) renders nothing.
2. **Call sites:** `git diff rebuild -- client/src/pages/Progress.tsx
   client/src/pages/Today.tsx` is empty — all three pre-existing usages
   (`Progress.tsx:341`, `Today.tsx:425`, `Today.tsx:468`) are byte-identical,
   none passes the new props.
3. **CSS:** the one change affecting default consumers is `position:
   relative` on `.km-carousel__viewport` (`SwipeCarousel.css`). I checked
   the only absolutely-positioned content inside existing carousel pages —
   LineChart's hit columns (`LineChart.css:74`) — and they anchor to
   LineChart's own `position: relative` wrappers (`LineChart.css:17,21`),
   so no containing block changes. Harmless.

The "rewind vs. clone" loop trade-off is documented honestly in the header
(`SwipeCarousel.tsx:33-40`) instead of being hidden; the tests for wrap in
both directions plus the default hard-stop (`SwipeCarousel.test.tsx:407-445`)
would each fail if the modulo or the default were wrong.

### P-2 (PRAISE) — CollapsibleTile collapse mechanics

The grid `1fr ↔ 0fr` form (`CollapsibleTile.css:50-57`) is the correct
robust choice over max-height, and the execution shows the failure modes
were actually thought through: `min-height: 0` + `overflow: hidden` on the
clip layer (`:63-66`), padding pushed one level deeper with the "stray
strip" bug named explicitly (`CollapsibleTile.tsx:93-95`, `.css:60-62,68-70`),
body kept mounted so `aria-controls` always resolves, with `aria-hidden` +
`inert` (React 19, consistent with SwipeCarousel's pages) genuinely removing
collapsed content from the a11y tree and tab order (`CollapsibleTile.tsx:90-91`,
verified by `CollapsibleTile.test.tsx:42-53`). Full-row hit target rationale
(`:6-9`) is right for the phone shell.

### P-3 (PRAISE) — Tabs controlled-mode test is a real regression trap

`Tabs.test.tsx:157-197` clicks a tab in controlled mode and asserts the
selection does **not** move until the parent re-renders with the new
`active` — exactly the invariant that half-controlled implementations break.
Combined with the roving-tabindex test (`:85-108`) and focus-follows-arrows
with wrap (`:110-136`), the suite exercises the W3C contract, not the
implementation's happy path.

### P-4 (PRAISE) — Reduced motion, everywhere it matters

All four stylesheets disable their transitions under
`prefers-reduced-motion: reduce`: `BackButton.css:40-44`,
`CollapsibleTile.css:72-77` (chevron AND body row), `Tabs.css:61-66`
(color AND underline), `SwipeCarousel.css:34-37, 97-101` (pre-existing,
still intact). State still changes; nothing animates. Correct pattern.

## Test-quality assessment

Would each test fail if the behavior regressed? Spot-audited: yes.
BackButton asserts actual router location via a `useLocation` probe after
real clicks (both `to` and history-back modes) — not a mocked `navigate`.
Tabs drives userEvent keyboard/click and asserts `aria-selected`, focus,
tabindex, and rendered panel text. SwipeCarousel's loop tests replay full
pointerdown/move/move/up sequences through the axis-lock state machine.
The only blind spots found are N-3 and N-5 above. No tautologies detected.

## Coordination observations

- **No `typecheck` script** in `client/package.json` — the review brief (and
  possibly other reviewers/CI docs) assumes one. Closest equivalent is
  `tsc -b` inside `npm run build`, which currently trips the root-owned
  `node_modules/.tmp` EACCES on tsbuildinfo write even when type-checking
  succeeds. Worth adding `"typecheck": "tsc -p tsconfig.app.json --noEmit"`
  (or fixing `.tmp` ownership) so the gate is one command.
- **Today.tsx is a second SwipeCarousel consumer** (two call sites,
  `Today.tsx:425` and `:468`) beyond the Progress.tsx named in the brief;
  verified unchanged vs `rebuild` as well.
- The branch has a second commit (`4645273`, global+list primitives:
  TextSize/FilterSelect/usePagination) outside this slice — not reviewed here.
- No consumer was migrated onto Tabs/CollapsibleTile/BackButton in this
  commit — consistent with a primitives-only phase; no scope creep observed.
  When LibrarySubnav/Chat migrate onto Tabs (per its header comment), SF-1
  and N-1 should already be fixed.
