# Overhaul P3a — Language-display engine + Settings control + main-chrome wiring

Build the language-display FEATURE mechanism + Settings UI + wire the high-visibility chrome. The
full ~30-site catalog refactor + Korean authoring for English-only strings + verbage trim = **P3b**.
Ref: `db/docs/SCOUT_language_display.md` (the ad-hoc-rendering map + settings mechanism + boundary rule).

## Model (Jared-confirmed)
- Setting **mode**: `en` (chrome English-only) · `ko` (chrome Korean-only) · `both` (bilingual).
- In `both`: **primary** = `en` or `ko` (which is the MAIN/larger); the other is the SUB (smaller).
- **subScale** (both mode only): the sub's font-size scale relative to the main, e.g. `[0.4, 1.0]`, default `0.7`.
- **Server-synced** (follows the palette pattern — add to prefs, not localStorage).
- **Scope: UI chrome ONLY.** Learning content (vocab/grammar/examples/TOPIK/dictionary/Hanja entries) NEVER changes. RULE: nav/section/heading/button/empty-state labels are chrome (follow the setting) even when the words are skill-domain vocabulary; material text is untouched.

## Data model
Add to the prefs (`server/src/routes/settings.ts` `PrefsSchema.strict()` + client `types/domain.ts` prefs type):
```
languageDisplay: {
  mode: 'en' | 'ko' | 'both',       // default 'both'
  primary: 'en' | 'ko',             // default 'ko' (matches today's "kr · en" order)
  subScale: number,                 // default 0.7, clamp [0.4, 1.0]
}
```
- Prefs are a JSONB/blob merged deep-safe (scout §b) — a new field just needs a default + the Zod entry; NO db migration expected (verify: if prefs are columnar, that's different — check). Existing stored prefs lacking the field fall back to the default via the deep-merge.
- `/settings` is already in the nginx allow-list — no nginx change.

## Client engine
1. **Read the setting from the existing Settings/prefs context** (server-synced via `SettingsProvider`) — expose a selector, e.g. `useLanguageDisplay()` returning the resolved `{mode, primary, subScale}`. Do NOT invent a separate localStorage store; it rides the prefs.
2. **Project subScale to CSS**: set a CSS var (e.g. `--lang-sub-scale`) on `<html>`/`<body>` from the setting (mirror how theme writes `data-theme` / palette writes vars via `applyPaletteVars` + `ALLOWED_VARS`). The sub text sizes off `calc(1em * var(--lang-sub-scale))`.
3. **`<Bilingual en kr />` primitive** (`client/src/components/Bilingual.tsx`): the single chrome-text component.
   - `mode 'en'` → render `en` only. `mode 'ko'` → render `kr` only.
   - `mode 'both'` → main (`primary`) + separator + sub (the other), the sub in `.km-bilingual__sub` sized by the CSS var. Keep the existing "· " separator look. Inline by default; accept a prop or variant for the Topbar title if its layout differs.
   - Fallback: if one language is missing (kr or en absent), render whatever's present (never blank) — important during P3b's incremental catalog fill.
   - a11y: the full bilingual reading stays available (e.g. keep both in the accessible name where BottomNav used aria-label) so screen readers aren't degraded by a single-language visual mode.

## Settings control
`LanguageDisplayControl` in `client/src/pages/Settings.tsx`, in the **Appearance** `SettingsGroup` (above/below `ThemeModeControl` at ~:826), mirroring `ThemeModeControl`'s APG radiogroup pattern:
- A 3-option segmented radiogroup: **English · Korean · Both** (roving tabindex, arrow keys, selection-follows-focus — copy the ThemeModeControl pattern).
- When **Both** is selected, REVEAL: (a) an orientation control (English-first / Korean-first = `primary`), and (b) the **sub-size slider** — a native `<input type="range">` (min 0.4, max 1.0, step 0.05) with a visible label + a live preview of a sample bilingual label resizing. Hidden/disabled when mode ≠ both.
- Writes through the settings/prefs setter (debounced server sync, same as palette). Fixed copy; label it clearly.

## Wire the HIGH-VISIBILITY chrome (P3a scope — the rest is P3b)
Refactor these to feed en/kr through `<Bilingual>` (the KR already exists for all of these — this is splitting baked strings, NOT authoring new Korean):
- **Topbar page titles**: the ~10 pages passing a hardcoded `krTitle={<span>kr · en</span>}` (Today.tsx:299, Topik.tsx:87, Grammar.tsx:601, Hanja.tsx:239, Progress, Review/library, Writing, Diagnostic, Settings, Chat, Mistakes) — pass en+kr to Topbar (revive its unused `title` prop or have it render `<Bilingual>`), so the title follows the setting.
- **BottomNav** tab labels (label/kr) + **LearnMenu** rows (label/kr) → through `<Bilingual>` (LearnMenu already renders both as spans — easiest).
- **The hexagon "LEARN"** label + the Topbar eyebrows for these pages if trivially bilingual.
Leave the ~20 remaining eyebrow/card/section sites for P3b (note them; don't half-do them).

## Tests
- Engine: `useLanguageDisplay` resolves each mode; the CSS var reflects subScale; default when prefs lack the field.
- `<Bilingual>`: en-only / ko-only / both(+primary order)(+sub sized); missing-language fallback; a11y name keeps both.
- Settings control: 3 modes select + persist; Both reveals orientation + slider; slider changes subScale + persists; hidden when not Both.
- Server: PrefsSchema accepts the field, rejects bad values (`.strict()`), defaults applied, round-trips GET/PUT.
- Wired chrome: Topbar title + a nav label render EN-only / KO-only / both per the setting.

## Verify
Client: `tsc -b --force`=0, `lint`=0/0, `vitest run` all pass, `build`=0. Server: the settings route tests + PrefsSchema tests green (run the server settings suite).

## Then
/fixpass P3a (the engine correctness, the setting persists + applies live, a11y not degraded by single-language mode, no chrome-vs-content leak, the wired chrome responds). Deploy. Then P3b (full catalog + Korean authoring + verbage trim).
