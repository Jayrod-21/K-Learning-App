# Independent Review — F-196 PastExams crash-guard

Reviewer: independent senior reviewer (did not author). Commit `bfe9092`, branch `fix/f196-pastexams-crash`, diff vs `origin/rebuild`. Client-only scope.

## Summary verdict

**PASS — 0 BLOCKER, 0 SHOULD-FIX, 4 NIT, 5 PRAISE.**

Fix does exactly what F-196 asks: `mockSectionFromKr` now total (`MockSection | null`, warns on anomaly), `reEnterHref` returns `string | null`, null-href row renders read-only. No throw path remains in render. Working-section (reading/listening) DOM verified identical to base. Compile-time exhaustiveness retained. Tests are mutation-resistant, not tautological. Gate fully green (lint 0, tsc 0, vitest 11/11).

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| Page robust to `'쓰기'`/unknown section; row degrades, result visible, no throw reaching render | **MET** | `PastExams.tsx:106-124` returns `null` both anomaly paths; `reEnterHref` guards at `:141-142`; read-only branch `:209-215`. Probed every render callee: `whenLabel` NaN-guarded (`:162-165`), `bandForPercentage` total (`:155-160`), `totalItems > 0` division guard (`:173-174`), `URLSearchParams` cannot throw on strings. No remaining throw path. |
| Rest of list unaffected by one bad row | **MET** | Sibling test `PastExams.test.tsx:225-246` renders `['쓰기', READING]` and pins the sibling's exact href attribute. |
| Working sections byte-identical (href + aria + action glyph) | **MET** | Compared non-null branch (`PastExams.tsx:198-208` + `rowBody :181-194`) against `origin/rebuild` `PastExamRow`: same `className="km-pastexams__row-btn focusring"`, same aria-label template char-for-char, same child order (fragment flattens: row-main span → Pill → aria-hidden play glyph), href computation unchanged for non-null sections. DOM output identical. |
| Exhaustiveness stays a COMPILE-time guard | **MET** | `const exhausted: never = section;` retained at `PastExams.tsx:119` — a new `TopikSection` member is still a tsc error; runtime now warns + returns `null` instead of throwing. tsc clean confirms. |
| WCAG/ARIA on read-only row — no dead/confusing affordance | **MET** | Read-only branch is a plain `<span>` (`PastExams.tsx:214`): no `focusring`, not focusable, no play glyph. Checked CSS: `.km-pastexams__row-btn` (`PastExams.css`) has no `:hover`/`cursor` rules; shared `.km-reference__row` (`styles/index.css:4382-4385`) is border-only; `Pill` is a `<span>` (`components/Pill.tsx:38`). Nothing looks tappable. Visible text still conveys level/section/score/date/band. |
| `'쓰기'` test fails if bare throw restored (mutation check) | **MET** | Reasoned mutation: restore `throw` in the `'쓰기'` case → RTL `render()` rethrows synchronously (no boundary in the test tree — the OLD test at this exact spot relied on that with `.toThrow(/mockSectionFromKr/)`), so `expect(() => renderPage()).not.toThrow()` (`test.tsx:212`) fails, and `:214-215` (`getByText`) and `:221` (warn assertion) fail too. Triple-killed; not tautological. |
| Listening/reading href pins actually pin | **MET (reading exact; listening adequate)** | Reading pinned exactly twice: navigation pin `test.tsx:160-162` and attribute pin `:241-244` (full string incl. `level=TOPIK+II`). Listening: `section=listening` substring (`:176`) + `mode=mock&section=listening&exam=60` (`:189`) — pre-existing, untouched by this diff. See NIT-3. |
| No scope creep, co-located, no dead code | **MET** | Diff touches exactly the 2 in-scope files. Test co-located. `MockSection` import still live (return type `:100`). No leftover throw-era code. |

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

1. **Render-phase side effect + StrictMode double-warn** — `console.warn` fires inside `mockSectionFromKr` (`PastExams.tsx:111, :120`), which runs during `PastExamRow` render. The app mounts under `<StrictMode>` (`main.tsx:15`), so dev double-render emits each warn twice, and N anomalous rows × every re-render (e.g. refetch) repeats it. Harmless for an invariant that should never fire, but a module-level warn-once set (or logging from an effect) would be purer React and less noisy if the invariant ever does move.
2. **Warn prefix is a third style** — message uses `PastExams:`; existing prod-code warns use `km.settings:` (`lib/settings.ts:210`) and `[api]` (`services/api.ts:215`). No single project convention exists, so not a violation — but this diff introduces a third prefix style. Content-wise the messages match project character (long, explanatory, cites the invariant): consistent in spirit.
3. **Listening full-href pin is partial (pre-existing)** — `test.tsx:176` pins only the `section=listening` substring via the location probe. The legacy test (`:189`) pins `mode=mock&section=listening&exam=60`, so listening is adequately covered in aggregate, and this predates the diff. Only worth touching if these tests are edited anyway.
4. **Sibling test doesn't re-assert the writing row's visibility in the 2-row list** (`test.tsx:225-246` checks only the sibling's link). The single-row test (`:193-223`) proves the read-only rendering, and React either renders the whole list or throws, so coverage is real — an extra `getByText(/쓰기/)` there would merely make the "siblings unaffected AND anomalous row still shown" claim self-contained.

### PRAISE

1. **Byte-identity of the working branch was preserved deliberately** — the `rowBody` extraction (`PastExams.tsx:181-194`) keeps the non-null `<Link>` (`:198-208`) structurally identical to base (verified against `origin/rebuild`); zero regression surface for real re-enter links, confirmed by the untouched passing pin tests.
2. **The "never mis-route" property survives the softening** — anomaly path returns `null` and renders link-less rather than falling back to a guessed section; the original Batch-2 SHOULD-FIX-1 intent is explicitly preserved and documented (`PastExams.tsx:93-96`).
3. **Mutation-resistant test design** — `test.tsx:193-223` kills the reverted-throw mutant three independent ways (no-throw, visible-result, warn-called), and the link-absence check targets the specific `tap to re-enter` label rather than "no links at all" (the Mistakes CTA legitimately remains).
4. **Read-only row is genuinely clean a11y** — no focus ring, no glyph, no hover/cursor styling anywhere in the cascade, no disabled-looking control; degradation is invisible as a broken affordance and honest as a result row.
5. **Doc comments updated to tell the true story** — the F-196 narrative (`PastExams.tsx:85-96`, `:167-171`, test header `:194-202`) explains WHY the throw was wrong (app-root-only ErrorBoundary), keeping the archaeology future-proof.

## Detailed findings

- `PastExams.tsx:98-126` — `mockSectionFromKr` now total. `'쓰기'` → warn + `null` (`:106-114`); `default` keeps `const exhausted: never = section` (`:119`) then warn + `null` (`:120-123`). Compile guard intact, runtime crash gone.
- `PastExams.tsx:140-150` — `reEnterHref` null-guards before building params (`:141-142`); non-null path byte-identical URL construction to base.
- `PastExams.tsx:172-218` — `PastExamRow` computes `href` once (`:179`), branches at `:198`; null branch `:209-215` renders `<span className="km-pastexams__row-btn">` (no `focusring`, no action glyph). Non-null branch identical to base output.
- `PastExams.test.tsx:193-223` — 쓰기 no-crash test: fails on reverted throw (see bar checklist); asserts visible result, absent re-enter link, warn fired with `쓰기`.
- `PastExams.test.tsx:225-246` — sibling isolation test with exact `toHaveAttribute('href', '/learn/topik?mode=mock&section=reading&exam=91&level=TOPIK+II')`.
- Probed for residual render throws: none (see bar checklist row 1).

## Gate (run by reviewer in this worktree)

```
cd client && npm ci            → OK, 0 vulnerabilities
npm run lint                   → 0 errors, 0 warnings
npx tsc -p tsconfig.app.json --noEmit --incremental false → 0 errors
npx vitest run src/pages/PastExams.test.tsx → 1 file passed, 11/11 tests passed (1.08s)
```
