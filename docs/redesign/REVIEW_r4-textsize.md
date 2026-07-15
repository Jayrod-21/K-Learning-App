# Review: B-036/F-086 px→rem

Reviewer: independent senior review (read-only), commit `15fcbf3` on `feat/phone-round4`, diffed against `18b8c2c`.

## Summary verdict

**PASS**

This is a clean, mechanically precise sweep. I extracted every `-px` → `+rem` pair in the diff programmatically (407 paired hunks, 412 individual `font-size` declarations) and verified each conversion's arithmetic against `N/16` exactly — zero mismatches, zero rounding drift. I separately scanned the full diff for any `rem` unit landing on a non-`font-size`/non-`fontSize` property (borders, padding, margin, width, height, gap, box-shadow, letter-spacing, radius, positioning, `@media` breakpoints) — zero scope leaks found; every non-font-size px value on a touched line was left byte-for-byte unchanged. `line-height` and `letter-spacing` are untouched everywhere they co-occur with a converted `font-size`. All four `clamp()` sites converted both bounds correctly while leaving the `vw` preferred-value component untouched. The two intentional-fixed px exceptions (`MockBadge.tsx`, `Images.tsx`) are legitimately non-user-facing (aria-hidden dev chrome; mock-data-proportional decorative overlay text) and are guarded by a source-scanning test with a tight, path-keyed allowlist. Ran the guard suite live: 7/7 pass.

No blockers. No should-fix items. A couple of nits below.

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

- **`fontSizeUnits.test.ts` CSS bare-px regex could in principle miss a value hidden behind a CSS custom property indirection** — e.g. `font-size: var(--some-token)` where `--some-token: 14px` is defined elsewhere. Not a defect in this commit (no such indirection exists in the current sheet — confirmed no `font-size: var(` sites appear anywhere in the diff or surrounding files), just a latent gap in the regex-based guard if that pattern is introduced later. Not worth blocking on; flagging for awareness only. `client/src/styles/fontSizeUnits.test.ts:61`
- The `ALLOWED` map in the guard test (`client/src/styles/fontSizeUnits.test.ts:100`) only lists `MockBadge.tsx`. `Images.tsx` doesn't need an entry because its two `fontSize` sites were never bare-number literals to begin with (`Math.max(6, line.size * ...)` and `line.size`, both expressions) — correctly excluded by the regex's literal-number match, but worth a one-line comment noting *why* `Images.tsx` isn't in the map, since a future reader scanning the allowlist for "the two documented exceptions" will only find one entry and might wonder if the other was missed.

### PRAISE

- The verification methodology holds up: I independently re-derived all 412 `px→rem` conversions programmatically from the raw diff (pairing minus/plus blocks positionally rather than trusting adjacency) and got 0 mismatches — the builder's "md-identical, zero mismatches" claim is correct, not just asserted.
- The non-tautological guard test (`client/src/styles/fontSizeUnits.test.ts`) reads real files off disk via `readFileSync`/`readdirSync` over the actual `src/` tree, not a mocked fixture — a real `font-size: 14px` added to any CSS file tomorrow, or a bare `fontSize: 14` added to any TSX file, fails the suite immediately. This is a genuine regression gate, confirmed by inspection of the regex (`CSS_PX_FONT_SIZE`, `CSS_CLAMP_PX`, `BARE_NUMBER_FONT_SIZE`) and by a live `npx vitest run` (7/7 pass).
- `clamp()` handling is correct on all 4 sites (`.km-login__title`, `.km-stub__title`, `.km-reading__title`, `.km-review__word`) — both bounds converted, `vw` component untouched, e.g. `clamp(34px, 5vw, 48px)` → `clamp(2.125rem, 5vw, 3rem)`.
- The two intentional-fixed exceptions are each backed by an inline rationale comment *and* a dedicated test (`fontSizeUnits.test.ts:193-213`) that (a) requires the rationale comment stay present and (b) asserts the value is still a bare/computed px number, not accidentally converted — this guards against both directions of drift (someone deleting the justification, or someone "fixing" the exception into rem and silently breaking the dev-chrome/mock-scene sizing).
- `@media` breakpoint declarations are untouched everywhere (confirmed zero diff hits on any `@media` line itself, including inside `Hanja.css` where a converted `font-size` lives nested inside a `@media (max-width: 380px)` block — the query itself is unchanged, only the nested `font-size` converted).

## Detailed findings (file:line)

Representative math spot-checks (all exact, `px/16`):
- `client/src/styles/index.css:526` `.km-toast__message` `13.5px` → `0.84375rem` (13.5/16 = 0.84375, exact)
- `client/src/styles/index.css:751` `.km-mock__score-unit` `22px` → `1.375rem` (22/16 = 1.375, exact)
- `client/src/styles/index.css:1934` `.km-login__title` `clamp(34px, 5vw, 48px)` → `clamp(2.125rem, 5vw, 3rem)` (34/16=2.125, 48/16=3, exact; `5vw` untouched)
- `client/src/pages/Hanja.css` (inside `@media (max-width: 380px)`) `64px` → `4rem`, `56px` → `3.5rem` (exact)
- `client/src/pages/Hanja.css` `190px` → `11.875rem` (190/16 = 11.875, exact — the largest single value in the sweep, confirms no truncation at scale)
- `client/src/pages/Today.css` `11.5px` → `0.71875rem` (11.5/16 = 0.71875, exact)
- `client/src/components/UploadTypeModal.tsx:96` TSX inline `fontSize: 13` → `fontSize: '0.8125rem'` (13/16 = 0.8125, exact; correctly changed from bare JS number, which React renders as px, to a rem *string*, which renders as specified — semantically correct, not a broken value)
- `client/src/components/KgiuDetailBench` — actually `KgiuDetailBody.tsx:29` `fontSize: 14` → `fontSize: '0.875rem'` (exact)

Scope-leak check (co-occurring non-font-size px on lines that also had a converted `font-size` — all confirmed unchanged):
- `client/src/styles/index.css:1837-1839` `.km-btn--{sm,md,lg}` — `padding`, `min-height`, `min-width` all left in px, unchanged; only `font-size` converted.
- `client/src/styles/index.css:1859-1861` `.km-seal--{sm,md,lg}` — `width`, `height`, `line-height`, `border-radius` all left in px, unchanged; only `font-size` converted.
- `client/src/styles/index.css:2508` `.km-mock__score-unit` — `margin-left: 2px` unchanged.
- Multiple `margin-top`/`margin-left` co-occurrences across `index.css`, `Chat.css`, `Progress.css` (e.g. `.km-review__exEn`, `.km-review__notes`, `.km-images__*-en` sites) — all left in px, unchanged.

TSX exceptions:
- `client/src/components/MockBadge.tsx:66-73` — `fontSize: 11` left as bare number (px), now with an inline "Intentional-fixed px" rationale comment; dev-only `aria-hidden` seal glyph pinned to a fixed 18×18 box. Test enforces both the comment and the unconverted value (`fontSizeUnits.test.ts:208-209`).
- `client/src/pages/Images.tsx:575-582,662-670` — `fontSize: Math.max(6, line.size * ...)` and `fontSize: line.size` left as computed expressions (never bare-number literals), decorative mock-scene overlay text tied to placeholder graphic data. Rationale comments added; test enforces (`fontSizeUnits.test.ts:210-212`).

Guard test:
- `client/src/styles/fontSizeUnits.test.ts:61,65,95` — the three regexes (`CSS_PX_FONT_SIZE`, `CSS_CLAMP_PX`, `BARE_NUMBER_FONT_SIZE`) scan every `.css` and `.tsx` file under `src/` from disk at test-run time — not a fixture/mock, not scoped to only the files this commit touched. A new violation anywhere in the tree fails the suite.
- Live run: `npx vitest run src/styles/fontSizeUnits.test.ts` → 7 passed (7), 537ms.

Non-functional doc-comment updates (no code/behavior change, verified):
- `client/src/lib/text-size-presets.ts:17-24`
- `client/src/styles/index.css:440-445` (the sheet's top-of-file banner comment)
- `client/src/pages/Today.test.tsx:1300-1305` — existing assertion correctly updated from `/font-size:\s*16px;/` to `/font-size:\s*1rem;/` with an explanatory comment; this is the expected fallout of the migration on an existing test, not new test debt.

## Coordination observations

- This commit's diff is exactly the claimed 30-file, font-size-only slice — no color/layout changes bled in from the prior commit (`18b8c2c`), consistent with the stated scope boundary.
- The `:root[data-text-size]` percentage mechanism (`93.75%` / `100%` / `112.5%` in `client/src/styles/index.css:451-453`) predates this commit and was not touched by it — this sweep is purely "make the existing scale mechanism actually apply to font-size everywhere," which matches the ticket's stated intent (F-086 was explicitly scoped as the follow-up to the mechanism itself).
- No `font-size: var(...)` indirection exists anywhere in the current sheet, so the regex-based guard test has no blind spot today (see NIT above for the latent-gap caveat if that pattern is introduced later).
- Recommend the next round-4 fixpass/reviewer treat this file as a template for how a mechanical sweep's guard test should be built: real-file source scan + representative exact-math assertions + explicit intentional-exception allowlist, rather than a snapshot/mock-based test that would silently rot.
