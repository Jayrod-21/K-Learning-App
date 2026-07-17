# BUILD note — F-098 BEM element-casing convention + mechanical rename

Reader: agents. Telegraphic.

## What

Convention fixed = **kebab-case** for every BEM segment (block / `__element` /
`--modifier`). Documented in `client/BEM_CONVENTIONS.md`. All camelCase BEM
element tokens under `client/src` mechanically renamed to kebab-case. Purely
mechanical — zero logic/CSS-structure/behavior changes; diff is 513 insertions
/ 513 deletions (rename-only lines).

## Numbers

- **151 distinct camelCase element tokens** renamed (e.g. `__tileIcon` →
  `__tile-icon`, `__savedUploadsTruncated` → `__saved-uploads-truncated`).
- **526 token replacements** across **38 files**: 16 CSS + 22 TSX (17
  component/page + 5 test files).
- **0 camelCase `--modifier` segments** existed (swept
  `--[a-z0-9]+[A-Z]` → empty before + after).

## Method (safety)

- Single-pass perl substitution, alternation sorted longest-first, trailing
  `(?![a-zA-Z0-9])` lookahead → full-token match only; prefix pairs like
  `__listRow` / `__listRowBody` and `__resumeProgress` /
  `__resumeProgressCount` cannot cross-corrupt. `-` allowed as boundary so
  `__pageDrag--dragging` renames both halves correctly (incl. the
  `UploadViewer.tsx:1509` template-literal split across lines).
- CSS + TSX renamed in the same pass from the same map → lockstep by
  construction; no CSS/TSX orphan can be introduced.
- Kebab-collision audit BEFORE rename: 14 tokens whose kebab form already
  existed — all on **different blocks** (e.g. `km-review__listRow` vs
  pre-existing `km-hanja__list-row`) → no same-block class merge. Verified
  per-token.
- Duplicate-target audit: no two camel tokens map to the same kebab token.

## Deliberately NOT renamed

- `data-tour="…"` values — tour anchors, not classes (all already kebab; none
  contained camelCase anyway).
- Third-party classes (`driver-*`), utility/state classes (`is-active`,
  `focusring`, `km-tone--*`), block names (already kebab).
- **Nothing skipped**: every token matching the BEM-element camelCase pattern
  was a genuine BEM element; no ambiguous tokens found.

## Pre-existing one-sided tokens (renamed in lockstep, unchanged semantics)

- `__flashcardWrap` → `__flashcard-wrap`: TSX + Review.test.tsx only, no CSS
  rule (pre-existing unstyled wrapper).
- `__sectionEyebrow` → `__section-eyebrow`: Today.test.tsx NEGATIVE assertions
  (class must NOT exist / stylesheet must not define) — rename keeps the guard
  meaningful under the new convention.
- `__progressBar` / `__progressFill` (Review.css comment), `__trendKr`
  (Progress.css comment), `__rowItem` (ReviewGrammar.tsx comment): dead-CSS /
  explanatory comments only; renamed for a clean zero-grep of old forms.

## Tests with pinned class strings updated

`Chat.test.tsx` (5 replacements), `Progress.test.tsx` (6), `Reading.test.tsx`
(2), `Review.test.tsx` (2), `Today.test.tsx` (38) — expected strings moved with
the rename, same assertions/behavior.

## Verification

- Old camelCase BEM forms after rename: `grep -rE "__[a-z0-9]+[A-Z]"` over
  css/tsx/ts under client/src → **0 hits**.
- Orphan scan on all 151 new kebab forms: only the 5 pre-existing one-sided
  cases above (confirmed one-sided at HEAD before the rename too).

## Gates (all on this branch, single vitest run)

- `npm run lint` → exit 0
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → exit 0
- `npx vitest run` (FULL) → **128 files / 2235 tests passed, 0 failed**
  (identical to pre-change baseline: 128 / ~2235 green)
- `npx vite build --outDir /tmp/km-f098-dist` → exit 0
