# Fix Report — uploads U1b-rework

Fix-pass against the three independent reviews (`REVIEW_uploads_u1b_rework_{server,viewer,client}.md`)
and their aggregate (`FIXPASS_AGGREGATE_uploads_u1b_rework.md`). Scope: the 10 SHOULD-FIX items
A-S1/A-S2, B-S1/B-S2/B-S3, C-S1..C-S5. C-S6 is explicitly out of scope (deferred, app-wide convention).
No BLOCKERs existed; no PRAISE item was touched or weakened.

Branch: `feat/pdf-uploads`. Nothing committed, pushed, or deployed — working tree only, per instructions.

## Disposition table

| ID | Disposition | Files changed | Test added |
|---|---|---|---|
| A-S1 | **FIXED** | `server/src/routes/uploads.ts:197,324,530` (bare `getLogger()` → `req.log`); removed the now-unused `getLogger` import (`:76` deleted) | No new test — this is a pure observability change (correlation-id propagation on already-covered error paths); existing tests for those paths (blob-cleanup failure, page-stream error) are unaffected and still pass. |
| A-S2 | **FIXED** | `server/tests/routes/uploads.test.ts:814-899` — new `describe('PATCH /uploads/:id/pages/order — concurrency (SELECT ... FOR UPDATE serialization)')` | 2 new tests: (1) two concurrent `PATCH` requests on the same upload with disjoint full orders — asserts both succeed and the final DB state is *exactly* one submitted order, never an interleaved mix, plus the `UNIQUE`/`CHECK` invariants hold; (2) a `PATCH` racing a `DELETE` on the same upload — asserts no 500, `DELETE` always wins the eventual outcome (204), and `PATCH` is either 200 (won the lock first) or 404 (lost it), with cascade-clean pages either way. Both fire real `Promise.all([agent.patch(...), agent.patch(...)])` against a live Postgres testcontainer (mirrors `tests/routes/auth.mfa.test.ts`'s racing-recovery-code pattern) — not a mocked lock. Ran 3x back-to-back to confirm no flake. |
| B-S1 | **FIXED** | `client/src/services/uploads.ts:125-157` (`pageUrl` gained a `cacheBust` 4th param, appends `?r=<token>` only when `>0`); `client/src/pages/UploadViewer.tsx:559` (`PageImage`'s `src` now passes `retryToken` as the cache-bust) | 7 new tests: `client/src/services/uploads.test.ts` — 5 cases under `describe('cacheBust', ...)` (omitted/0 → no query param, positive → `?r=N`, different tokens → different URLs, joins after a dev API base). `client/src/pages/UploadViewer.test.tsx` — 2 cases: normal nav never cache-busts; Retry cache-busts and a second Retry bumps the token again (never repeats the same URL); plus a 3rd asserting a fresh page nav after a retry doesn't carry the stale bust forward. |
| B-S2 | **FIXED** | `client/src/pages/UploadViewer.tsx:292-301` — `if (reordering) return;` as the first line of `submitMove`, covering both the Move button and the Enter-key path with one guard | 1 new test in `UploadViewer.test.tsx` (`'Enter cannot bypass the in-flight guard while a reorder is still pending...'`) — starts a reorder with a never-resolving `reorderPages` mock (so `reordering` stays `true`), types a new target and presses Enter directly on the (never-disabled) input, and asserts `reorderPages` was still called exactly once. |
| B-S3 | **FIXED (comment corrected, not the key-based refactor)** | `client/src/pages/UploadViewer.tsx:178-204` | No new test (doc-only change; behavior is unchanged, already covered by existing meta-fetch/retry tests). See rationale below. |
| C-S1 | **FIXED** | `client/src/services/uploads.ts:54-61,104,187-189` (removed the stale "KNOWN CROSS-AGENT CONTRACT GAP" note, replaced with a factual note that the route exists and was verified field-for-field; also dropped the stray "(assumed)" on the shared envelope comment); `client/src/pages/UploadViewer.tsx:2-3,36-40` (removed the parallel "will 404" claim in this file's own header, which Reviewer B was independently misled by) | No new test — pure comment/doc correction; the underlying route (`GET /uploads/:id/pages`) was already exercised by both the server suite and the reorder-tool tests in `UploadViewer.test.tsx`. |
| C-S2 | **FIXED** | `client/src/lib/errorCopy.ts:93-127` (`bookUploadErrorMessage`: 413 copy now says 300 MB not 15 MB; 400 copy is now cause-neutral instead of "isn't a valid PDF... choose a different file") | 5 new tests in a new `describe('bookUploadErrorMessage', ...)` block in `client/src/lib/errorCopy.test.ts` (there was no describe block for this function before): never-echoes-server-prose, the corrected 413 copy, a regression asserting the 400 copy does NOT say "isn't a valid PDF"/"choose a different file" for a title-length cause and DOES mention "title", the 429 split, and network/fallback copy. |
| C-S3 | **FIXED** | `client/src/components/UploadTypeModal.tsx:80-91` (`TITLE_MAX_LENGTH = 200` constant, documented against the server's exact `UploadBodySchema`/migration-040 CHECK), `:157-164` (submit()-level length guard, defense-in-depth), `:298` (`maxLength={TITLE_MAX_LENGTH}` on the input) | 2 new tests in `UploadTypeModal.test.tsx`: asserts the DOM `maxLength` attribute is exactly 200; asserts a 201-char title (injected via `fireEvent.change` to bypass the native truncation, simulating a programmatic path) is rejected client-side with the "200 characters max" message and never reaches `uploadBook`. |
| C-S4 | **FIXED** | `client/src/pages/Uploads.tsx:177-190` — the row-open ("view") button now gets `disabled={pending}` plus a belt-and-suspenders `if (pending) return;` guard in its own `onClick`, matching the delete button's existing `disabled={pending}` | 1 new test in `Uploads.test.tsx`: starts a delete with a controllable never-resolving promise, asserts that row's View button is disabled (and the *other* row's is not), that clicking the disabled button never navigates, then resolves the delete and confirms the row is removed. |
| C-S5 | **FIXED (real axios progress, not simulated)** | `client/src/services/uploads.ts:222-273` (`uploadBook` gained an `onProgress?: (percent: number) => void` 5th param wired to axios's native `onUploadProgress`, computing `Math.round(loaded/total*100)`; also added a 10-minute per-call `timeout` override — see note below); `client/src/components/UploadTypeModal.tsx:109,169-188,319-334` (`uploadProgress` state, wired into the Upload button's label as "Uploading… NN%", `aria-live="polite"` already announces it) | 6 new tests: `uploads.test.ts` — timeout override present and `>10_000`; `onUploadProgress` computes the correct percent from real `loaded`/`total`; no call when `total` is absent (divide-by-undefined guard); omitting `onProgress` leaves `onUploadProgress` unset. `UploadTypeModal.test.tsx` — the button shows a bare "Uploading…" before the first tick, then "Uploading… 42%" and "Uploading… 100%" as the captured callback fires. |
| C-S6 | **DEFERRED** (per instructions — app-wide convention change, not unique to this PR) | none | none |

## B-S3 — why "fix the comment" over the key-based refactor

The review offered two acceptable fixes and said "pick one": (1) preferred — key the route
element (`<UploadViewer key={id} />`) so switching books remounts the component and the
`metaState`/`pageNum` reset happens via fresh `useState` initial values, removing the need for
the disable entirely; or (2) fix the justifying comment to name the correct hazard.

I chose (2). Reasoning:

- The review itself calls the key-based refactor "a NIT-level refactor, not required for
  approval." It is explicitly optional, unlike the other 9 items.
- Doing it correctly is **not** a pure mechanical change. `loadMeta`'s synchronous
  `setMetaState('loading')`/`setPageNum(1)` currently serve TWO callers: the mount/id-change
  effect (which a remount would make redundant) AND the "Couldn't load this book" `ErrorCard`'s
  `onRetry={loadMeta}` (same id, no remount — retry still needs that synchronous reset to visibly
  go back to "loading"). Fully removing the redundancy without breaking the Retry-visible-loading
  behavior requires restructuring `loadMeta` into two paths (or accepting a UX change where Retry
  no longer shows an intermediate loading state), which is a bigger, riskier change than the
  10-item scope calls for, and would need its own new tests to prove the Retry path still behaves
  correctly.
- The actual defect here was **documentation**, not logic: the reviewer verified (via
  `eslint --report-unused-disable-directives`) that the suppression is real and hides no bug — the
  only problem was that the comment pointed at the wrong mechanism (the async abort-guard) instead
  of the real one (the synchronous reset-on-`id`-change). Fixing the comment closes the actual
  finding — a future maintainer reading it now learns the correct hazard and why it's safe — without
  touching any behavior or risking a regression in the Retry flow.
- Per "Don't expand scope. If a recommended fix is wrong or would break a PRAISE item, pick a
  better fix and explain in FIX_REPORT" — this isn't a case of the recommended fix being *wrong*,
  but the lower-risk of the two explicitly-sanctioned options is the more defensible choice inside
  a fix-pass whose job is to close review findings, not redesign a component that reviewers already
  called "genuinely senior-level work."

New comment: `client/src/pages/UploadViewer.tsx:178-204` now explains that the rule fires on the
**synchronous** `setMetaState('loading')`/`setPageNum(1)` (and the no-`id` `setMetaState('error')`
branch) that run *before* `loadMeta`'s `await` — not on anything after it — and why that's safe on
both first mount (redundant no-op) and an `id` change without unmount (intentional, correctly
guarded reset).

## Note on C-S5's timeout override (not in the original 10, but load-bearing for the fix)

While wiring `onProgress`, I found the shared axios instance defaults to a **10-second**
request timeout (`client/src/services/api.ts:235`, explicitly documented there as sized for
"synchronous JSON endpoints" with callers of long-running routes expected to override it per-call
— the same pattern `services/grammarDrill.ts` and `services/writing.ts` already use for
Claude-wrapping calls). Without an override, a real ~200-300 MB book upload on anything but a very
fast connection would already fail with a misleading `code: 'timeout'` at the 10-second mark,
regardless of whether a progress percentage is shown — i.e. C-S5's progress feature would be
adding a percentage readout to a request that was already destined to abort. I added a 10-minute
per-call `timeout` override on the same `uploadBook` call I was already touching for `onProgress`
(`client/src/services/uploads.ts:222-231,259`), following the exact pattern already established
elsewhere in this codebase. This stays inside "atomic fixes: code + test + doc together" for the
one function being changed and doesn't touch the shared axios instance or any other caller.

## PRAISE items — verified untouched

- One-mounted-page memory bound + prefetch-next in the viewer: unchanged (`UploadViewer.tsx`'s
  `PageImage` still renders exactly one `<img>`; the prefetch effect at `:223-227` is untouched).
- Exact-snapshot optimistic rollback: `submitMove`'s `previousPages`/`previousPageNum` capture and
  rollback-on-catch logic (`UploadViewer.tsx:~305-346`) is unchanged; the only addition is the
  guard at the top of the function, which if anything makes the snapshot's correctness stronger
  (a second call can no longer race in and read the optimistic order as "previous").
- Thorough abort discipline: all three `AbortController` refs and their unmount-cleanup effects
  are untouched.
- Exact-set membership+size validation on `PATCH .../pages/order`: untouched
  (`server/src/routes/uploads.ts:408-435`); the new concurrency tests exercise it under real
  contention rather than modifying it.
- Two-phase placeholder renumber (`server/src/routes/uploads.ts:437-467`) and its comment: byte-for-byte
  untouched — the A-S2 tests prove it holds under real concurrent load rather than just by reading
  the code.
- `SELECT ... FOR UPDATE` serialization of concurrent PATCH/DELETE: untouched; now has a
  regression test instead of only being "argued from reading the code."

## Self-assessment against the Bar's "done" checklist

- **§0 P0 Robust by default** — the new `onProgress`/`cacheBust` paths degrade gracefully (missing
  `total` → no callback rather than `NaN`/divide-by-undefined; cache-bust is opt-in, never breaks
  the cache-friendly default path). The added `req.log` calls follow the existing `try/catch →
  next(err)` structure unchanged.
- **§0 P0 Correct/standard path, not the easiest** — B-S2's fix is the one-line guard the review
  itself identified as correct (not a broader debounce/lock-library dependency); B-S3 took the
  lower-risk of two explicitly-sanctioned options with the trade-off documented above, not silently.
- **§2.1 P0 No `any` / unchecked cast** — new code has zero `any`. Two narrow test-only casts exist
  (`config?.onUploadProgress as (e: AxiosProgressEvent) => void` in `uploads.test.ts`, needed
  because `AxiosRequestConfig.onUploadProgress` is optional and the test asserts it was actually
  set immediately before invoking it) — confined to test files, not shipped code.
- **§2.2 Rules of Hooks / never disable exhaustive-deps** — unchanged; the one pre-existing
  `set-state-in-effect` disable (a different rule) is now correctly documented, not removed
  blindly, per B-S3 above.
- **§2.6/§2.7 Accessibility** — the progress percentage rides the existing `role="status"
  aria-live="polite"` span (no new live region), so it announces the same way the static
  "Uploading…" text always did. The disabled row-open button (C-S4) uses the native `disabled`
  attribute — correctly removed from the tab order, consistent with the delete button beside it.
- **§5.2 P0 Every bug fix ships with a regression test that fails on the old code** — verified for
  every behavioral fix: B-S1's test fails without the `cacheBust` param (retry `src` would equal
  the pre-retry `src`); B-S2's test fails without the guard (2nd `reorderPages` call would fire);
  C-S3's fails without the `maxLength`/length-guard; C-S4's fails without `disabled={pending}`; A-S2
  is new coverage for an existing-but-untested guarantee. A-S1/B-S3/C-S1/C-S2 are non-behavioral
  (logging plumbing / doc correction / copy correction) and covered by asserting the *content* is
  now correct rather than a "used to fail" regression shape.
- **§5.3 Test quality** — no `sleep`, no wall-clock dependence; the concurrency tests use real
  `Promise.all` against a live Postgres testcontainer (deterministic on the *invariant* asserted,
  not on which side of the race wins, matching the existing `auth.mfa.test.ts` precedent exactly).
  Ran the two new server concurrency tests 3x back-to-back with no flake.
- **Clean tree** — no dead code, no leftover debug output. `getLogger` import removed from
  `server/src/routes/uploads.ts` once no longer used (would otherwise be a `noUnusedLocals`
  build failure — confirmed, `npm run build` catches this class of issue and it passed).

## Typecheck + test commands run, and results

**Client** — `client/tsconfig.app.json`/`client/tsconfig.node.json` write their incremental build
info under `node_modules/.tmp/`, and `node_modules/.vite-temp/` is used by Vite's config bundler;
both directories in this checkout are pre-existing **root-owned** (unrelated to this change — a
leftover from an earlier root-run environment setup), so a plain `tsc -b --force` /
`vitest run` here hits `EACCES` on write, not a code issue. I could not `chown`/`sudo` in this
sandbox (no passwordless sudo). Worked around by (a) temporarily pointing `tsBuildInfoFile` in
both tsconfig files at a scratch path for the `tsc -b --force` run, then reverting with
`git checkout -- client/tsconfig.app.json client/tsconfig.node.json` (confirmed zero diff
afterward), and (b) passing vitest's `--configLoader runner` flag (avoids the temp-file config
bundling path entirely — a supported, documented vitest/vite 6.1+ flag, not a code change).

```
cd client && npx tsc -b --force
# (after temporarily redirecting tsBuildInfoFile to a scratch path)
→ clean, zero errors. Reverted the two tsconfig files immediately after (git checkout --,
  confirmed no diff).

cd client && npx vitest run --configLoader runner \
  src/pages/UploadViewer.test.tsx src/pages/Uploads.test.tsx \
  src/components/UploadTypeModal.test.tsx src/services/uploads.test.ts \
  src/lib/errorCopy.test.ts
→ Test Files  5 passed (5)
  Tests  99 passed (99)

cd client && npx vitest run --configLoader runner   # full client suite, regression check
→ Test Files  95 passed (95)
  Tests  1125 passed (1125)
```

**Server**:

```
cd server && npm run build
→ tsc -p tsconfig.build.json — clean, zero errors.

cd server && npx vitest run tests/routes/uploads.test.ts
→ Test Files  1 passed (1)
  Tests  55 passed (55)   (53 pre-existing + 2 new A-S2 concurrency tests)

cd server && npx vitest run tests/routes/uploads.test.ts -t "concurrency"   # x3, flake check
→ 2 passed | 53 skipped, three times in a row, no flake.

cd server && npx vitest run   # full server suite, regression check
→ Test Files  51 passed | 1 skipped (52)
  Tests  951 passed | 4 skipped (955)
  Duration  649.07s
  (1 skipped file = tests/services/claude/real_smoke.test.ts, gated real-API smoke tests — 4
  skipped tests, not run in this environment by design. The previously-flagged
  tests/routes/lemmatize.test.ts "Kiwi unreachable → 502" flake did NOT reproduce this run — all
  9 of its tests, including that one, passed. Zero failures across the whole suite.)
```

Note on process hygiene: partway through this run I mistakenly ran `git stash` to compare a lint
error against the pre-change file state, which momentarily reverted the working tree while an
earlier (now-discarded) full-suite background run was still in flight. I caught this immediately,
ran `git stash pop` to restore all 12 changed files, verified `git diff --stat` matched pre-stash
exactly, killed the now-unreliable background run, and reran the full server suite AND the full
client suite fresh from the confirmed-clean tree (results above are from that clean rerun, not the
tainted one). The targeted `uploads.test.ts` file was also re-run standalone post-recovery (55/55
passed) and the concurrency tests specifically 3x back-to-back (no flake) as an extra
confidence check given the scare.

Nothing was committed, pushed, or deployed.
