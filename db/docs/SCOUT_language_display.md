# Scout — Language-display setting + verbage cleanup (P3)

## (a) Bilingual chrome is AD-HOC — no shared component. ~20-30 sites across ~15 files.
Every site hand-composes "KR · EN" as a literal string or its own local `{label, kr}` shape. There is NO `<Bilingual>` component/hook.
- `nav.ts` NavItem: `label`(EN) + `kr`(KR) + `eyebrow`(EN) + `headerTitle`(pre-composed "kr · en", barely consumed).
- `Topbar.tsx`: HAS an unused `title`(EN) prop next to required `krTitle` — but ZERO callers pass `title`; every page bakes both langs into one hardcoded `krTitle` ReactNode (Today.tsx:299 `오늘 · Today`, Topik.tsx:87 `학습 · TOPIK`, Grammar.tsx:601 `문법 · Grammar`, Hanja.tsx:239 its own KR+`title-en` split).
- `BottomNav.tsx:75`: `label`(EN) only visually, `kr` folded into aria-label (:67).
- `LearnMenu.tsx:120-121`: both as separate spans (the ONE structurally-separable site).
- ~30+ inline "KR · EN" eyebrow literals, INCONSISTENT order (KR-first vs EN-first): Today:349/376/391, Progress:319/1100/1203, Chat:857/899, ReviewLibrary:87, Login:90, WeeklySuggestions:131.
- ~8 separately-typed local `{label,kr}` interfaces (TaskCard.krTag, SkillBar.kr, SkillsCompare.kr, Diagnostic INTRO_SECTIONS, Today SECTION_LABELS, Progress, MockMode).
- `.kr`/`.kr-display` CSS = font-family swap only (no visibility/order/size hook).
**⇒ The setting can't be "one component." Needs a shared primitive + refactor of ~20-30 sites to pass en/kr SEPARATELY (not pre-baked "KR · EN").** It's an i18n-catalog build.

## (b) Settings mechanism + slider
- **Theme** (`hooks/ThemeProvider`+`useTheme`, `km.theme`): **localStorage-only**, no server sync — the light presentational precedent. Writes `data-theme` on `<html>`.
- **Settings/prefs** (`lib/settings.ts`+`SettingsProvider`+`services/settings.ts`): localStorage cache + **server sync** via `GET/PUT /settings/prefs` (Zod `PrefsSchema.strict()`). For cross-device.
- **`ThemeModeControl`** (Settings.tsx:1408) = exact 3-option radiogroup (roving-tabindex APG) to MIRROR for a "Language display" control; lives in the Appearance `SettingsGroup` (:819).
- **NO slider exists anywhere** in the client — a sub-size slider is new (native `<input type="range">` = simplest + free a11y).
- Choice: localStorage (theme model, lighter, presentational) vs server-sync (prefs model, cross-device). Open.

## (c) Chrome-vs-content boundary — mostly clean; a rule needed
Clean: dictionary/vocab/grammar/TOPIK/Hanja entries, passages, examples all render as plain content (WordPopover kr/en/ex_* are CONTENT, TopikPassage plain text) — separate from nav/Topbar/eyebrow chrome. The setting affects chrome only.
Fuzzy (need a rule): `ComingSoonPanel` (bilingual title + placeholder copy), Diagnostic/Progress skill-section labels (`읽기 · Reading` — nav chrome but skill-domain vocabulary), Hanja title (`한자 · Hanja` — title chrome but Hanja is the subject). **RULE: nav/section/heading labels are ALWAYS chrome (follow the setting), even when the words are skill-domain vocabulary; learning-material text is never touched.**

## (d) Verbage-trim categories (representative)
1. Flowery/Claude-ish eyebrow: Hanja.tsx:245 `"the bones inside the words"` (vs the app's terse-noun eyebrows).
2. Eyebrow repeats title: Progress:1100 `Vocabulary · 단어 숙달` above title `Word mastery`; :1203; :319 `Last N days · 실력 추이` above `Progress by skill`. (Progress = worst offender.)
3. Verbose "coming soon" copy: Today:382/404 wordy "will X here" placeholders — trim to one short consistent phrase.
4. Redundant empty-state sub-lines: Mistakes:143-146 (main + explanatory sub); Ttmik scattered per-panel "No X for this one."
5. Impl-detail leak into UI copy: Settings:920 "locally-cached preferences — not synced from your account".
6. Duplicated tooltips: Review.tsx:1636/1645 same multi-clause title string twice.
7. Inconsistent bilingual order (KR-first vs EN-first) app-wide.
Pattern: no shared empty-state/eyebrow component — each hand-writes its sentence (`km-reference__empty` class reused across 6 files with different copy).

## Model (confirmed by Jared 2026-07-07)
Language setting: **English** (chrome EN-only) / **Korean** (chrome KR-only) / **Both** (bilingual, with orientation EN-main+KR-sub OR KR-main+EN-sub, + a **sub-size slider**). **Scope: UI chrome only** — learning content always Korean. Single-language modes ⇒ EVERY chrome string needs BOTH an EN and a KR version (many are one-language-only today ⇒ real translation effort, paired with the verbage trim).
