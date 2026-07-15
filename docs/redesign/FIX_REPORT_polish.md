# FIX REPORT — post-beta polish batch (feat/post-beta-polish, base 77e076d)

Fix-pass against `REVIEW_polish-logic.md` (1 BLOCKER + 1 SHOULD-FIX) and
`REVIEW_polish-fidelity.md` (same BLOCKER, independently found). Both
reviewers agreed on the same root cause and the same fix shape; no other
findings in either review required a code change (F-132/174/178/180/181/182/186
were all PASS, and NIT-1 / Finding-3 in the two reviews were explicitly
non-blocking and out of this fix-pass's scope).

## Disposition

### BLOCKER-1 (polish-logic) / Finding 1 (polish-fidelity) — Today lost 14px of title→rail-divider gap in the F-177 migration

**FIXED.** Mirrored Progress.tsx's exact pattern onto Today:

- `client/src/pages/Today.tsx` — `PageHubHeader` call now passes
  `className="km-today__hub"` (previously no `className` at all), with a
  doc-comment update explaining the restored gap, mirroring Progress.tsx's
  own comment.
- `client/src/pages/Today.css` — added the scoped override rule
  `.km-today__hub .km-hubheader__title { margin-bottom: 14px; }`, byte-for-
  byte the same shape as `Progress.css`'s `.km-progress__hub
  .km-hubheader__title { margin-bottom: 14px; }`.
- No changes to `PageHubHeader.tsx`/`PageHubHeader.css` — the shared
  component's own default (`margin: 4px 0 0`) is unchanged, matching the
  fidelity reviewer's note that the 7 Library pages never had the extra
  14px and shouldn't get it.

**Test added** (`client/src/pages/Today.test.tsx`, new test alongside the
existing F-177 test): asserts both halves of the fix —
1. DOM side: the rendered `.km-hubheader` root carries `km-today__hub`.
2. CSS side: `Today.css`'s source contains a
   `.km-today__hub .km-hubheader__title { ... }` rule containing
   `margin-bottom: 14px;` — same CSS-source-read-from-disk pattern already
   used elsewhere in this file (section-title/peek-slider tests) and in
   `Hanja.test.tsx`'s cross-file token pin.

Result: Today's header spacing is restored to its pre-migration self
(4px top + 14px bottom = 18px total title→rail gap) and now matches
Progress's gap exactly, closing the Today-vs-Progress mismatch both
reviewers flagged.

### SHOULD-FIX-1 (polish-logic) — theme boundary dual-copy has no automated sync guard

**FIXED.** Added a new test in `client/src/hooks/ThemeProvider.test.tsx`:
`"index.html's bootstrap script uses the same hour boundary as
AUTO_DAY_START_HOUR/AUTO_DAY_END_HOUR"`. It `readFileSync`s
`client/index.html`, regex-extracts the bootstrap script's literal
`hour >= N && hour < M` boundary, and asserts `N`/`M` equal the exported
`AUTO_DAY_START_HOUR`/`AUTO_DAY_END_HOUR` constants imported from
`theme-context.ts`. A future edit to either the TS constants or the inline
`<script>` without updating the other now fails this test instead of only
being caught by a human re-reading both files.

No production code changed for this item (per the review: "nothing is
wrong today" — this converts an honor-system comment into a CI-enforced
invariant).

### Everything else in the batch

No other findings required action:
- F-132, F-174, F-178, F-180, F-181, F-182, F-186 — both reviewers PASS,
  no code changes requested.
- NIT-1 (polish-logic, unmount-specific interval-cleanup test) — explicitly
  flagged as low-risk/non-blocking; out of scope for this fix-pass.
- Finding 3 (polish-fidelity, 360px live-screenshot QA for the 4-item theme
  row) — explicitly flagged as should-verify, not a confirmed defect;
  out of scope for this fix-pass (no code/test change implied).

## Gate results (run from `client/`)

| Check | Result |
|---|---|
| `npm run lint` | **0 errors, 0 warnings** |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| `npx vitest run` | **115 test files passed / 1872 tests passed** (0 failed) |
| `npx vite build --outDir /tmp/km-fix-pb` | **exit 0** (311 modules transformed; pre-existing >500kB chunk-size advisory only, not an error) |

All pre-existing tests remain green; no other behavior changed.

## Files touched

- `client/src/pages/Today.tsx` — `className="km-today__hub"` on `PageHubHeader`, updated doc-comment.
- `client/src/pages/Today.css` — new scoped `.km-today__hub .km-hubheader__title` override.
- `client/src/pages/Today.test.tsx` — new F-177 gap-restoration test (DOM class + CSS-source assertions).
- `client/src/hooks/ThemeProvider.test.tsx` — new boundary-sync test + `readFileSync`/`join`/`cwd` and `AUTO_DAY_START_HOUR`/`AUTO_DAY_END_HOUR` imports.
- `docs/redesign/FIX_REPORT_polish.md` — this report (new).
