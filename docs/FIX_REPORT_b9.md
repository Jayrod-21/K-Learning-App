# FIX REPORT — Batch 9 fix-pass (F-059/F-056 + NITs)

Fix-pass agent, branch `feat/b9-uploads-ui`. Scope = 3 client SHOULD-FIX
(REVIEW_b9_client.md) + server test-parity NIT-1 (REVIEW_b9_server.md).
PRAISE items untouched (settle lifecycle, wire mapping, NIT-A early-return,
security mirror).

## Dispositions

| Finding | Disposition | What changed |
|---|---|---|
| SF-1 — 400 copy blames a page range user never chose | **FIXED** (better than reviewer's suggestion) | `client/src/pages/UploadViewer.tsx` `extractErrorCopy`: 400 branch now keys on `err.code === 'validation_error'` → `'Nothing left to extract — this book may already be fully scanned.'` Reviewer said "the client can't discriminate" — WRONG for the case that matters: the two *validation* causes share `validation_error`, but the OTHER realistic 400 (all-pages-failed OCR → `mapClaudeError` upstream-4xx passthrough, `server/src/services/uploadExtract.ts:675-683` + `middleware/errors.ts:163-180`) arrives with `code: 'upstream_error'`, and client `ApiError` carries `.code`. So: validation_error 400 → fully-scanned copy (hedged "may" — verified: with an empty body the inverted-range + oversize validations at `uploadExtract.ts:502-511` can't fire, `520-525` is the only ValidationError left); any other 400 code falls through to the generic fallback instead of falsely claiming "fully scanned". `services/uploads.ts` doc comment updated. Tests: it.each 400 row → `validation_error` + `/Nothing left to extract/`; NEW test pins 400+`upstream_error` → generic copy AND absence of the fully-scanned claim + server prose. |
| SF-2 — stale re-enable after client timeout | **FIXED** | `loadRuns` → `async`/`Promise<void>` (still never rejects — best-effort catch kept); `extract()` catch now `await loadRuns()` for `status === 409 \|\| code === 'timeout'`, so the history re-read lands in state BEFORE the `finally` clears `extracting` — a still-`running` run flips `runLive` and the trigger stays disabled with the live strip + Refresh visible. Call sites: effect + Refresh onClick wrapped with `void` (no-floating/misused-promises clean). NEW test: timeout → 2nd `listExtractions` → running run → strip shows live copy, trigger disabled (`Extract text (an extraction is already running)`), Refresh present. **Mutation-verified**: reverting the condition to 409-only fails exactly this test (1 failed / 71 passed), fix restored, 72/72. |
| SF-3 — `role="status"` mounts with its content; first settle never announced | **FIXED** | Strip container + inner `role="status"` span now render unconditionally inside the `canView` branch (span empty when `latestRun === null`); ONLY the status message text lives inside the region — Refresh button + page-ceiling hint moved out as siblings (incidentally resolves N-4). Idle visual: new `.km-upload-viewer__extract--idle` zeroes the strip margins (empty span = zero height; deliberately NOT `display:none`, which would defeat the pre-existing-region point — commented in `UploadViewer.css`). Test at the "renders enabled" case now asserts the region **exists and is empty pre-run** (`toBeEmptyDOMElement`) + no run-time chrome (no Refresh, no hint). |
| Server NIT-1 — grammar suite missing clean-boundary truncation mirror | **FIXED** | `server/tests/routes/grammar.test.ts`: new test "over the row cap with the cut exactly on a group boundary" — 500 (newer) + 5 (older); asserts `truncated:true`, `total:505`, exactly 1 group, kept whole at 500 entries. Mirrors `vocab.test.ts:1674-1699`; exercises the `sentinel.upload_id !== lastKept.upload_id` keep-all branch; drops-last-group-when-truncated or split-group regressions fail the group/entry-count assertions. |

Out of scope, untouched: N-1 (raw-seconds hint), N-2 — *partially* resolved as a
side effect (the dead `retryAfter` it.each column was replaced by the
load-bearing `code` column SF-1 needed), N-3 (doneRunCopy ×2), server NIT-2
(stale 'ending' whitelist comment), NIT-3 (duplicated cap logic).

## Gates (all run in this worktree, post-fix)

| Gate | Result |
|---|---|
| client `npm run lint` | 0 errors |
| client `tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors |
| client `vitest run` UploadViewer + ReviewGrammar + ReviewVocab | **3 files, 149 passed, 0 failed** (was 147; +2 new: upstream-400, timeout-still-live) |
| client `vite build --outDir /tmp/km-b9fix-dist` | success (PWA 15 entries) |
| server `npm ci` | clean, 0 vulnerabilities |
| server `npm run typecheck` | 0 errors |
| server `vitest run tests/routes/grammar.test.ts` (testcontainer) | **93 passed, 0 failed** (incl. new boundary test) |

## Self-assessment

- SF-1: highest-value deviation — code-discriminated copy is strictly more
  honest than the reviewer's single either/or wording; both 400 classes now
  have correct copy and both are test-pinned.
- SF-2: `await` (not fire-and-forget) is the load-bearing part — the re-read
  settles before `extracting` clears, so there is no enabled-while-live
  render frame. Mutation run proves the test is real.
- SF-3: message-only region also covers N-4; empty-strip visual handled in
  CSS with rationale comment. Announce behavior itself isn't assertable in
  happy-dom — the test pins the DOM precondition (region pre-exists, empty),
  which is the actual mechanism.
- Risk: none identified; no PRAISE surface touched (finally-guard, wire
  mapping, NIT-A conditions, server route all unmodified — server src has
  zero diff).
