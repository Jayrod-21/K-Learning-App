# FIX — Client Services ↔ Server Contract Integrity (sweep batch)

Fix pass over the findings in `SWEEP_client_contracts.md` + `FOLLOW_UPS.md`
F-UP-015, restricted to the client-contract file scope (services, domain
types, mock fixtures, `useEndpointOrMock`, MockMode, Images/OCR page).
Every fix carries a regression test that FAILS without it — verified by
temporarily re-introducing the pre-fix behavior for the three HIGHs and
watching 8 tests fail, then restoring.

**Verify (prescribed docker gate): TC=0 · LINT=0 · 68 test files / 727 tests
all pass.** (Also ran `tsc --noEmit -p tsconfig.app.json` explicitly — the
root `tsc --noEmit` checks nothing under this repo's project-references
layout.)

## ⚠️ FLAG FOR RE-REVIEW — behavioral changes to the mock-fallback policy

Two changes alter app-wide runtime behavior in production and should be
re-reviewed deliberately:

1. **`useEndpointOrMock` (finding #3, HIGH).** When `realFn` rejects in a
   PROD build, the hook now propagates the error (`data: null`,
   `error: <real failure>`) instead of silently resolving the mock fixture.
   DEV behavior is unchanged (fixture fallback + 🅂 badge + error still
   surfaced). Mock-ONLY sources (no `realFn`) still resolve their fixture in
   prod — that's an explicit choice, not a silent substitution. **Every
   consumer was audited for an error path with `data === null`:**
   Topik (`error && draw.length === 0` branch), Diagnostic (`fatalError` →
   ErrorCard), Mistakes (ErrorCard), Today (ErrorCards per source), Images
   (`error && captures.length === 0` card), Chat (`hasNothingToShow` →
   ErrorCard + retry — it doesn't destructure `error`, but null data lands in
   the same card), Hanja (error gate at `Hanja.tsx:226`), Grammar
   (null-data+error → ErrorCard), Settings (statusQuery gated; me/prefs
   degrade to useAuth/localStorage values and never consumed mock fallback
   data anyway — their sync effects skip `isMock`), Progress (`fatalError` →
   ErrorCard), Review (null+error → error branch). Tests: real-failure →
   error surfaced + mockFn NEVER called; mock-only source still works in
   prod; refetch-after-prod-failure retry path.
2. **MockMode's own inline fixture fallbacks (same failure class, same
   file scope).** The exam-fetch fallback (`loadTopikMockTest`) and the
   submit fallback (`submitTopikMockTestMock` — the offline pseudo-grader
   that marks choice 'b' correct) are now gated to non-PROD builds too. In
   prod, a failed fetch shows the retryable ErrorCard; a failed submit shows
   "Retry submit", which re-sends the SAME picks (`pendingSubmitRef`) — no
   user work lost, no fabricated score presented as a real grade. This was
   not an explicitly enumerated sweep row (the sweep's #3 cites the hook),
   but it is the identical fake-data-as-real-in-prod mechanism; revert the
   two `import.meta.env.PROD` guards in `MockMode.tsx` if re-review judges
   the "exam always opens" posture more important than grade fidelity.
   Tests: prod fetch-fail → error card + fixture loader never consulted;
   prod submit-fail → retryable error + pseudo-grader never runs + retry
   re-sends identical answers.

## Dispositions

| # | Sev | Finding | Disposition | Test |
|---|-----|---------|-------------|------|
| 2 | HIGH | `MockReveal.itemId` string-vs-number → review list gutted | **FIXED.** `types/domain.ts`: `MockReveal.itemId` is now `string` (matches the wire's `i.id::text`). `MockMode.tsx` `buildMockResultsSummary` indexes `Map<string>` keyed by `it.id` directly. `MockSubmitAnswer.itemId` stays `number` (server zod `z.number()`) — the asymmetry is real and now documented. **Mock fixture fixed:** `data/mocks/topik.ts` `submitTopikMockTestMock` returns `itemId: it.id` (string) instead of the masking `Number(it.id)`. | `MockMode.test.tsx`: all reveal fixtures are wire-faithful strings; the results test now asserts each row resolves its prompt, number, picked/correct choice text and that no `'—'` fallback renders. Confirmed failing (4 tests) with the old numeric-map lookup. `topik.test.ts` fixture updated to strings. |
| 1 | HIGH | `image_words` carry no server `id`; banking one word marks EVERY word Added | **FIXED.** `types/domain.ts`: `OcrWord.id` removed (wire sends `kr/en/gloss/pos` only). `services/images.ts`: `ImageWordWire.id` removed, mapping drops it. `pages/Images.tsx`: new `ocrWordKey(word, index)` = `` `${index}:${word.kr}` `` keys the React rows and the per-capture added-set; `addWord`/`onAddOne`/`onAddAll` thread the derived key. **Mock fixture fixed:** `data/mocks/images.ts` words no longer carry invented `id:'w1'…`. | `Images.test.tsx`: new "banking ONE word marks only THAT word Added" — asserts exactly one Added pill, the second word still bankable, and `mineWord` fires for it. Confirmed failing (2 tests) under the shared-key pre-fix behavior. `images.test.ts` asserts the mapped word has NO `id`. |
| 3 | HIGH | `useEndpointOrMock` resolves fixture data on real failure in PROD | **FIXED** — see re-review flag above. | `useEndpointOrMock.test.ts`: 3 new PROD-posture tests via `vi.stubEnv('PROD', true)`. Confirmed failing (2) without the gate. |
| F-UP-015 | P3 | Resume-fetch failure silently drops the banner | **FIXED.** `MockMode.tsx`: `resumeFailed` state; the resume catch sets it, the select screen renders a fixed-copy `role="status"` notice ("Couldn't resume your saved test — start a fresh one below."), cleared on fresh start / new mock / next resume attempt. | New test: resume click + rejected re-fetch → notice visible, banner gone, sections still startable, notice clears on fresh start. |
| — | cleanup | Stale `data/mocks/settings.ts` (wire shape that never existed) | **DELETED.** Verified nothing imports it (only two stale doc-comment mentions inside `Settings.tsx`, which is outside this batch's file scope — flagged for whoever owns that page). Also removed the now-orphaned `Settings` interface from `types/domain.ts` (its only consumer was the deleted mock; `NotifPrefs`/`PalettePrefs` remain, and `lib/settings.ts` has its own local `Settings`). | Compile-level (tsc). |
| 5 | MED | SSE error-body parser drops `retry_after` | **FIXED.** `services/sseStream.ts` non-OK path extracts `retry_after` with the same finite-positive guard as the axios path and threads it onto `ApiError.retryAfter`. | `sseStream.test.ts`: 429 body with `retry_after: 42` → `retryAfter: 42` on both the rejection and the `onError` arg; malformed (`-5`) → dropped. |
| 6 | MED | `streamPath: 'query'` targets an endpoint that never streams (409 trap) | **FIXED.** Option removed from `StreamMessageOptions`; `streamMessage` always targets `/messages/stream`. No caller ever passed it (verified by grep). Header comment documents why the option was a live trap. | `conversation.test.ts`: URL is the `/stream` suffix with no query string; the old `'query'` test removed. |
| 7 | MED | Whitespace-only `q` → server 400 → Vocabulary tab error card | **FIXED at the service boundary.** `services/vocab.ts` `normalizeSearchOpts`: trims `q`, DROPS it entirely when empty (whitespace = browse, not error). Applies to `searchEntries` + `searchEntriesPage`, so Reference and Review converge without touching `Reference.tsx` (out of scope). | `vocab.test.ts`: `q: '   '` → no `q` param sent; `q: '  학교 '` → `q: '학교'`. |
| 9 | MED | Uncapped per-item `timeMs` 400s the whole mock submit (exam ungradeable) | **FIXED.** `MockMode.tsx` clamps each `timeMs` to `MAX_ITEM_TIME_MS = 3_600_000` (the server schema cap) in `buildBody`. | New fake-timer test: answer item 1, let the full 70-min budget elapse (auto-submit) → the submitted `timeMs` is exactly `3_600_000`, not the raw ~4,200,000. |
| 10 | LOW | `blobUrl` built relative → capture images broken in dev | **FIXED.** `services/images.ts` `blobUrlFor` joins `getApiBaseUrl()` (`base === '' ? path : base+path`), exported with an injectable `base` mirroring `ttmik.ts` `buildAudioSrc`. Prod (same-origin, empty base) byte-identical. | `images.test.ts`: relative in prod posture; joined under a dev base. |
| 11 | LOW | Persist-fail SSE frame's server prose rendered in the chat error chip | **FIXED (client side).** `services/conversation.ts` special-cases `code === 'persistence_error'`: substitutes fixed copy ("The reply streamed but could not be saved. Retry to send it again.") — `Chat.tsx` renders `err.message`, so the fix lands without touching Chat. NOTE: the server-owning agent has concurrently hardened the same frames (`AppError.message : 'persistence failed'`), so this is now defense-in-depth on both sides. | `conversation.test.ts`: a frame carrying raw pg prose ("duplicate key value violates…") rejects with the fixed copy and the prose absent from the surfaced error. |
| 12 | LOW | `recovered_text` (the full streamed reply) silently dropped | **FIXED (boundary half).** `ApiError` gains optional `recoveredText`; `conversation.ts` threads the frame's `recovered_text` onto the `persistence_error` ApiError. `Chat.tsx` still rolls the bubble back (out of scope) — but the recovery payload now survives the service boundary for the Chat owner to consume. | Same test: `recoveredText: '부분 답'` asserted on rejection + `onError` arg. |
| 13 | LOW | `/grammar/kgiu` + `/grammar/bank` leak BIGINT `id` as string | **FIXED at the service boundary.** `listPatterns` / `listBanked` coerce `id: Number(id)` per row (idempotent if the server routes later add their own coercion). | `grammar.test.ts`: string-id wire rows → numeric ids out. |
| 14 | LOW | `/progress` `MetricSnapshot.id` / `StudyLogResult.id` string-typed as number | **FIXED.** `updateMetric` / `logStudy` coerce `id: Number(id)`; `minutes_studied` deliberately stays a string (documented wire type). | `progress.test.ts`: coercion tests for both. |
| 15 | LOW | `logStudy` minutes uncapped → >24 h wall-clock silently loses the day's log | **FIXED at the service boundary.** `logStudy` clamps `minutes` to `[0, 1440]` (server schema `nonnegative().max(1440)`), so `Review.tsx`'s fire-and-forget caller is covered without editing it. | `progress.test.ts`: `minutes: 1500` → body `1440`; `-3` → `0`. |
| 4 | MED | `/vocab/entries`, `/vocab/lists`, `/vocab/lists/:id` BIGINT ids as strings | **FIXED at the service boundary** (root cause — the missing int8 parser / server-side `Number()` — is server-owned and out of scope; a server fix stays compatible since `Number()` is idempotent). `searchEntries`/`searchEntriesPage` coerce entry `id`; `listLists` coerces list `id`; `getListDetail` coerces `list.id` + each `entry_id`. | `vocab.test.ts`: string-id wire fixtures → numeric ids on all three surfaces. |

## Skipped (with reasons)

- **#8 (grammar `?q=` exact-equality search)** — the defect is the server's
  `AND pattern = $3` semantics (`routes/grammar.ts`, server-owned) plus a
  missing `maxLength` on `Reference.tsx`'s input (page not in this batch's
  scope). No client-service-level fix exists that wouldn't lie about server
  behavior. Left for the server/Reference owners.
- **#16 (`LoginResponse.user` narrower than declared)** — truthfully
  narrowing the type ripples into `Login.tsx`/`AuthProvider` (both owned by
  another agent in this sweep); absorbed today by Settings' self-heal. Left
  for the auth-page owner with this pointer.
- **#17 (Hanja `encountered` vs `targetL4` universes)** — the fix is a
  semantic change in `Hanja.tsx` (not in scope) and/or the server counting
  query; adjusting only `mocks/hanja.ts` would desync the mock from the
  page's current reading without fixing anything.
- **Non-defect notes** (`sourceTest: null` on an empty mock section —
  guarded; `plan.ts` `'L5+'` outside `LevelLabel` — renders as text, and
  widening the union risks breaking exhaustive `Record<LevelLabel,…>` maps
  in pages outside this scope; `ttmik.is_dialog` `boolean|null` — consumer
  reads truthiness) — left as documented latent items.

## Files touched

- `client/src/types/domain.ts` — `MockReveal.itemId: string`, `OcrWord.id`
  removed, `Settings` interface removed (all documented in place)
- `client/src/hooks/useEndpointOrMock.ts` — PROD gate + contract docs
- `client/src/pages/topik/MockMode.tsx` — string-keyed reveal lookup,
  resume-fail notice, `timeMs` clamp, PROD fixture gates
- `client/src/pages/Images.tsx` — derived `ocrWordKey`, keyed added-set
- `client/src/services/{images,sseStream,conversation,vocab,grammar,progress,api}.ts`
- `client/src/data/mocks/{images,topik}.ts` (wire-faithful);
  `client/src/data/mocks/settings.ts` **deleted**
- Tests: `useEndpointOrMock.test.ts`, `MockMode.test.tsx`, `Images.test.tsx`,
  `images.test.ts`, `sseStream.test.ts`, `conversation.test.ts`,
  `topik.test.ts`, `vocab.test.ts`, `grammar.test.ts`, `progress.test.ts`

## Verification detail

- `docker run … npm ci && npx tsc --noEmit; npm run lint; npx vitest run`
  → **TC=0, LINT=0, 68 files / 727 tests passed** (full suite, since the
  hook change is app-wide).
- Explicit `npx tsc --noEmit -p tsconfig.app.json` → 0 errors (the root
  `tsc --noEmit` under `"files": []` + references validates nothing — worth
  fixing in the VERIFY recipe).
- Fail-without-fix check: re-introduced the pre-fix behaviors for the three
  HIGHs (numeric map keying, shared-undefined word key, unconditional mock
  fallback) → 8 targeted tests failed exactly as designed; restored.
