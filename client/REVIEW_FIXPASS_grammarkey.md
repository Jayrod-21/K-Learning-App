# Fixpass Review — extract `grammarKey`/`slugifyKey` out of `Reference.tsx`

Reviewer: independent senior (TS/React). Did not author the code. Review only — no code changed.

## Summary verdict

**APPROVE.** This is a textbook behavior-preserving extraction. The moved
`grammarKey` and `slugifyKey` bodies are byte-identical to the pre-refactor
originals (verified against `git show HEAD:client/src/pages/Reference.tsx`),
import paths are correct, the type-only import matches sibling-lib style, no
dangling references remain, and `Reference.tsx` now exports **only** its default
component — so `react-refresh/only-export-components` is genuinely satisfied, not
merely silenced.

- BLOCKER: 0
- SHOULD-FIX: 0
- NIT: 2
- PRAISE: 5

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. Test locality — the `grammarKey` unit suite (the `describe('grammarKey — …
   (F2)')` block) still lives in `Reference.test.tsx` even though the code now
   lives in `lib/grammarKey.ts`. Consider a dedicated `lib/grammarKey.test.tsx`
   for locality. Non-blocking; the tests pass as repointed.
2. New file is untracked — `client/src/lib/grammarKey.ts` shows as `??` in
   `git status`. Trivial/expected, but flag it so it isn't dropped from the
   commit (a `git add` of the new file is required; the two `M` files alone would
   break the build).

### PRAISE
- Byte-identical logic preserved (see detailed findings).
- Doc comment moved verbatim and correctly re-anchored as the module docstring —
  no drift, no paraphrase.
- Type-only import (`import type { KgiuEntrySummary }`) — correct and matches the
  exact style of `lib/readingSelection.ts:25` and `lib/nav.ts:13`.
- `hasPattern` (a genuinely Reference-scoped helper that sat between the two
  moved functions) was correctly **left behind** in `Reference.tsx` rather than
  swept along; it is still referenced there (lines 145, 187, 737).
- `lib/` is the right home: `grammarKey` is a pure, dependency-free data util
  that is independently unit-tested, sitting alongside `readingSelection.ts` /
  `nav.ts`. Not Reference-specific.

## Detailed findings (file:line)

### 1. Byte-identical logic — CONFIRMED (PRAISE)
Compared new `client/src/lib/grammarKey.ts:19-33` against the original block in
`HEAD:client/src/pages/Reference.tsx:159-178`:

- `grammarKey` (new `:19-23`) — identical: `raw = p.source_id ?? \`kgiu-${String(p.id)}\``,
  `slug = slugifyKey(raw) || \`kgiu-${String(p.id)}\``, `return \`GR-${slug}\``.
- `slugifyKey` (new `:26-33`) — identical regex chain:
  `.toLowerCase()` → `.replace(/[^a-z0-9_-]+/g, '-')` → `.replace(/-+/g, '-')` →
  `.replace(/^-+|-+$/g, '')` → `.slice(0, 64)`.
- GR- prefix, `kgiu-${id}` empty-slug fallback, and 64-char cap all preserved.
- Doc comment (`grammarKey.ts:3-18`) matches the original prose verbatim.
No subtle change of any kind.

### 2. Import paths — CORRECT (PRAISE)
- `client/src/pages/Reference.tsx:59` → `import { grammarKey } from '../lib/grammarKey'`.
  From `src/pages/` → `../lib/grammarKey` = `src/lib/grammarKey`. Correct.
- `client/src/pages/Reference.test.tsx:57` → `import { grammarKey } from '../lib/grammarKey'`.
  Same directory (`src/pages/`), same resolution. Correct.
- `client/src/lib/grammarKey.ts:1` → `import type { KgiuEntrySummary } from '../types/domain'`.
  From `src/lib/` → `../types/domain` = `src/types/domain`. Correct; `KgiuEntrySummary`
  is defined at `src/types/domain.ts:1021`.

### 3. No dangling references (PRAISE)
- `grep slugifyKey src/pages/Reference.tsx` → no matches. The private helper is
  no longer referenced in the page (it is correctly private to the new module —
  not exported from `grammarKey.ts`).
- `grammarKey` call sites in `Reference.tsx` remain intact and resolve to the new
  import: `:222`, `:226` (bank path), `:290` (render key).
- Test call sites (`Reference.test.tsx:169,175,183,189,197,204`) all resolve to
  the repointed import.

### 4. Lint rule genuinely satisfied (PRAISE)
`grep -E '^\s*export ' src/pages/Reference.tsx` → the **only** export is
`export default function Reference` at `:86`. No other non-component value/const
export remains, so `react-refresh/only-export-components` is satisfied by
removal of the offending named export, not by an eslint-disable comment. Fix is
real.

### 5. Test import repoint (PRAISE)
`Reference.test.tsx:56-57` cleanly splits the previous
`import Reference, { grammarKey } from './Reference'` into a default import from
`./Reference` and a named import from `../lib/grammarKey`. `grammarKey` is still
exercised by the F2 suite (`:149-207`), so coverage is unchanged.

## Coordination observations
- Client `lint` + `tsc` + `build` + tests reported PASS by the fix author;
  the static evidence here (only-default export, correct paths, byte-identical
  bodies, live call sites) is fully consistent with that.
- Commit hygiene: ensure the new untracked file `client/src/lib/grammarKey.ts`
  is staged together with the two modified files — committing only the `M` files
  would leave `Reference.tsx`/`Reference.test.tsx` importing a non-existent
  module.
