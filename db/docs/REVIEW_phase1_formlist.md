# REVIEW — Phase 1 UI primitives: form/list slice + cross-cutting sweep

Reviewer: independent senior review (form/list slice: FilterSelect, usePagination, ShowMore; sweep: all 7 primitives).
Branch: `feat/phase1-ui-primitives` (2 commits: `de6f618` nav/interaction, `4645273` global+list). Date: 2026-07-09.

## Summary verdict

**APPROVE with SHOULD-FIXes.** 0 BLOCKER · 3 SHOULD-FIX · 6 NIT · 6 PRAISE.

All three form/list primitives are correct by inspection and by test. Gates green:

- Typecheck: **0 errors** (`npx tsc -p tsconfig.app.json --noEmit` + `tsconfig.node.json` — note there is NO `typecheck` npm script; `tsc -b` works but hits the known root-owned `node_modules/.tmp` EACCES writing tsbuildinfo, type errors still 0).
- Lint: `npm run lint` → **0 errors, 0 warnings**.
- Targeted tests: `npx vitest run src/components/FilterSelect src/hooks/usePagination src/components/ShowMore` → **3 files, 19/19 passed** (FilterSelect 6, usePagination 8, ShowMore 5).

Top finding: `usePagination` exposes no `remaining`, but `ShowMore`'s documented wiring shows a remaining count — the obvious caller derivation (`total - visible.length`) over-promises whenever `total > max`. Latent (no consumers yet) but it's a contract gap between two primitives designed as a pair.

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1. usePagination ↔ ShowMore remaining-count contract gap.**
`ShowMore` docs say "wire to `usePagination().showMore`" and renders "Show more (N)" from a `remaining` prop (`client/src/components/ShowMore.tsx:26-27,42-45`), but `UsePaginationResult` (`client/src/hooks/usePagination.ts:27-38`) exposes only `visible/canShowMore/showMore/reset/total`. The natural derivation `total - visible.length` is WRONG under the cap: total=50, max=30 → button says "Show more (35)", clicking reveals 15, then the button vanishes with 20 items never reachable. Fix: export `remaining` (= `limit - visibleCount`, i.e. what showMore can still reveal) from the hook and document that as the value to pass. One-line change plus a boundary test.

**SF-2. usePagination tests miss the exact boundaries the contract hinges on.**
`client/src/hooks/usePagination.test.ts` covers lengths 5/8/10/20/50/100 but never:
- `items.length === initial` (exactly 15 — the classic `<` vs `<=` off-by-one for `canShowMore`),
- `items.length === max` (exactly 30 — cap-equals-length),
- `items = []` (empty list: `visible=[]`, `canShowMore=false`, `total=0`).
Behavior is correct by inspection (`usePagination.ts:58-66`: `limit=min(max,len)`, `canShowMore = visibleCount < limit` gives false at both exact boundaries and for empty), but these are precisely the cases a regression would flip silently. Add three tests.

**SF-3. px font sizes exempt every Phase-1 primitive from the F-025 text-size setting shipped in the same branch.**
F-025 scales the ROOT font-size so rem-derived lengths follow (`client/src/styles/index.css:265-267`), but all new primitive text is pinned in px: `FilterSelect.css:22` (11px label), `:41` (13.5px control), `ShowMore.css:15` (13px), `Tabs.css:27` (13px), `BackButton.css:24` (13px), `CollapsibleTile.css:26` (14px). A user choosing Large will see no change in any Phase-1 primitive. This matches the pre-existing convention (LineChart.css and index.css are px-heavy), so it is a system-level decision rather than a defect of this slice — but landing the setting and six freshly-exempt components in one branch deserves an explicit decision: either convert component font sizes to rem going forward, or ticket the px→rem migration so the setting's coverage is a known quantity. Currently untracked.

### NIT

**N-1. ShowMore is the only primitive stylesheet without a `prefers-reduced-motion` guard.**
`ShowMore.css:23` transitions `background 120ms`; BackButton.css:40-44, Tabs.css:61-66, CollapsibleTile.css:72-77 all guard even color-only transitions. Functionally harmless (color fades aren't vestibular triggers) — pure set consistency.

**N-2. Readonly-props convention inconsistent across the set.**
`FilterSelect` takes `ReadonlyArray<FilterSelectOption>` (`FilterSelect.tsx:33`) — good; `Tabs` takes mutable `TabItem[]` (`Tabs.tsx:49`). Pick one (readonly).

**N-3. FilterSelect: duplicate option values collide React keys.**
`key={opt.value}` (`FilterSelect.tsx:76`) — only `''` is documented as reserved; two options sharing a value would warn and break selection semantics silently. A JSDoc line ("values must be unique") or a dev-mode warning would close it.

**N-4. FilterSelect disabled state dims only the control.**
`FilterSelect.css:50-53` — the label keeps full contrast next to a half-opacity select; minor visual ambiguity about whether the filter applies.

**N-5. ShowMore's text contrast (`--vermilion-ink` on card/page surface) is not covered by `tokensContrast.test.ts`.**
The test asserts hue-ink on hue-soft (chips, `tokensContrast.test.ts:88-106`), `--paper-mute` on ink surfaces (:109-135), and focus-ring vs page (:138+). ShowMore renders `--vermilion-ink` on `transparent` over `--ink`/`--ink-1` (`ShowMore.css:18-19`) — spot-checked manually: coral light #BB183C on white ≈ 6.4:1, dark #FF7190 ≈ 7.3:1, blue #1554DF ≈ 6.3:1, all pass AA — but the automated guarantee has a hole now that a primitive uses an ink twin on a bare surface. Extend the test loop with `--<hue>-ink` on `--ink-1`.

**N-6. SwipeCarousel pre-existing style divergences (NOT introduced here — branch diff is loop + cornerSlot only).**
Template-literal class concat instead of `cn()` (`SwipeCarousel.tsx:275,312`), the set's only `export default` (`:330`), and no `className` prop while the other six accept one. Fine to leave; note for a future consistency pass.

### PRAISE

**P-1. FilterSelect's native-`<select>` decision and its JSDoc rationale** (`FilterSelect.tsx:1-19`) are textbook: skin the closed control only, keep the native popup, reserve `''` for clear-filter, document the caller constraint. The test file exercises every one of those claims with real `userEvent.selectOptions` interactions, including the clear-filter path (`FilterSelect.test.tsx:84-97`).

**P-2. usePagination's render-time clamp instead of effect-based syncing** (`usePagination.ts:56-66`) is the right architecture, and the shrink-then-regrow test (`usePagination.test.ts:98-118`) actually exercises it — including retained-count re-expansion. Degenerate-opts flooring (`:48-52`) with a dedicated test is careful work.

**P-3. ShowMore's hidden-not-disabled choice is argued, not just made** (`ShowMore.tsx:5-14`), and putting the remaining count inside the button label so AT announces it in one breath is a genuinely good a11y call.

**P-4. Uniform documentation discipline across all 7 primitives**: feature-ticket refs (F-0xx), "No I/O — no threat model" security note, colocated-CSS rationale, and contrast notes citing `tokensContrast.test.ts` in every stylesheet header. Rare consistency for a multi-agent branch.

**P-5. Zero global-CSS creep**: `git diff rebuild -- client/src/styles/index.css` is exactly the sanctioned 17-line text-size block, nothing else.

**P-6. Token discipline is clean set-wide**: no hardcoded colors in any new CSS (grep for hex/rgb/hsl across all six new stylesheets: zero hits); accent-as-text correctly uses `--vermilion-ink` which every `[data-accent]` block remaps (`index.css:194+`), so the "accents come free" comments are true, not aspirational.

## Detailed verification notes

- **FilterSelect a11y**: `htmlFor`/`useId` association verified by `getByLabelText` resolving to a SELECT (`FilterSelect.test.tsx:21-32`); placeholder is a real `<option value="">` and the selected state for `value=''` (`:34-53`); custom placeholder covered; `disabled` covered. Keyboard comes free from the native control. Controlled `onChange` fires the raw chosen value once (`:68-82`). Minor test gap: the `value="news"` render (`:84-97`) never asserts `toHaveValue('news')` — the controlled-selection-of-a-real-value direction is implied but not pinned.
- **usePagination boundary math**: `limit = min(max, items.length)`; `visibleCount = min(count, limit)`; `canShowMore = visibleCount < limit`; `showMore` caps at `max` via functional update (no stale closure; deps `[step, max]` correct). exactly-15 → false, exactly-30 after one showMore → false, 14 items → false, empty → false, `max < initial` → cap wins. All correct; see SF-2 for the untested ones.
- **ShowMore**: `canShowMore=false` → returns `null` and the test asserts an EMPTY container, not just button absence (`ShowMore.test.tsx:52-58`); `remaining` ≤ 0 or absent → bare label (`ShowMore.tsx:42-45`); `onShowMore` wired via real click. No `disabled` prop — deliberate and documented (hidden-not-disabled), consistent with its tests.
- **index.html / App.tsx (F-025 wiring, skimmed)**: no-flash bootstrap allow-lists `sm|md|lg` and defaults `md`, matching `DEFAULT_TEXT_SIZE` and the provider's skip-if-already-stamped effect (`TextSizeProvider.tsx:77-81`). Provider mirrors AccentProvider exactly as claimed.

## Coordination observations

1. **Gate script mismatch**: the review brief's `npm run typecheck` does not exist in `client/package.json` (scripts: dev/build/lint/test/test:watch/test:coverage/gen:icons/preview). Typechecking is folded into `build` (`tsc -b && vite build`), which trips the root-owned `node_modules/.tmp` EACCES on tsbuildinfo even without emitting. Either add a `typecheck` script (`tsc -p tsconfig.app.json --noEmit`) or fix `.tmp` ownership; today there is no clean standalone typecheck gate.
2. **Branch scope beyond the 7 primitives** is all F-025 plumbing (`Settings.tsx`, `services/settings.ts`, `types/domain.ts`, `App.tsx`, `index.html`, `text-size-context.ts`, `useTextSize.ts`) — coherent with the phase, no stray changes. Presumably covered by the global-primitives review slice; nothing alarming on skim.
3. **No consumers yet** for FilterSelect/usePagination/ShowMore anywhere under `pages/`/`components/` — expected for a primitives phase, but it means SF-1 costs nothing to fix now and a real bug report later.
4. **SF-3 (px vs rem) intersects the other slice's F-025 review** — whoever reviews the text-size feature should co-own the decision.
