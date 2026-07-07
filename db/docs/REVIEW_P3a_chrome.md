# REVIEW — P3a Settings control + wired chrome (commit 350f099)

Reviewer: independent senior (React + a11y). Slice: `LanguageDisplayControl` + extracted
`SegmentedRadioGroup` + slider in `client/src/pages/Settings.tsx`; `Topbar.tsx`; wired page
titles/h1s (Today/Topik/Grammar/Hanja/Writing/Settings/Chat/Mistakes/ReviewLibrary/Progress/
Diagnostic); `BottomNav.tsx`; `LearnMenu.tsx`; their tests. Bilingual/hook/server internals = R1,
assumed working (read for interface only).

## Verdict: **PASS — 0 BLOCKER, 2 SHOULD-FIX, 4 NIT**

Verified run (docker node:20-slim): `tsc -b --force`=0, lint=0, vitest 4 files **53/53 pass**
(Settings.test.tsx, Topbar.test.tsx, BottomNav.test.tsx, LearnMenu.test.tsx).

## Probe answers (definitive)

**(a) Slider preview instant, not debounced — CONFIRMED.**
`onChange` → `clampSubScale` → `updateSettings` (synchronous provider setState) →
`SettingsProvider.tsx:191-196` effect sets `--lang-sub-scale` on `<html>` on the commit
immediately after that state change. Only the PUT rides `PREFS_DEBOUNCE_MS` in the
Settings-screen change-effect (`Settings.tsx:667-691`). The CSS var is NOT gated behind the
debounce — the test proves it: `Settings.test.tsx` "dragging the slider…" asserts
`document.documentElement.style.getPropertyValue('--lang-sub-scale') === '0.5'` BEFORE
`vi.advanceTimersByTime(500)`, then asserts exactly 1 PUT after. Preview sample is a real
`<Bilingual kr="오늘" en="Today">` sizing off the var (`Settings.tsx:1776-1780`).

**(b) Wired titles respond per mode + the 3 fixed aria ids — CONFIRMED.**
- `Topbar.tsx:61` — h1 renders `<Bilingual kr en>` when both props are strings; en mode →
  English-only visible, ko mode → Korean-only, both → primary + sized sub. Covered directly in
  `Topbar.test.tsx` (all 3 modes + primary flip + legacy-ReactNode passthrough). Non-Topbar h1s
  (Progress.tsx:438, Diagnostic.tsx:296+1066) render `<Bilingual>` inside the SAME h1 — heading
  role/level and id preserved on every wired page; no page lost its heading semantics.
- 3 previously-dangling ids RESOLVE: verified at `350f099^` that `km-settings-title`,
  `km-hanja-title`, `km-mistakes-title` appeared only in the section's `aria-labelledby` (0 id
  attrs anywhere in those files). Post-commit `titleId` stamps the id on the rendered h1 itself
  (`Topbar.tsx:61`; asserted by `Topbar.test.tsx` `h1.id === 't'`). Name computation stays
  bilingual in single-language modes: the visible half is `aria-hidden` but the `.km-sr-only`
  span is included by the labelledby traversal, so the section name is "kr · en" in every mode.
- Remaining un-migrated Topbar callers (Ttmik, Reading, Review, Images, review/*) still pass a
  pre-composed ReactNode and render verbatim — correct P3b boundary, nothing silently dropped
  (no caller passed the old `title` subtitle prop; its removal is dead-code cleanup).

**(c) Judgment calls** — see SHOULD-FIX-1 + the two KEEP verdicts below.

## Findings

### SHOULD-FIX

**SF-1 — BottomNav 'both' sub-text is 7px (and can reach 4px); pairs may ellipsize.**
`styles/index.css:581-592` — `.km-bottomnav__label` is 10px uppercase; the sub renders at
`calc(1em * var(--lang-sub-scale))` = **7px** at the 0.7 default, **4px** at the slider min 0.4.
7px uppercase Inter is below any practical legibility floor — at default settings the English
half of every tab ("오늘 · TODAY") is decoration, not text. The nowrap/ellipsis guard correctly
protects the bar's layout, but the longest pair ("성장 · PROGRESS") is at clipping risk in
~72px cells on 360px viewports. Fix options (either is small): scope a floor in the nav context
— `.km-bottomnav__label .km-bilingual__sub { font-size: max(calc(1em * var(--lang-sub-scale, 0.7)), 8px); }`
— or pass `compact` on the tab labels like the hexagon (primary-only; aria-label already carries
both at `BottomNav.tsx:68`). Not a blocker: personal app, layout never breaks, and the setting
itself lets the user escape it.

**SF-2 — The extracted `SegmentedRadioGroup`'s keyboard contract has no test of its own.**
`Settings.tsx:1569-1655` re-implements the roving-tabindex/arrow-key/Home/End handling (it is a
faithful copy — I diffed it against `ThemeModeControl` by eye: same wrap math, same
selection-follows-focus). But the only arrow-key test in the suite
(`Settings.test.tsx:826` "single roving Tab stop…") targets the **Theme mode** radiogroup —
i.e. the OLD copy. A future regression in the new component (which now backs TWO radiogroups:
mode + orientation) would pass the suite. Add one keyboard test against
`radiogroup 'Language display'` (arrows advance + wrap + aria-checked follows focus), or do the
P3b fold of ThemeModeControl onto it so the existing test covers the shared code.

### NIT

**N-1** — `lib/settings.ts:128-129` comment claims "an existing user sees zero visual change
until they touch the control". True for Topbar titles (baked "kr · en" ≡ both/ko-first) but
FALSE for BottomNav tabs (visible label was English-only `it.label`) and the hexagon (was
hardcoded "LEARN") — both visibly change at the default. Intended per spec, but fix the comment.

**N-2** — Asymmetric rolling-deploy guard: hydration defends with
`fresh.languageDisplay ?? DEFAULT_SETTINGS.languageDisplay` (`Settings.tsx:641-642`) but
`flushPrefs` adopts the PUT echo unguarded (`lastSyncedPrefsRef.current = stored`,
`Settings.tsx:586`) — a `stored` lacking the field would make the next
`languageDisplayEqual(current, undefined)` throw. Unreachable in practice: a pre-P3a server's
`PrefsSchema.strict()` 400s the PUT (unknown key) before any echo, and the catch path handles
that. Harmless; note it or mirror the guard.

**N-3** — Slider `aria-valuetext` (the % readout, `Settings.tsx:1760`) is implemented but never
asserted; the visible `%` span is correctly `aria-hidden` so `aria-valuetext` is the ONLY
percent surface for AT — worth one assertion.

**N-4** — `SegmentedRadioGroup`'s arrow keys move relative to `selectedIndex`, not a tracked
focus index. Correct under selection-follows-focus (focused ≡ selected), just brittle if anyone
later splits selection from focus. Comment-level.

### PRAISE

- **Test moves strengthened, not weakened**: all 4 relocated page-title assertions
  (Chat/Today/Writing/ReviewLibrary `.test.tsx`) went `getByText(...)` →
  `getByRole('heading', { level: 1, name: ... })` — they now pin role, level, AND accessible
  name where the old ones pinned only text presence.
- **BottomNav a11y is exactly right**: `aria-label={`${it.label} · ${it.kr}`}`
  (`BottomNav.tsx:68`, hexagon `:100`) keeps both languages in every visual mode, and the
  visible label is always a substring of the name in all 3 modes × 2 orientations
  (WCAG 2.5.3 holds everywhere) — with mode-matrix tests including a cloned-DOM
  `visibleText()` helper that excludes sr-only duplicates.
- **`ThemeModeControl` genuinely untouched** (diff hunk boundaries confirm; body identical) —
  own refs/handlers, zero shared state with the extraction; its keyboard test still passes.
- Defense-in-depth on `subScale` (clamp at merge, at the selector, at the provider's CSS-var
  write, and before PUT) means no path NaN-poisons the cascade or 400s the server.
- The Both-only sub-controls unmount cleanly when mode ≠ both (asserted both directions), and
  hydration-does-not-echo-a-PUT is asserted for this field specifically.

## Judgment calls (asked)

**Hexagon shows 배움 by default — KEEP.** With `compact` + default `primary:'ko'` the hexagon
flips from the pre-P3a "LEARN" to 배움. For a public app with cold-start English users I'd call
this a mistake; here the user base is Jared + invited friends (public onboarding explicitly
descoped), the owner is the Korean learner, the icon + position + `aria-label="Learn · 배움"`
all still identify it, and 'en' mode restores "LEARN" in one tap. Primary-follows-orientation is
also the only self-consistent reading of `compact` — hardcoding EN would make the hexagon
ignore the very setting the rest of the bar obeys. If friends ever report confusion, the fix is
their mode toggle, not code.

**LearnMenu inline rows — KEEP.** The old fixed layout (EN main left, small muted KR pinned
right) is now a single left-aligned `<Bilingual>` pair (`LearnMenu.tsx:124-131`), with the sub
muted via `.km-learnmenu__row .km-bilingual__sub` (`index.css:711`). All 3 modes read well:
en → clean English list; ko → Korean at full 15px row weight (better than the old 11px
right-column treatment ever gave it); both → "단어 카드 · Flashcards" scans naturally and now
honors orientation. Losing the right-aligned KR column removes a second alignment axis, which
on a 5-row menu is a simplification, not a loss. Matches the rest of the chrome. No layout
break: `flex: 1; text-align: left` keeps icon/text geometry identical.

## Verification evidence

```
TC=0  LINT=0
Test Files  4 passed (4)
Tests       53 passed (53)
```
(docker node:20-slim, `npm ci` + `tsc -b --force` + `eslint` + targeted vitest, 2026-07-07)
