# Design/A11y Review — post-beta polish batch (F-132/174/177/178/180/181/182/186)

**Reviewer:** independent design/a11y pass (not the author). Read-only — no code changes made.
**Repo/branch:** `9b. Korean Master`, `feat/post-beta-polish` @ `77e076d` (diff base: `rebuild`).
**Scope:** `client/index.html`, `LineChart.{tsx,css}`, `WordPopover.tsx`, `ThemeProvider.tsx`, `theme-context.ts`, `Hanja.{tsx,css}`, `Progress.{tsx,css}`, `Settings.tsx`, `Today.{tsx,css}`, `styles/index.css`, plus the associated test files.

## Verdict

**PASS WITH ONE BLOCKER.** The batch is generally careful, well-documented, and well-tested — F-186's Sheet migration, F-180's chip-color unification, F-174's trend line, and F-132's Auto mode are all clean, AA-safe, and properly reduced-motion-aware. However, **F-177's Today.tsx migration silently drops 14px of header-to-content spacing that Progress.tsx (the sibling page in the exact same commit) deliberately preserves** — this reintroduces a Today-vs-Progress visual mismatch in the very feature whose stated purpose is "both hub pages share one recipe."

## Checklist

| Item | Status |
|---|---|
| F-177 — Today/Progress on shared `PageHubHeader`, consistent with Library/LEARN pages | **BLOCKER** — see Finding 1 |
| F-186 — WordPopover on `Sheet`: focus trap / Esc / backdrop / restore-focus | PASS |
| F-186 — Close button still first-focusable | PASS |
| F-186 — Legible + AA on accent-tone sheet, both themes | PASS |
| F-174 — Trend line neutral (not accent), uncluttered, AA, reduced-motion | PASS |
| F-180 — Practicing chip matches index-grid mastery color, AA both themes | PASS |
| F-132 — Auto option: radiogroup semantics, keyboard, hint placement | PASS |
| F-132 — Fits the flex row at 360px, doesn't break other controls | PASS (see Finding 3, non-blocking) |
| No hardcoded hex in new/changed CSS | PASS |
| Reduced-motion honored | PASS |
| Mobile-clean at 360px / no new page-level overflow | PASS (Finding 3 aside) |

## Findings

### BLOCKER — F-177: Today loses 14px of header spacing that Progress explicitly preserves (`Today.tsx`/`Today.css` vs `Progress.tsx`/`Progress.css`)

Both pages used to carry an *identical* rule: `margin: 4px 0 14px` on the page's own `.km-{today,progress}__title`. The new shared `PageHubHeader.css:19` (`.km-hubheader__title { margin: 4px 0 0; }`) drops that trailing 14px by default.

- `Progress.tsx:558` passes `className="km-progress__hub"` to `PageHubHeader`, and `Progress.css:43-50` adds `.km-progress__hub .km-hubheader__title { margin-bottom: 14px; }` with a comment explicitly stating the goal: *"so the migration is byte-for-byte visually, not just structurally."* This works — Progress's header-to-rail gap is unchanged.
- `Today.tsx:696-701`'s `PageHubHeader` call passes **no `className`** at all, and `Today.css:23-25` only has a comment noting the recipe moved out — **no compensating override was added.** Today's own title used to carry the exact same `4px 0 14px` (confirmed via `git show rebuild:client/src/pages/Today.css`), so Today's title-to-rail gap silently tightens from 14px to 0px (net ~14px less space between the `<h1>` and the dancheong rail/first carousel).

Net effect: Today and Progress, which had *identical* header vertical rhythm before this batch and are the two pages F-177's own commit message and doc-comments repeatedly call out as "sharing one recipe," now differ from each other by 14px under the title. This is the exact "visual diff introduced (spacing)" the F-177 probe asks about, and it's a regression in the opposite direction of the ticket's stated intent — worse, it's silent, since nothing else compensates for the loss (checked `Today.css` for the surrounding `.km-today__sectionTitle`/`.km-today__section` margins — no offsetting adjustment exists there either).

**Fix:** add the mirror-image override for Today — either pass `className="km-today__hub"` (or similar) to Today's `PageHubHeader` call and add a `.km-today__hub .km-hubheader__title { margin-bottom: 14px; }` rule in `Today.css`, matching Progress's fix exactly.

### PRAISE — F-186: WordPopover → Sheet migration

`WordPopover.tsx:152` (`<Sheet open onClose={onClose} ariaLabel={data.kr} tone="accent">`) is a clean, well-reasoned promotion:
- Confirmed by tracing DOM order in `WordPopover.tsx:153-171`: the close button is unconditionally the first focusable descendant in markup (head row renders before the `isLoading` branch, and Add/Info only render after), so `Sheet`'s "auto-focus first focusable descendant" behavior (`useModalA11y.ts:208-212`) genuinely reproduces the old "land on close" UX without needing an `initialFocusRef` — the doc comment's claim checks out structurally.
- `Sheet` (`Sheet.tsx`) supplies `role="dialog"`, `aria-modal`, Esc, backdrop-close, Tab-trap, and ref-counted scroll-lock via the single shared `useModalA11y` hook (`useModalA11y.ts`) — no double-wiring. `WordPopover.test.tsx` has direct regression tests for this (`Escape exactly once`, `scroll-lock...exactly once`).
- `tone="accent"` (`index.css:2550-2563` Day / `2567-2578` Night) renders the same dancheong-stripe/neon-edge treatment `CityCard`/`DancheongRail` use elsewhere — a genuine "now reads as the same object as every other popup" win, and it's opt-in per the `Sheet` API so all nine untouched Sheet consumers stay byte-identical.
- AA verified by computation (not just asserted): `--paper` on `--ink-1` is 12.3:1 (Day) / 15.3:1 (Night); the popover's own `--paper-mute`/`--paper-dim` secondary text is 5.6–11.8:1 in both themes. All comfortably clear AA.
- z-index of `.km-sheet` (70, `index.css:2500`) sits correctly under the toast viewport (79/80) and install banner (80) per the existing documented stacking order (`index.css:640,748`) — no new stacking conflict introduced by moving WordPopover onto this layer.

One cosmetic note (not a defect): WordPopover changes from a centered popover to a bottom-attached sheet. This is a real, visible behavior change for the app's single most-tapped gesture, but it's the explicit, well-justified point of F-186 (matching every other popup in the app) — not a regression.

### PRAISE — F-174: trend line

`LineChart.css:72-77` — `.km-linechart__trendfit` uses `stroke: var(--paper-mute)`, never the series accent, exactly matching the "neutral token, not the accent" requirement. Computed contrast for `--paper-mute` against the chart's card background is 5.65:1 (Day) / 6.17:1 (Night) — clears the 3:1 graphical-object floor with margin. The caption (`.km-linechart__trendnote`, `index.css`-adjacent `LineChart.css:118-127`) correctly upgrades to the stricter text token `--paper-dim` (8.8:1 Day / 11.8:1 Night), matching the precedent the code comment cites from Progress's own `TrendChart`. The line is static SVG geometry with no animation (`LineChart.css:76` comment confirms `prefers-reduced-motion` has nothing to gate — verified true, no `animation`/`transition` touches `.km-linechart__trendfit`). Traced the actual carousel call site (`Progress.tsx:326-332`, `SkillTrendPanel` inside the `SwipeCarousel` of 5 skill panels) — the addition is one dashed line + a slightly thicker ring on the last dot; it reads as a single restrained overlay, not clutter.

### PRAISE — F-180: Hanja Practicing chip

`Hanja.tsx:723` flips the EncounteredBand's "Practicing" chip from `tone="vermilion"` (accent-tracking) to `tone="ochre"`, and `Hanja.css:113-118` points that variant at the exact same `--km-mastery-practicing` token the index grid's `HanjaCell` mastery border already reads (`index.css:2204`). Verified the new rule follows the identical pattern as the pre-existing `moss`/`vermilion`/`mute` variants (`index.css:3912-3914`) — only the chip's numeral gets the color, label stays neutral, consistent with the existing convention. "Practicing" now reads one fixed color regardless of accent choice, on both the chip and the grid. Test coverage (`Hanja.test.tsx`, two new F-180 cases) additionally locks the two CSS rules to the same token by reading the source files directly, since happy-dom can't resolve custom properties — a reasonable workaround given the jsdom limitation.

### PASS — F-132: Auto theme option

- Radiogroup semantics unchanged and correctly extended: `Settings.tsx` `THEME_MODES` grows to 4 entries; the roving-tabindex / arrow-key / Home-End contract (`ThemeModeControl`) is generic over the array length, and `Settings.test.tsx` has explicit new coverage for 4-item wrapping (`ArrowRight` from System → Auto → wraps to Light; `End` lands on Auto; etc.).
- Hint placement matches the ask: the label stays one word ("Auto"), and the day/night boundary detail ("Day Seoul 6am–6pm, Night Seoul after") moves to `.km-settings__row-hint` (`Settings.tsx:1919-1920`), not crammed into the segmented button itself.
- `resolveAutoTheme` (`theme-context.ts`) is a pure, testable function (hour ≥ 6 && hour < 18 → light), duplicated intentionally (and self-documented as such) in the no-flash inline bootstrap script (`index.html:47-52`) using the same literal 6/18 boundary — verified both places agree.
- 360px fit: `.km-settings__thememode-row` (`index.css:4760-4764`) is an unconstrained `flex` row (`flex:1` per option, `gap:8px`, no `flex-wrap`). "System" was already the longest label pre-existing this batch at 3 items; "Auto" (4 chars) is shorter than "System" (6 chars), so the new 4th item doesn't introduce a new *worst-case* width — the row's tightest constraint is unchanged. Did not get a live-rendered screenshot at 360px to fully confirm, so flagging as a should-verify rather than a confirmed defect (see Finding 3).
- Accent/text-size controls: untouched by this diff (`git diff` shows no changes to those rows), so no risk of breakage there.

### SHOULD-FIX (minor, not blocking) — Finding 3: no visual QA screenshot for the 4-item Theme row at 360px

Static analysis (CSS + prior 3-item layout precedent) suggests the row still fits, but nobody appears to have rendered it at an actual 360px viewport to confirm the "System" button's label doesn't wrap awkwardly now that it shares the row with one more neighbor eating into the shared `gap`. Recommend a quick manual/Playwright screenshot at 360px before sign-off, purely to close the loop — not asserting a failure, just noting it wasn't visually verified.

### Non-blocking aside (out of my probe scope, flagging for completeness)

`Hanja.tsx`'s `DrawView` promote-state logic (F-181/F-182, same file touched for F-180) changes when `setMasteredCount` increments — now gated behind the same `if (next !== current.state)` branch that guards the actual write, so a reconfirmation of an already-mastered character no longer inflates the "N of M mastered" count. This is a correctness/business-logic fix, not a design/a11y matter, and it's outside my named probe list — mentioning only so it isn't missed in aggregation, not evaluating it further here.

## Coordination

- The one BLOCKER (Finding 1) is a small, mechanical fix — mirror Progress's exact `className` + `margin-bottom` override pattern onto Today. Should not require touching `PageHubHeader.tsx`/`.css` itself, since the shared component's default (no trailing margin) is presumably the *correct* default for the 7 Library pages that adopted it in batch-2 (those never had the extra 14px to begin with) — only Today and Progress, the two pages that pre-date the shared component and originated the recipe, need the compensating override.
- Everything else in this batch (F-132, F-174, F-178/180, F-186) is ready as-is from a design/a11y standpoint.
