# REVIEW_P2B_visual — Pass 2 composite components (visual)

> Independent senior review. Scope: SkillsCompare, SkillBar, TaskCard, TianGrid,
> HanjaCell, GoldRule, CornerMark, MockBadge (+ sibling tests + their CSS in
> `src/styles/index.css`). I did not write this code.
>
> Verdict: **PASS WITH CONDITIONS.** Scoring contract (0–100 → TOPIK bands)
> is correctly implemented end-to-end with no "L3.4" fakery. Two real bugs
> (`animated=false` silently zeroes the bar; `role="tablist"` without
> `tabpanel` + no arrow-key nav) and a handful of NITs.

| Category | Count |
|---|---:|
| BLOCKER | 0 |
| SHOULD-FIX | 3 |
| NIT | 7 |
| PRAISE | 8 |

---

## Bar checklist (per `SENIOR_ENGINEER_BAR.md` §2/§5)

| Check | Status | Note |
|---|---|---|
| TS strict / no `any` | PASS | strict + verbatimModuleSyntax + erasableSyntaxOnly all on (`tsconfig.app.json:18-25`); no `any` in any file in scope. |
| `verbatimModuleSyntax` (`import type`) | PASS | All files type-import `JSX` / `CSSProperties` / `HTMLAttributes` correctly. |
| `erasableSyntaxOnly` | PASS | No enums; all enums emulated as union types + `Record<>` lookup tables (`HanjaCell.tsx:30-34`, `TaskCard.tsx:22`, `SkillBar.tsx:26`). |
| Tests test the contract | PASS (mostly) | See NIT-3 — animation timing + reduced-motion are not tested, but the class contract is. |
| Lint / typecheck / unit tests | UNVERIFIED | Not run here (REPORT ONLY). |
| `SECURITY.md` | N/A (purely presentational components) | The components in scope take no user input and emit no I/O; covered by component-level threat-model already in `client/SECURITY.md`. |
| README per module | N/A | Module-level docstrings in each file are the README. |
| No `console.log` / `TODO` | PASS | None. |
| No hardcoded colors | DEVIATION (documented) | `MockBadge.tsx:36-37` hardcodes `#B83A2E` / `#FBF6E6`; comment justifies (defensive against unloaded token block). Acceptable. |

---

## Findings — by severity

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — `SkillBar` `animated={false}` silently zeroes the bar forever.**
`SkillBar.tsx:90` — `const widthPct = ready && animated ? (safeScore / MAX) * 100 : 0;`. The internal `ready` flag already handles the initial 0 → animate-in pass (`SkillBar.tsx:77-85`), so the external `animated` prop is redundant for animation-on. But when a caller passes `animated={false}` — which the docstring (`SkillBar.tsx:49-50` "Set true once the parent has mounted") and the prop's name both invite — the bar shows 0% width permanently with no error and no test failure. There are two reasonable contracts for `animated`:
- "skip the transition, just paint at final width" (what SSR/tests want), or
- "stay collapsed until I say so" (what the docstring implies).
The current code does neither — it collapses to 0% AND, because `ready` flips after 16ms and triggers a re-render with `widthPct=0` still, no transition ever runs. `SkillsCompare.tsx:120-133` never passes `animated`, so the default `true` masks the bug; nothing in the codebase trips it today, but the next caller will. **Fix**: either remove the prop (the `ready` gate is sufficient) or honor `animated=false` as "paint immediately at final width" (`widthPct = ready ? ... : 0` and a separate `animateIn` opt-out). The `SkillBar.test.tsx` suite does not cover this.

**SF-2 — `SkillsCompare` picker uses `role="tablist"` without an associated `tabpanel` and without arrow-key nav.**
`SkillsCompare.tsx:90-114`. Two ARIA-APG violations:
1. **Confused-deputy roles.** WAI-ARIA APG requires every `tab` to control a `tabpanel` (via `aria-controls` + the panel's `role="tablist"`'s sibling having `role="tabpanel"` + `aria-labelledby`). The bars are not tabpanels — they don't switch as the picker changes; they all stay visible and only their `target` re-aims. The correct semantic is a **`radiogroup` of `radio` buttons** (the picker is "pick one of N references"), or simply un-roled `<button>` with `aria-pressed`. As written, screen-reader users will hear "tab, 1 of 4" and expect tab-switching, then get nothing visible to switch to.
2. **No keyboard arrow nav.** APG tablists require Left/Right (or Up/Down) to move between tabs with focus follow. The current impl supports only Tab between buttons. If you keep `role="tab"`, add a `keydown` handler. If you switch to `radiogroup` / `aria-pressed`, the native Tab behavior is fine.
Recommended: switch to `role="radiogroup"` on the container + `role="radio"` + `aria-checked` on each pill (radiogroup *does* support roving Tab and arrow keys via the platform; many screen readers handle it natively). The README on line 305 calls it a "segmented pill picker" — `radiogroup` is the closest standard.

**SF-3 — `TaskCard` `min-width: 260px` on the card itself can cause horizontal overflow on narrow viewports.**
`src/styles/index.css:877`. The prototype achieves the 260px floor via the parent grid's `minmax(260px, 1fr)` (`screens-a.jsx:461`), not on the card. Putting `min-width: 260px` on the card means: if the parent container is < 260px (small phones in landscape rotated, or a future side-sheet rendering of TaskCard), the card overflows its container and breaks layout. For a 402px iPhone frame this is fine today but it's brittle. **Fix**: drop `min-width` from `.km-taskcard` and rely on the grid's `minmax(...)`, which is exactly how the prototype does it. The 260px contract belongs to the parent.

### NIT

**NIT-1 — `SkillsCompare` `defaultRefId` is only read on mount; later parent updates are ignored.**
`SkillsCompare.tsx:71-73`. `useState` with a lazy initializer means subsequent parent changes to `defaultRefId` are silently dropped. Today the only caller passes a static value, so this works. If a future caller flips it (e.g. "default to user's current TOPIK level once auth resolves"), they'll be confused. Either rename to `initialRefId` to signal "uncontrolled" semantics, or add a controlled-mode prop (`refId` + `onRefChange`).

**NIT-2 — `SkillBar` numeric header reads `42 / 55` but `font-variant-numeric: tabular-nums` is set on the parent `.km-skillbar__score` and the inner `<span>` may inherit OK, but visually verifying.**
`SkillBar.tsx:106-108`, `index.css:746-754`. Worth confirming the slash + spacing render as designed when both numbers are 3-digit (e.g. 100 / 100 for Native). Tabular-nums helps but the explicit space-slash-space (`" / 55"`) plus `font-variant-numeric` on the parent should hold. Low-risk.

**NIT-3 — Tests don't verify the 360ms tick transition or the 720–900ms width animation.**
`SkillsCompare.test.tsx` and `SkillBar.test.tsx`. The prompt's review criteria call out "Tick position transitions 360ms when ref changes" and "Animated width 720–900ms". The tests assert classes + visibility but never read computed style. JSDOM doesn't run CSS transitions, so testing the *duration* is hard — but you can read `getComputedStyle(el).transitionDuration` and assert the declared CSS value is in the right band. Worth a single test per component that pins the contract so a future CSS edit doesn't drift the timing.

**NIT-4 — Tests don't verify reduced-motion behavior.**
The global `prefers-reduced-motion` rule at `index.css:158-164` collapses all transitions to 0.001ms via `*::before, *::after` + `*`. That works, but there is no test that emulates the media query and asserts the rule applies to `.km-skillbar__fill`. A `matchMedia` mock + `getComputedStyle` snapshot would lock it in.

**NIT-5 — `MockBadge` `data-testid="mock-badge"` is correctly absent in PROD (because the whole component returns null), but consider also gating the `data-testid` even in DEV so consumers don't accidentally couple to it.**
`MockBadge.tsx:62`. Low-priority — having a testid is fine; just flagging that prod-strip happens at the component level, not the attribute level.

**NIT-6 — `TianGrid` opacity prop type-cast.**
`TianGrid.tsx:33-36`. The cast through `Record<string, string | number>` then back to `CSSProperties` is the standard escape for custom properties. A cleaner pattern is `style={{ ...(style ?? {}), ['--km-tian-opacity' as never]: String(opacity) }}`. Functionally identical; the current form is fine. Personal style preference.

**NIT-7 — `GoldRule` `role="separator"` is redundant.**
`GoldRule.tsx:25`. `<hr>` already has implicit `role="separator"`. Not wrong, just noise. (Per ARIA in HTML: "If [the implicit role is the same as the explicit one], do not specify the role.")

### PRAISE — fix-pass must not undo

- **P-1 — `SkillBar.tsx:55-61` `clamp(0,100)` defense against NaN/out-of-range.** Catches malformed fixture data without crashing the chart — exactly the senior-bar §2 "robust by default" stance.
- **P-2 — `SkillBar.tsx` `score >= target` threshold matches `screens-a.jsx:387` exactly, including the equality-meets case.** `SkillBar.test.tsx:38-43` pins it. No "L3.4" fakery anywhere; scoring is honestly 0–100 → bands.
- **P-3 — `SkillsCompare.tsx:74-77` empty-refs guard.** Returns an empty shell instead of crashing on an undefined `references[0]`. Tested at `SkillsCompare.test.tsx:91-96`. Exactly the kind of fixture-bug defense the bar calls for.
- **P-4 — `SkillsCompare.tsx:79-81` "previous refId disappeared" fallback.** `references.find(...) ?? references[0]` means a parent that mutates refs (e.g. server returns a new ref set) doesn't leave the picker invisible.
- **P-5 — `SkillBar` tick `transition: left 360ms` (`index.css:783`) + width `transition: width 760ms` (`index.css:769-771`) both fall inside README §Interactions ranges (360ms tick, 720–900ms fills).** The cubic-bezier matches `(.2,.7,.2,1)` per spec line 343.
- **P-6 — `TianGrid` is correctly CSS-only (no SVG) and `aria-hidden`.** Inherits the vermilion CSS variable for theme; `--km-tian-opacity` custom prop lets the React prop ride into CSS without re-render. `screens-c.jsx:130-136` has exactly the same crosshair-plus-rotated-dashed-square shape, just inlined.
- **P-7 — `HanjaCell` accessible name composition (`HanjaCell.tsx:45`).** Without `aria-label`, screen readers would announce a bare CJK glyph + a 2px colored border (state) the user can't see. `gloss + sound` makes the cell self-narrating; `HanjaCell.test.tsx:49-56` pins the contract.
- **P-8 — `MockBadge` PROD gate via `import.meta.env.PROD` (`MockBadge.tsx:58`).** Single PROD gate, single render path — exactly the "no per-screen drift" architecture documented in the docstring. `vite/client` types are in `tsconfig.app.json:7` so the import resolves cleanly.

---

## Detailed review — by file

### `src/components/SkillBar.tsx`

- **Contract (PASS).** Score/target are `number`; `tone: 'target' | 'ceiling'`; the README's two-color tick rule (vermilion for TOPIK, indigo for Native) is encoded via the `tone` enum and `SkillsCompare.tsx:127` flips it on `activeRef.isCeiling`. Honest.
- **Threshold (PASS).** `score >= target` → moss; below → paper-faint. Test at `SkillBar.test.tsx:38-43` pins the `==` case explicitly.
- **Animation (PASS).** CSS at `index.css:769-771` uses `width 760ms cubic-bezier(.2,.7,.2,1)` — inside the 720–900ms README band. Tick position transition at `index.css:783` is 360ms — matches README §Interactions.
- **Reduced motion (PASS).** Inherits the global rule at `index.css:158-164`. The docstring on `SkillBar.tsx:15` explicitly calls this out — good provenance.
- **Bug (SF-1).** `animated={false}` paints 0%. See SHOULD-FIX above.
- **Tabular-nums (PASS).** `font-variant-numeric: tabular-nums` at `index.css:748`.
- **`aria-valuenow=safeScore`, `aria-valuemin=0`, `aria-valuemax=100` (PASS).** Proper progressbar role at `SkillBar.tsx:112-117`.

### `src/components/SkillsCompare.tsx`

- **Scoring contract (PASS).** Scores stay 0–100 throughout; the `references` array carries `{id, label, value}` with no decimal-level temptation. The README §SkillsCompare contract is honored.
- **State (PASS).** `useState` with lazy initializer; refId resolves from `defaultRefId` → first ref → empty. NIT-1 flags the "controlled later" case.
- **Picker a11y (SF-2).** `role="tablist"` + `role="tab"` with no `tabpanel` and no arrow-key nav. See SHOULD-FIX above. The active-tab class also drives a color flip (`index.css:824-829`) which is fine — but `aria-selected` alone won't tell a non-visual user the bars below are reference-relative.
- **Ceiling visual (PASS).** `SkillsCompare.tsx:105` adds `km-skillscompare__pick--ceiling` only when both `selected && r.isCeiling` — color flips to indigo, not vermilion. README §1d-style call-out honored.
- **Compact suppresses notes + legend (PASS).** Tested at `SkillsCompare.test.tsx:72-89`.
- **Stagger (PASS).** `delayMs={i * 70}` matches the prototype's 70ms cadence (`screens-a.jsx:357`).

### `src/components/TaskCard.tsx`

- **Tone mapping (PASS).** `gold` → vermilion (`index.css:905`), `red` → indigo (`index.css:906`). The misleading-but-historical "red means indigo" naming is documented in `Pill.tsx:7-9` and re-flagged in `TaskCard.tsx`'s docstring.
- **Pill tone (PASS).** `TaskCard.tsx:65` maps tone→Pill tone identically — gold→gold, red→red, default→default. Tested at `TaskCard.test.tsx:54-70`.
- **Min height 180 / min width 260 (PARTIAL — see SF-3).** Both at `index.css:876-877`. The `min-width` shouldn't be on the card per the prototype's grid pattern.
- **Button semantics (PASS).** `<button type="button">` → keyboard activate works automatically; `.focusring` for ring; `onClick` fires for both keyboard and mouse. Tested at `TaskCard.test.tsx:72-86`.

### `src/components/TianGrid.tsx`

- **CSS-only (PASS).** No SVG; three `<span>` siblings + CSS centerlines + a rotated dashed square. Matches `screens-c.jsx:132-136`.
- **Opacity 15–18% (PASS).** Default 0.18 (`TianGrid.tsx:25`), with the diagonal further dampened to 0.85× (`index.css:713`) — same nudge the prototype takes by varying line styles. README says "15% opacity" for diagonals at line 236; 0.18 × 0.85 ≈ 0.153 — within rounding.
- **`aria-hidden` (PASS).** Decorative; correctly hidden from AT.
- **`pointer-events: none` (PASS).** Won't intercept clicks on the hanja.

### `src/components/HanjaCell.tsx`

- **State border (PASS).** 2px top border, color from `STATE_CLASS` map. Tested at `HanjaCell.test.tsx:11-18`.
- **Keyboard activate (PASS).** Native `<button>` → Enter and Space work for free. Test at `HanjaCell.test.tsx:38-47` covers Enter explicitly.
- **Accessible name (PASS).** `aria-label` composes `${char} ${gloss} ${sound}` — exemplary.
- **Focus ring (PASS).** Inherits `.focusring` global.
- **`data-state` (PASS).** Convenient for screenshot tests / CSS-only state selectors.

### `src/components/GoldRule.tsx`

- **Hairline + vermilion gradient (PASS).** Matches `screens-a.jsx`'s `.hr-gold`.
- **`role="separator"` (NIT-7).** Redundant — `<hr>` already has it.

### `src/components/CornerMark.tsx`

- **14px L-bracket (PASS).** Two borders (top + right) form the corner. Matches `screens-c.jsx:117-119` / README line 102.
- **`aria-hidden` (PASS).** Decorative.
- **Parent positioning contract (PASS).** Documented in the docstring (`CornerMark.tsx:7`).

### `src/components/MockBadge.tsx`

- **PROD gate (PASS).** `import.meta.env.PROD` returns `null`. `vite/client` types resolve. **No layout shift** in PROD because the returned `null` means no element renders; in DEV, `position: absolute` keeps it out of flow.
- **`aria-hidden` (PASS).** Developer chrome, not user info.
- **Hardcoded color (DOCUMENTED DEVIATION).** Justified inline (`MockBadge.tsx:33-37`) — must render even if the token block hasn't been injected (error-boundary fallback). Acceptable.

### Tests

- `SkillBar.test.tsx` — covers fill class, equality threshold, numeric header, ceiling tick, gapNote compact/full. Misses `animated={false}` (would have caught SF-1).
- `SkillsCompare.test.tsx` — covers default, explicit default, switching, ceiling class, compact suppression, empty-refs. Misses keyboard nav on the picker.
- `TaskCard.test.tsx` — covers tones, pill render, default no-class, onClick. Misses keyboard activation (low-risk; native button).
- `HanjaCell.test.tsx` — covers states, data-state, click, Enter, aria-label. Exemplary.

### CSS (`src/styles/index.css` §640–968)

- Selector specificity OK; no `!important`; tokens used throughout (with the one MockBadge inline-style deviation justified above).
- Reduced-motion handled globally — explicit comment at `index.css:644-646` saying "no per-component blocks needed" is good provenance.
- `aspect-ratio: 1` at `index.css:935` — accepted shorthand for `1 / 1`. Fine.

---

## Coordination notes for the fixpass agent

- **Highest-impact change** is SF-2 (the picker ARIA + keyboard). Switching to `role="radiogroup"` / `role="radio"` / `aria-checked` is a one-file edit in `SkillsCompare.tsx` + a test update; nothing else in the codebase depends on the tab roles.
- **SF-1 is one line** in `SkillBar.tsx` (either remove the `animated` prop or change the gate). Add a `SkillBar.test.tsx` case so it stays fixed.
- **SF-3 is one CSS line** to drop. The Today grid (`screens-a.jsx:461`) already provides the 260 floor via `minmax(260px, 1fr)` — port the same grid pattern in any consumer; the TaskCard CSS should not enforce it.
- **No coordination needed with Pass 1 PRAISE.** The Pass 1 token block, three-file context/provider split, `ApiError` boundary, `forwardRef` Button — none of those are touched by the components in scope here. No silent regression detected.

---

**Final**: PASS WITH CONDITIONS. Three SHOULD-FIXes; no BLOCKERs. The scoring
contract (0–100 → TOPIK bands, no decimal levels) is honored end-to-end and
the threshold tests pin it. Threshold equality, animation timing, ceiling
color, state borders, and `aria-hidden` on decoration all check out.
