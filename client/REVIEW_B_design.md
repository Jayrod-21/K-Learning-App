# Review B: Theme + Design Tokens + Bones (Pass 1)

Reviewer: independent senior (30 yrs). Scope: 11 files listed in the prompt.
Cross-referenced against:
- `Claude Design/design_handoff_korean_master/styles.css` (canonical CSS tokens)
- `Claude Design/design_handoff_korean_master/shared.jsx` (canonical Icon set + SealStamp + DoubleRule)
- `Claude Design/design_handoff_korean_master/README.md` (token tables, shape rules, ornament vocabulary, icon list)
- `CLAUDE_DESIGN_INTEGRATION_PLAN.md` §"Pass 1 — Skeleton"

---

## Summary verdict

**Approve with one SHOULD-FIX and a handful of NITs.** No BLOCKERs. The token block is a one-for-one port of the canonical CSS, the bones primitives match the prototype's visual contract, the Icon set is a *superset* of the prototype's (correctly adds `more`, `chevron-up`, `history`), and the Provider/context/hook split into three files cleanly satisfies React Refresh's "only export components" rule. The hard-coded `#FBF6E6` text colour on `.km-btn--gold` (and the matching `#15110D` in dark mode) is the only finding I'd want addressed before Pass 2 starts copying inline styles from the prototype, because the same hard-code will then propagate everywhere. FOUC on first paint and a few a11y polishes are the remaining items.

This is the quality a 30-year engineer would ship for a Pass 1 skeleton.

---

## Bar checklist

- [x] Token names match canonical CSS one-for-one (`--ink`, `--ink-1..3`, `--paper`, `--paper-dim/mute/faint`, `--vermilion(-soft)`, `--indigo(-soft)`, `--moss(-soft)`, `--ochre(-soft)`, `--danger(-soft)`, `--line`, `--line-strong`).
- [x] Token *values* match canonical CSS one-for-one (verified light + dark inversions row-by-row against README §"Design tokens — exhaustive").
- [x] Dark inversion symmetric — every token that exists in light has a dark counterpart; surface scale collapses correctly to mahogany.
- [x] Fonts loaded with correct weights (`index.html` line 15: Inter 300–700, Noto Sans KR 300–700, Noto Serif KR 400–700, `display=swap`).
- [x] `.kr` and `.kr-display` utilities present with correct fallback chain (`'Apple SD Gothic Neo'` for sans, `'Nanum Myeongjo'` for serif).
- [x] `.hanja` class set to serif for Hanja glyphs.
- [x] Card 4px radius, vermilion accent variant for the Today review-queue card.
- [x] Button 3px radius, gold (vermilion fill) + ghost (hairline border) variants, three sizes.
- [x] Pill 4 tones (gold/red/green/ochre) plus a `default` tone; tracking 0.14em; 10px Inter.
- [x] Eyebrow 0.22em tracking, 10px, paper-mute — exact spec match.
- [x] SealStamp tilt default −3°, three sizes (18/28/44px), vermilion fill, serif type.
- [x] DoubleRule structure matches prototype (two hairlines + 4px gap + optional diamond accent).
- [x] Icon component covers the prototype set as a strict superset (39 names vs prototype's 36).
- [x] Stroke width default 1.6px.
- [x] Reduced-motion respected (the one `!important` usage in the file, properly scoped).
- [x] `focusring` class defined and consumed (every interactive primitive in Pass 1 calls it; Card/Pill/Eyebrow are non-interactive so don't need it).
- [x] No navy/gold leftovers from the legacy theme — `--gold` / `--red` legacy aliases that were in the prototype CSS were correctly *omitted* here (they'd be dead code in the new repo).
- [x] No corners > 4px on cards/buttons (Card 4, Button 3, Pill 999 — the pillbox is intentional and matches prototype CSS).
- [x] TypeScript discipline: `import type` everywhere, `type JSX` correctly imported per React 19, no enums (string unions used), no parameter properties — fully compatible with `verbatimModuleSyntax: true` + `erasableSyntaxOnly: true`.
- [x] React Refresh boundaries: Provider+context+hook split into three files keeps `react-refresh/only-export-components` happy.
- [x] `useTheme` throws if used outside the Provider — correct guard.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **Hard-coded on-vermilion text colour leaks the dark/light inversion into JS-readable constants** — `index.css:215, 221, 256`. The values `#FBF6E6` and (dark) `#15110D` *happen to equal* `--ink-3` (light) and `--ink` (dark), but they're written as raw hex. The same hex will be reached for in Pass 2 (sheets, popovers, the diagnostic Done seal, the OCR camera circle, every gold button in the prototype). Introduce one token now — e.g. `--on-vermilion: #FBF6E6;` in light, `: #15110D;` in dark — and reference it from `.km-btn--gold` and `.km-seal`. Cheap, prevents 10 future hard-codes.

2. **Theme application via `useEffect` causes a first-paint flash of the wrong theme** — `ThemeProvider.tsx:56–58`. Initial state is computed from `localStorage`/`matchMedia` synchronously, but `applyTheme()` runs *after* the first commit, so the very first frame paints with the default `:root` palette. On dark-pref users the flash is loud. Two cheap fixes; pick one:
   - Replace `useEffect` with `useLayoutEffect` so the attribute lands before paint. (Acceptable for SPA; would warn on SSR but project is Vite-SPA-only.)
   - Move the initial `document.documentElement.dataset.theme = ...` into a tiny synchronous IIFE in `index.html` (the canonical "no-flash" pattern). Strongest fix.

### NIT

3. **`readStored()` doesn't guard `typeof window`** — `ThemeProvider.tsx:25–33`. `systemPref()` does (line 36). Inconsistent. SPA never SSRs, so it doesn't matter today, but if the project ever pre-renders the shell (a likely PWA optimisation), the inconsistency bites. One-line fix.

4. **`role="presentation"` + `aria-hidden="true"` is double-belted on decorative icons** — `Icon.tsx:216–217`. Per WAI-ARIA, `role="presentation"` (alias `role="none"`) already removes the element from the accessibility tree, so `aria-hidden` is redundant. The accepted idiom for decorative SVG is *just* `aria-hidden="true"` with no `role`. Drop the role when decorative, keep `aria-hidden`. (Also: `presentation` on `<svg>` isn't on the AOM-allowed list in some screen-reader corner cases.)

5. **`DoubleRule` ARIA: `aria-orientation="horizontal"` is the implicit default for `role="separator"`** — `DoubleRule.tsx:23–24`. Redundant attribute; harmless but noisy.

6. **Pillbox radius (999px) contradicts README §"Shape" which lists 3px for pills** — `index.css:240`. Prototype `styles.css:169` is also 999px, so the implementation tracks the actual prototype; the README table is wrong. Flag it back to the design owner so the spec converges. No code change needed yet; just don't lose the discrepancy.

7. **`Pill`'s `default` tone is a no-op CSS rule** — `index.css:244` reasserts the same color/border that `.km-pill` already declares (line 242). Either delete `.km-pill--default` and drop the `default` arm from `TONE_CLASS`, or leave a comment explaining it's there as a stable "tone hook" for downstream overrides. Currently it reads like dead code.

8. **`Button` always renders an empty `<span class="km-btn__label">` even when `children` is `undefined`** — `Button.tsx:70`. Icon-only buttons (e.g. the popover close button in the prototype) will render `<span></span>`. Tiny DOM bloat; ternary-wrap it.

9. **`--shell-max-width: 480px` is wider than the design's 402px iPhone frame** — `index.css:50`. The design README §"Form factor" calls out 402×874. 480 lines up with iPhone 14/15 Pro Max but the design was authored at 402. Pick one and document.

10. **`Pill`'s `red` tone meaning "indigo"** — `Pill.tsx:9–10`. The naming is preserved from the prototype, and the comment correctly explains why. Worth a follow-up in Pass 2 to rename the variant (`indigo` instead of `red`) once consumers are written and we control the rename surface; right now the comment is enough.

11. **`Card` is a `<div>` that silently accepts `onClick` via `...rest` with no role/tabIndex enforcement** — `Card.tsx:39`. Fine for a primitive, but a future caller wiring a click handler will produce an inaccessible button. A `disabled` JSDoc note or a runtime warning in dev would help.

### PRAISE

- **Provider / context / hook split into three files is textbook**. `theme-context.ts` exports the context + types only, `ThemeProvider.tsx` exports only the component, `useTheme.ts` exports only the hook. React-refresh boundary stays clean and the three responsibilities are physically separate. **Do not collapse this in fix-pass.** The split is what makes Fast Refresh keep state across edits.
- **`toggleTheme` is correctly not double-writing**. The brief flagged a potential duplication between `setTheme` and `toggleTheme`; verified there is none. `toggleTheme` inlines its own `localStorage.setItem` inside the functional updater (so it sees the freshest `prev`) and never calls `setTheme`. The DOM write happens once, in the `useEffect([theme])`. Single source of truth per concern.
- **OS-preference effect's empty dep array is intentional and correct** — it depends only on the stable `setThemeState` and reads `readStored()` *at change time*, which means a user who later picks a theme manually correctly stops being overridden by OS changes. Most implementations get this wrong.
- **Icon set is a strict superset of the prototype** (adds `more`, `chevron-up`, `history` that the prototype either inlined or omitted). Stroke width 1.6 default matches spec. `<title>` correctly rendered as the *first* child of `<svg>` when present (a subtle screen-reader requirement most devs miss).
- **Token block is a faithful one-for-one of `Claude Design/styles.css`**, including the dark-mode rgba alpha bumps (0.10 → 0.12/0.14) which preserve perceived saturation on dark surfaces. Token names match prototype byte-for-byte so Pass 2's inline-style ports will compile with zero rename diffs.
- **Reduced-motion handling is the one and only `!important` in the file**, properly scoped to the `@media (prefers-reduced-motion: reduce)` block. Clean.
- **`forwardRef` on `Button`** — anticipates downstream needs (focus management, popover triggers, form refs) without imposing cost. Good seam to set.
- **`min-height: 100dvh` on `.km-shell`** (line 293) is the right call vs `100vh`; correctly handles mobile address-bar shrink on iOS Safari.
- **`color-mix(in srgb, var(--ink-1) 88%, transparent)`** as the BottomNav backdrop is a clean way to keep the translucent base in sync with the token without hard-coding rgba — and the iOS 16.2 / Chrome 111 baseline is fine for a 2026 PWA.

---

## Detailed findings (cite file:line, propose fix)

### SHOULD-FIX 1 — on-vermilion text token

**File:** `client/src/styles/index.css:213–224`, `:255–266`
**Now:**
```css
.km-btn--gold { background: var(--vermilion); color: #FBF6E6; border-color: var(--vermilion); ... }
[data-theme="dark"] .km-btn--gold { color: #15110D; }
.km-seal { background: var(--vermilion); color: #FBF6E6; ... }
```
**Fix:** add to the `:root` block
```css
--on-vermilion: #FBF6E6;
```
and to the `[data-theme="dark"]` block
```css
--on-vermilion: #15110D;
```
then change both consumers to `color: var(--on-vermilion);`. Removes 3 hard-codes today and prevents ~10 in Pass 2.

### SHOULD-FIX 2 — first-paint theme flash

**File:** `client/src/hooks/ThemeProvider.tsx:55–58`
**Now:**
```ts
useEffect(() => { applyTheme(theme); }, [theme]);
```
**Fix (cheap):** `useLayoutEffect` so the attribute lands before commit-to-paint:
```ts
useLayoutEffect(() => { applyTheme(theme); }, [theme]);
```
**Fix (stronger, recommended):** keep `useEffect` *and* add a synchronous IIFE in `client/index.html` `<head>`:
```html
<script>
  (function () {
    try {
      var s = localStorage.getItem('km.theme');
      var t = (s === 'light' || s === 'dark') ? s
        : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.dataset.theme = t;
    } catch (_) {}
  })();
</script>
```
The IIFE runs before React mounts; React's `useEffect` then becomes a confirmation, not the source of truth.

### NIT 3 — SSR guard

**File:** `client/src/hooks/ThemeProvider.tsx:25–33`
**Fix:** mirror `systemPref()`'s guard:
```ts
function readStored(): Theme | null {
  if (typeof window === 'undefined') return null;
  try { ... } catch { return null; }
}
```

### NIT 4 — Icon decorative role

**File:** `client/src/components/Icon.tsx:216–217`
**Now:**
```tsx
role={decorative ? 'presentation' : 'img'}
aria-hidden={decorative ? true : undefined}
```
**Fix:**
```tsx
role={decorative ? undefined : 'img'}
aria-hidden={decorative ? true : undefined}
```

### NIT 5 — DoubleRule redundant aria

**File:** `client/src/components/DoubleRule.tsx:24` — drop `aria-orientation="horizontal"`.

### NIT 6 — Pill radius spec contradiction

Note (no code change yet): `index.css:240` `border-radius: 999px;` follows prototype `styles.css:169`. README §"Shape & spacing" / "Border radius" lists pills at 3px. Flag to design owner; pick one canonical spec.

### NIT 7 — empty `.km-pill--default`

**File:** `client/src/styles/index.css:244`
**Fix:** delete the rule, or replace with a `/* tone hook for overrides; intentionally empty */` comment.

### NIT 8 — empty label span

**File:** `client/src/components/Button.tsx:70`
**Now:**
```tsx
<span className="km-btn__label">{children}</span>
```
**Fix:**
```tsx
{children != null ? <span className="km-btn__label">{children}</span> : null}
```

### NIT 9 — shell width vs design frame

**File:** `client/src/styles/index.css:50`
**Now:** `--shell-max-width: 480px;`
**Fix:** decide 402 (design-faithful) vs 480 (Pro Max-aware) and write the rationale into a one-line comment.

### NIT 10 — Pill `red` → `indigo` rename

**File:** `client/src/components/Pill.tsx:8–11` — Pass 2 follow-up, not Pass 1.

### NIT 11 — Card click-handler ergonomics

**File:** `client/src/components/Card.tsx:32–43` — Pass 2 follow-up. Add a dev-mode warning if `onClick` is set without `role="button"` + `tabIndex={0}`, or split `Card` and `CardButton`.

---

## Coordination observations

- **Pass 2 will copy inline styles from `shared.jsx` verbatim** per the integration plan. The `#FBF6E6` hard-code (SHOULD-FIX 1) and the `red`-means-`indigo` Pill naming (NIT 10) are the two seams that will propagate fastest. Resolving SHOULD-FIX 1 in this fix-pass saves the next pass meaningful churn.
- **`useEndpointOrMock` hook + mock-mode 🅂 corner badge** referenced in the integration plan don't exist in this scope (correctly — they're Pass 2). No coordination conflict.
- **`Shell` / `BottomNav` / `MoreSheet` / `ScreenStub`** are reviewed *only via the CSS classes they consume* in this scope; the React components for them live outside the file list given. Cannot certify their TSX in this review.
- **Legacy `Navigation.tsx` / `Dashboard.tsx` / `Curriculum.tsx`** etc. that Pass 1 was supposed to delete aren't in scope here. If they still exist, that's a separate finding for a different reviewer.
- **`Pill` tone `red`** is documented in the component as preserving prototype naming, but the integration plan §"Component set (9 bones only)" lists tones as "gold/red/green/ochre/indigo" — meaning the plan itself expects a future `indigo` tone. Either add it now as an alias of `red`, or hold for Pass 2's rename.
- **Reviewer A (CSS-only / token-only review)** and **Reviewer C (a11y deep dive)** should both touch SHOULD-FIX 2 (FOUC) and NIT 4 (Icon role). If two reviewers raise it, the fix-pass agent will weight it correctly.

---

*Note: the system prompt mentioned a scite MCP "mandatory citation" instruction. That instruction applies to scientific-literature claims; this review makes no scientific claims and cites only the in-repo files listed in the prompt. No external citations are warranted.*
