# Overhaul P3b — finish the language-display wiring + Korean chrome + verbage trim

P3a built the engine + `<Bilingual>` + Settings control + main chrome. P3b finishes it. THREE
file-disjoint batches (parallel). Ref: `db/docs/SCOUT_language_display.md` (§a sites, §d verbage),
`db/docs/KOREAN_CHROME_GLOSSARY.md` (USE for every recurring term — consistency across batches),
`client/src/components/Bilingual.tsx` (the primitive — already handles en/ko/both/compact/fallback/a11y).

## Rules (ALL batches)
- **Wire bilingual chrome through `<Bilingual en kr />`.** For sites that ALREADY have both languages (baked "kr · en" strings, `{label, kr}` shapes), split into en + kr and render via `<Bilingual>`. Never hand-compose "kr · en" strings anymore.
- **Shared components keep their PROP CONTRACT, render `<Bilingual>` INTERNALLY.** A component that takes `{label, kr}` (or `krTag`) keeps that prop shape but renders `<Bilingual en={label} kr={kr}>` inside — so pages that PASS to it need NO change (avoids cross-batch coupling). Do NOT change a shared component's props.
- **Translate English-only chrome to Korean** using the glossary (recurring terms verbatim; new terms in the same register + ADD to your report). Every chrome label/heading/button/empty-state that's currently EN-only gets a `kr`. For a THROWAWAY/rare string with no natural short Korean, leave EN + FLAG it (the primitive's fallback renders EN in ko-mode — a documented long-tail top-up, acceptable).
- **CONTENT is never touched**: vocab/grammar/examples/TOPIK/dictionary/Hanja entries, passages, WordPopover kr/en — all stay. Only chrome (nav/titles/headings/buttons/eyebrows/empty-states) responds to the setting.
- **Trim verbage** in your scope (SCOUT §d): cut eyebrows that repeat their title, replace flowery/Claude-ish copy with terse standard app copy, shorten verbose "coming soon"/empty-state sentences, remove impl-detail leaks + duplicated tooltip strings. Do it inline — do NOT introduce a new shared component in P3b (keep batches disjoint; the shared-empty-state consolidation is a later follow-up).
- **CSS**: avoid new CSS (reuse existing classes + `<Bilingual>`). If unavoidable, scope it + note it (index.css is shared — flag any edit).
- Strict TS, ESLint strict (react-refresh: no non-component exports from component files). Tests: for each wired site, assert it renders per mode (or at least both-mode + the Korean present); for each trimmed string, update the test. Don't weaken tests.

## Batch A — shared components + nav.ts eyebrows (owns these files; B/C only PASS to them)
- `client/src/lib/nav.ts`: the `eyebrow` fields (EN) — add a `krEyebrow` (or reshape to `{en,kr}`) so eyebrows can be bilingual; translate each. (Consumers render via `<Bilingual>`.)
- Wire these SHARED components to render `<Bilingual>` internally (keep props): `TaskCard` (`label`/`krTag`), `SkillBar` (`kr`), `SkillsCompare` (`kr`), `ComingSoonPanel` (Today's — title/kr + trim the verbose copy), `WeeklySuggestions` (`이번 주 · This Week` eyebrow), `LibrarySubnav`, and the `Eyebrow` component if one exists. Translate any EN-only strings in them.
- Trim: ComingSoonPanel wordy copy → one terse line.

## Batch B — Today / Progress / Diagnostic (owns Today.tsx, Progress.tsx, Diagnostic.tsx + their CSS)
- Wire page-local bilingual chrome through `<Bilingual>`: Today eyebrows (349/376/391) + `SECTION_LABELS`; Progress eyebrows (319/1100/1203); Diagnostic `INTRO_SECTIONS` (867-873, `읽기 · Reading` etc. — section labels = chrome per the rule) + intro/results copy.
- **Trim (Progress = worst offender):** eyebrows that repeat their title (Progress `Vocabulary · 단어 숙달` above `Word mastery`; `Grammar · 문법 숙달`; `Last N days · 실력 추이` above `Progress by skill`) — cut the redundant eyebrow or the redundant title, keep one. Today's ComingSoon copy is Batch A's (the component) — B just passes props.
- Translate any EN-only headings/buttons/empty-states on these pages.

## Batch C — Review library + remaining pages + Chat/Settings (owns those files; NOT Today/Progress/Diagnostic/shared-components/nav.ts)
- Topbar titles not yet wired: `Review.tsx` (flashcards), `Ttmik.tsx`, Reading placeholder, `Images.tsx`, `Topik.tsx` (confirm), + eyebrows on these.
- Review library: `ReviewLibrary.tsx` rows (label/kr → `<Bilingual>`; the `Library · 자료실` eyebrow), `review/*` page headings/subnav labels, `MyVocabLists` chrome.
- `Chat.tsx` eyebrows (857 `Reply · 합쇼체`, 899 `Dictionary · 사전`), `Settings.tsx` (section headings + **cut the impl-leak line** `"locally-cached preferences — not synced from your account"`), `Login.tsx` (90 `한국어 마스터 · Korean Master`), `Mistakes.tsx` (trim the double empty-state sub-line), `Writing.tsx`, `Hanja.tsx` (**cut the flowery `"the bones inside the words"` eyebrow** → terse), `Ttmik.tsx` (consolidate scattered "No X for this one." empty-states inline).
- Trim: dup tooltip in `Review.tsx:1636/1645`; `TopikImageNote` wordy eyebrow.
- Translate EN-only chrome on all these using the glossary.

## Verify (each batch, green): client `tsc -b --force`=0, `lint`=0/0, `vitest run` all pass, `build`=0.

## Then
/fixpass P3b (a spot-check that every wired site responds to en/ko/both, the Korean reads naturally + consistently with the glossary, no content got translated, no verbage-trim dropped needed info, no shared-component contract broke). Deploy. Collect all batches' flagged/uncertain Korean into ONE list for Jared to verify. Then P3 done → P4 (features) / P5 (visual) / P6 (data).
