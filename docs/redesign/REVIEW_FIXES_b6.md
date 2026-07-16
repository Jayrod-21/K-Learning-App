# Re-Review — Batch 6 fix-pass verification (server follow-ups)

Independent re-reviewer; did not write the code, the original reviews, or the fix-pass. Branch `worktree-agent-a1fd8330d7b581634` @ `3c0a4be`, fix-pass diff `e76c55d..3c0a4be`, full batch diff vs `rebuild`. Inputs: `REVIEW_b6-errors.md` (R1, PASS), `REVIEW_b6-notif.md` (R2, PASS), `FIX_REPORT_b6.md`.

## Summary verdict: **PASS**

The fix-pass is exactly what it claims: doc + nit polish, four items fixed, four items skipped with sound reasons, zero contact with the contract/leak logic the originals PASSed. Every fix-report claim verified against the actual diff and source. Gates re-run independently — all green.

## Fix-pass diff scope (verified, `git diff e76c55d 3c0a4be`)

Four files only:

| File | Change | Nature |
|---|---|---|
| `server/src/routes/settings.ts` | doc-comment expansion on `deriveNotifFromSchedules` (lines 228-258) | comment-only — every changed line inside the `/** */` block; zero code |
| `server/src/services/kiwi.ts` | `isTransient` gains `'UND_ERR_BODY_TIMEOUT'` + comment (lines 128-141) | one array entry |
| `server/tests/routes/grammar.test.ts` | `it.each` tuples gain 4th column + one `expect(res.body.error.message).toBe(wireMessage)` | test-only, strictly additive (nothing removed or weakened) |
| `docs/redesign/FIX_REPORT_b6.md` | new report | docs |

No touch to `errors.ts` (mapper), `grammar.ts` (route), `lemmatize.ts`, `notificationDelivery.ts`, `Settings.tsx`, or any of the settings route code. **Confirmed doc + nit-only.**

## Finding-by-finding

### 1. R2 SHOULD-FIX 1 (doc-only) — VERIFIED FIXED
`server/src/routes/settings.ts:231-252`. The "exact inverse" claim is now scoped to "what 064's backfill PRODUCES", and all three lossy legacy classes are enumerated matching R2 §1 precisely: (1) `channel.email: true` with all kinds false → derives `email: false`; (2) `channel.sms: true` → derives `sms: false` unless post-064 sms rows; (3) kind true with `channel.email: false` → derives kind false. Each is attributed to 064's own documented drop, drift noted as wire-only with no consumer affected. R2 NIT 2 (push-channel invisibility) is also covered in the same comment (`settings.ts:253-258`) as the review requested. Cross-checked against the derive implementation (`enabledEmailKind` keying, `rows.some` predicates) — the comment describes the code accurately. Zero code change in the hunk.

### 2. R1 NIT 1 — `UND_ERR_BODY_TIMEOUT` — VERIFIED CORRECT, NO LEAK CHANGE
Classification is right: undici's `BodyTimeoutError` (body stalls after headers, thrown by `res.body.text()` at `kiwi.ts:70`) is the same transient class as `UND_ERR_HEADERS_TIMEOUT`, which was already listed.

Leak trace re-done independently for the new path: body-timeout on attempt 1 → catch at `kiwi.ts:96` → not `ValidationError` → `lastErr = err` → now `isTransient` → `continue`. Body-timeout again on attempt 2 → same, loop exhausts. Post-loop: `lastErr` is the undici error, NOT an `UpstreamError`, so `kiwi.ts:107` doesn't fire → falls to `kiwi.ts:110-114`: cause logged server-side via `serializeErr` (name/message only, log-only), wire gets `new UpstreamError('kiwi unreachable')` — fixed server-minted message, no `details`. Mixed case (attempt 1 → 5xx, attempt 2 → body-timeout) also safe: `lastErr` is the timeout error → same `kiwi unreachable` path. **No path puts raw text or details on the wire; the R1-traced leak table still holds, with row "non-transient body timeout / opaque 500" now replaced by "transient → retry → fixed 502".** Behavior change is retry-classification only, exactly as claimed.

Minor observation (not a condition): no test pins the new classification — `isTransient` is unexported and a real body-stall fake costs a 5s+ hang per attempt, so the omission is defensible for a nit; the exhaustion path itself is already covered by the `ECONNREFUSED`/unreachable tests.

### 3. R1 NIT 3 — grammar message-pin test — VERIFIED REAL
`server/tests/routes/grammar.test.ts:816-846`. The `it.each` matrix's 4th column carries the exact expected wire message and the new assertion is `expect(res.body.error.message).toBe(wireMessage)` — an exact-match assertion on the actual response body of a real supertest request against the injected broken proxy, not a mock echo. Pins cross-checked against `server/src/middleware/errors.ts`: 429/`ClaudeRateLimitError` → `'too many requests — please slow down and try again shortly'` (`errors.ts:119`); 400/`PromptInjectionRejectedError` → `'your message could not be processed'` (`errors.ts:118`); 503/`ClaudeUnavailableError` → non-4xx branch → `DEFAULT_UPSTREAM_MESSAGE` = `'the AI assistant is temporarily unavailable — please try again'` (`errors.ts:122-123`). All three match verbatim. The pre-existing status/code/absence assertions are untouched.

### 4. Skipped nits — ALL REASONABLY SKIPPED
- **R1 NIT 2** (`mapClaudeError` 4xx `details: { status }` on wire): fixing it means changing the `UpstreamError` status-override mechanism or errorHandler details forwarding — a wire-shape change inside the PASSed F-193/F-124 mapper, explicitly out of a polish pass's scope. Reviewer already rated it pre-existing, server-minted, gated 400-499, harmless. Legitimate backlog item, not a dodge. (Verified `errors.ts:174-175` unchanged by the fix-pass.)
- **R2 NIT 3** (sequential SELECTs → `Promise.all`): perf micro-opt inside PASSed contract-adjacent route logic; reviewer called it trivial. Correct risk/benefit call.
- **R2 NIT 4** (`loadPrefsMock` client-originated notif): R2 itself deferred this to "the final client contract step" together with the outgoing-PUT notif. Skip follows the reviewer's own disposition.
- **R2 NIT 5** (test seed loop): test-only taste; correctness-neutral. Fine.

None of the skips buries a correctness issue; all four were NIT-severity in reviews that PASSed with zero blockers.

### 5. No regression to the PASSed work — VERIFIED
- **F-195 kiwi leak**: all throw-path constructors still message-only; `logUpstreamDetail`/`serializeErr` still log-only; header comment intact. The only kiwi.ts change is the `isTransient` array (§2).
- **F-193 mapper**: `errors.ts` and `grammar.ts` untouched by the fix-pass; the R1-pinned "B4 throws → 500 (no leak)" and the proxy matrix (now stronger) still pass.
- **F-093 contract**: `settings.ts` code, `settings.test.ts`, `Settings.tsx` all untouched (comment-only hunk). Direct-DB no-dual-write assert, derivation matrix, cross-user isolation — all still in place and passing.
- **scheduleId**: `notificationDelivery.ts` + its test untouched.
- Full-batch diff vs `rebuild` (12 files, +681/-129) matches the union of the reviewed e76c55d diff + this fix-pass; nothing extraneous.

## Gates (re-run independently from the worktree, exact)

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `cd server && npm run typecheck` | **0 errors** (exit 0) |
| Server targeted | `cd server && npx vitest run tests/services/kiwi.test.ts tests/routes/lemmatize.test.ts tests/routes/grammar.test.ts tests/routes/settings.test.ts` | **4 files passed, 123/123 tests passed** (151.2s; benign pre-existing pg `client.query()` deprecation warning) |
| Client targeted | `cd client && npx vitest run src/pages/Settings.test.tsx` | **1 file passed, 58/58 tests passed** (7.9s) |

Count reconciliation: the fix report's 131 (5 files) = my 123 (this gate's 4 files) + notificationDelivery.test.ts's 8; equivalently 123 = R1's 94 − notificationDelivery (8) + R2's settings (37). No unexplained deltas — the message-pin fix added assertions inside existing `it.each` rows, not new test cases, so grammar's count is unchanged.

## Recommendation

**SHIP.** Both original reviews PASSed with zero blockers; the fix-pass applied the one SHOULD-FIX (doc) and two worthwhile nits faithfully, skipped the rest for defensible scope reasons, and provably touched none of the reviewed contract/leak logic. Gates green. Suggested (non-blocking) backlog entries: R1 NIT 2 (`details: { status }` wire posture) and a body-timeout classification test if kiwi retry logic is ever touched again.
