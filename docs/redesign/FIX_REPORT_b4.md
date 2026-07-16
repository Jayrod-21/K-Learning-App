# Fix Report: Batch 4 (Hanja — F-114/F-115)

Fix-pass on `docs/redesign/REVIEW_b4-hanja.md` (0 BLOCKER / 1 SHOULD-FIX / 4 NIT). Branch `worktree-agent-a249db25670163738`, base 82534e9. Client-only.

## Dispositions

### SHOULD-FIX — trace completion stamps "Mastered" (Hanja.tsx:2663-2669) — FIXED
- Seal label now mode-conditional: trace → `Traced / 따라 씀`, recall → `Mastered / 마스터` (unchanged). Seal chrome (milestone look, size, tone, `km-najeon`) kept in both modes — only the mastery CLAIM was wrong, so only the label changes. Completion-card comment updated to state the trace/recall split.
- Tests: F-115 trace-completion test now asserts `Traced` present + `Mastered`/`마스터` absent; F-165 recall single-char completion test now asserts `Mastered` present + `Traced` absent. Either regression direction fails a test.

### NIT 1 — F-114 `characterId` has no consumer — SKIPPED (directed)
- Expected future-use plumbing per task instructions; left as-is.

### NIT 2 — mixed-mode progress relabel ("N of M traced" counts recall pops) — SKIPPED (not trivially safe)
- Correct fix needs a per-mode counter + decisions on what the bar shows mid-session after a mode switch (a fresh trace counter under a session-wide max reads worse than the current label imprecision). Behavioral change beyond a trivially-safe fix-pass; reviewer rated it purely cosmetic, no writes/queue impact. Defer to follow-up.

### NIT 3 — stale recall `stateError` persists into trace mode (Hanja.tsx:~2916) — FIXED
- Alert render now gated `mode === 'recall'`. State itself NOT cleared: switching back to recall (where retry is actionable) shows the error again — honest info preserved, just not displayed in a mode that cannot produce or act on it.

### NIT 4 — mode-toggle comment claims "same pattern as index filter toolbar" but role differs — FIXED (comment only)
- Reviewer: `group` is the better role, no code action needed. Comment reworded: same chip VISUALS, deliberately `role="group"` not `role="toolbar"` (no roving-tabindex arrow-key nav).

## Untouched (per instructions / PRAISE)
- Trace zero-writes path (`traceNext`), F-114 server+client DTO work, recall judge loop, DrawingPad guide z-order, mode-as-local-state, pad remount key — all unmodified.

## Gates (exact)

| Gate | Result |
|---|---|
| client `npm run lint` | exit 0 |
| client `npx tsc -p tsconfig.app.json --noEmit --incremental false` | exit 0 |
| client `npx vitest run src/pages/Hanja.test.tsx` | **58 passed** (1 file, 0 failed) |
| client `npx vite build --outDir /tmp/km-b4fix` | exit 0 |

(Reviewer's 78 spanned Hanja.test.tsx + services/hanja.test.ts; this gate ran the specified page suite only.)

## Files changed
- `client/src/pages/Hanja.tsx` — mode-conditional seal label + completion comment; recall-gated `stateError` alert; mode-toggle comment reword.
- `client/src/pages/Hanja.test.tsx` — seal assertions added to F-115 trace-completion + F-165 recall-completion tests.
