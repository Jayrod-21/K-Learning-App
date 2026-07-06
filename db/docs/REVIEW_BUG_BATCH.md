# Review — B-015 / B-007 / B-016 bug batch

Branch: `fix/b015-b007-b016-bug-batch`, reviewed at `HEAD` (`c0580b4`) against `HEAD~1`.
Independent read-only review. No edits made to the working tree.

## Verdict

| Bug | Verdict |
|---|---|
| B-015 (CSS overflow) | **APPROVE** — correct nesting, correct property choice, no regressions |
| B-007 (diagnostic header text) | **APPROVE** — both claims verified honest, no test to update |
| B-016 (429 retry_after) | **APPROVE** — units/shape match the client exactly, new test is a real regression test |
| **Overall** | **APPROVE, 0 blockers.** Three SHOULD-FIX notes for later (none gate this merge). |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **B-016 — `retry_after` is a static full-window value, not the actual remaining time.**
   `server/src/middleware/rateLimits.ts:62-68` hardcodes `retry_after: Math.ceil(cfg.RATE_LIMIT_WINDOW_MS / 1000)` at limiter-construction time. express-rate-limit supports `message` as a function `(request, response) => …` (confirmed in
   `server/node_modules/express-rate-limit/dist/index.cjs:663-668`, type `ValueDeterminingMiddleware<any>` in `dist/index.d.mts:322`), and at handler time `request.rateLimit.resetTime` (a `Date`) holds the real per-key reset. A client rate-limited 55s into a 60s window is told "try again in 60 seconds" instead of ~5. This is a safe overestimate (never tells the client to retry too early), so it's not a blocker, but it's a one-line-away precision fix: `message: (req) => ({ error: { code: 'rate_limited', message: 'too many requests', retry_after: Math.max(1, Math.ceil((((req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime?.getTime() ?? Date.now() + cfg.RATE_LIMIT_WINDOW_MS) - Date.now()) / 1000)) } })`.

2. **B-016 scope gap — `buildMedia`/`buildCheap`/`buildAuth` still return no `retry_after`.**
   `buildMedia` (`rateLimits.ts:91-102`) shares the same `userOrIpKey` strategy as `buildExpensive` but wasn't touched; `buildCheap`/`buildAuth` (`:35-46`, `:72-86`) are per-IP and also untouched. Correct scope call for *this* P3 ticket — the only live UI consumer of `ApiError.retryAfter` today is `Writing.tsx:131-134`, wired to the expensive bucket (`grade-writing`) — so expanding further would be speculative. But it leaves an inconsistent contract: any 429 from media/cheap/auth still carries zero retry hint. Worth a follow-up ticket, not a gate on this diff.

3. **B-015 — the same overflow shape likely reproduces in sibling row types.**
   `.km-resources__entry-row`, `.km-resources__dict-row`, `.km-resources__list-row` (`client/src/styles/index.css:3849-3860`) are CSS grids with `fr` tracks and no `min-width:0`/`overflow-wrap` on their text cells — the identical `min-width:auto` grid gotcha this fix targets in "This Week." Not in scope for B-015 (which is specifically the weekly-suggestions strip), but a long dictionary headword/gloss in the main Reference browse list will overflow the same way. Flagging for the backlog, not this PR.

### NIT

- B-016: the new test's assertion order (`code` then `retry_after` type then `> 0`) is clear and matches AAA; no issue, just noting it's a good regression-test shape worth reusing for other 429 bodies if the scope gap above is ever closed.
- B-007: the code comment at `Diagnostic.tsx:992-995` is unusually good — it explains *why* the string changed and pre-empts the "should Level 4 be dynamic?" question a future reader would ask. Worth keeping as the house style for text-only fixes.

### PRAISE

- **B-015**: the `min-width:0` placement is exactly right at *both* grid levels that needed it — `.km-resources__week-col` (outer `1fr 1fr` track) and `.km-resources__suggest-kr`/`-en` (inner `1.2fr 1.6fr auto auto` track) — matching the actual DOM nesting in `Reference.tsx:270-315`/`339-345` rather than guessing at one level and hoping it cascades (it wouldn't have). Using `overflow-wrap: anywhere` instead of the more common `break-word` is the technically correct choice here: `anywhere` (unlike `break-word`) is counted toward the element's min-content contribution, which is the actual property the grid track-sizing algorithm reads — `break-word` alone would have left the track-sizing overflow unfixed even though it looks like the "same kind" of property. This is a subtle, correct call.
- **B-007**: rather than fabricating a timestamp or leaving a lie in place, the fix traced the real data flow (`resultsSnapshot = freshSnapshot ?? snap.data`, both `DiagnosticSnapshot` — confirmed neither carries `capturedAt`, only the separate `DiagnosticHistorySnapshot` used by Progress does) before deciding to drop the claim. That's verifying the premise, not just silencing the symptom.
- **B-016**: `messageFor` in `Writing.tsx:130-134` already had a fully-formed dead branch waiting for exactly this field (`err.retryAfter !== undefined`) — the fix identifies and completes an existing contract instead of inventing a new one, and the accompanying test proves the wiring end-to-end rather than just checking the config object shape.

---

## Detailed

### B-015 — `client/src/styles/index.css:3823-3846`, `client/src/pages/Reference.tsx:169-345`

- `client/src/styles/index.css:3815-3822` — `.km-resources__week-cols` is the outer grid (`1fr` mobile / `1fr 1fr` ≥640px).
- `client/src/pages/Reference.tsx:270-292` (vocab) and `:293-314` (grammar) — both render a `<div className="km-resources__week-col">` as the direct grid item of `.km-resources__week-cols`. `index.css:3829` adds `min-width: 0` to exactly this class — correct target, applies uniformly to both columns (no differential regression between vocab and grammar).
- `client/src/pages/Reference.tsx:339-345` (`SuggestRow`) — `<li className="km-resources__suggest-row">` (grid, `1.2fr 1.6fr auto auto` at `index.css:3836-3843`) contains `<span className="kr km-resources__suggest-kr">`, `<span className="km-resources__suggest-en">`, the level pill (`km-resources__suggest-level`, untouched, `min-width:36px` fixed), and the Add `<Button>` (untouched, intrinsically auto-sized). `index.css:3845-3846` adds `min-width:0; overflow-wrap:anywhere` to exactly the `.kr`/`.en` cells — the two `fr`-tracked columns — leaving the two `auto` columns (level pill, button) untouched as they should be (they're meant to stay content-sized, not shrink).
- Verified `.km-resources__suggest-row` (`<li>`) itself needs no `min-width:0`: its parent `<ul class="km-resources__suggest-list">` is a plain block list (`list-style:none`, no `display:grid/flex`), so the `<li>` is a normal block box whose width is set by its containing block (100% of `.km-resources__week-col`), not by content — the `min-width:auto` shrink-refusal only applies to grid/flex *items*, so this level was correctly left alone.
- Confirmed `overflow-wrap: anywhere` (not `break-word`) is the deliberate, correct choice: `anywhere` is factored into the box's min-content size (which is what the grid track-sizing algorithm consults to decide whether a `fr` track can shrink below its content), while `break-word` only affects visual line-breaking after sizing is already decided — using `break-word` here would not have fixed the actual overflow.
- Korean-text tradeoff: Hangul precomposed syllable blocks are single Unicode codepoints, so `anywhere` breaks land only *between* syllables, never mid-glyph — visually acceptable, unlike English where `anywhere` can split mid-word. English gloss text (`.km-resources__suggest-en`) can therefore break mid-word in a tight column; this is an accepted, correct tradeoff vs. the prior silent overflow, and only triggers on unbreakable strings wider than the column already at min-content sizing (most glosses have spaces, which win normally as break points first).
- Pattern precedent: `client/src/styles/index.css` already uses the identical `flex:1; min-width:0` idiom in ~12 other places (`:1551`, `:1688`, `:2640`, `:2802`, `:2850`, `:2908`, `:2927`, `:3393`, `:3528`, `:4090`) for the same "let a flex/grid child truncate/wrap instead of overflowing" problem — this fix is idiomatically consistent with house style.

### B-007 — `client/src/pages/Diagnostic.tsx:971-1002`, `client/src/types/domain.ts:341-357`

- `client/src/types/domain.ts:341-347` — base `DiagnosticSnapshot` interface has exactly four fields: `dimensions`, `references`, `defaultRef`, `goals`. No timestamp field.
- `client/src/types/domain.ts:349-357` — `DiagnosticHistorySnapshot extends DiagnosticSnapshot` adds `capturedAt: string` specifically because `/diagnostic/history` needs it and `/diagnostic/latest` doesn't carry it — confirming the split is deliberate, not an oversight.
- `client/src/pages/Diagnostic.tsx:120-161` — `snap = useEndpointOrMock<DiagnosticSnapshot>(...)` and `freshSnapshot: DiagnosticSnapshot | null` (state) both use the base type; `resultsSnapshot = freshSnapshot ?? snap.data` (`:161`), passed straight into `ResultsBlock` (`:248-255`). There is no code path by which `ResultsBlock` (`:971`, `snapshot: DiagnosticSnapshot`) could ever receive a `capturedAt` — confirms the comment's claim that a timestamp was genuinely underivable at this call site, not merely unused.
- `server/src/routes/diagnostic.ts:668,697,719` — `defaultRef: 'L4'` is a hardcoded literal returned by the server in every snapshot-building path (both the empty/first-run case at `:697` and the populated case at `:719`) — confirms "TOPIK II Level 4" (`Diagnostic.tsx:1001`) reflects a genuine app-wide fixed target today, not a per-attempt value the fix is incorrectly ignoring.
- Test check: `grep -rn "completed 5 min ago\|Your results" client/src --include=*.test.tsx --include=*.test.ts` and a read of `client/src/pages/Diagnostic.test.tsx` (results-related tests at lines 176-274, 468, 497-506) turned up no assertion on either the old or new header string — no test needed updating, none is stale.

### B-016 — `server/src/middleware/rateLimits.ts:48-70`, `server/tests/routes/gradeWriting.test.ts:112-135`

- `client/src/services/api.ts:79-111` — `ServerErrorBody.error.retry_after` (unknown, optional) parsed into `ApiError.retryAfter` only when `typeof === 'number' && Number.isFinite(...) && > 0`. The new field at `rateLimits.ts:66`, `Math.ceil(cfg.RATE_LIMIT_WINDOW_MS / 1000)`, is always a positive finite integer — passes the guard, correct field name (`retry_after`, snake_case matching the wire contract already used by the 423 lockout path), correct nesting (`error.retry_after`, matches `ServerErrorBody`), correct unit (seconds — `RATE_LIMIT_WINDOW_MS` is milliseconds per `server/src/config/index.ts:102`, and the fix divides by 1000 + ceilings before sending).
- `client/src/pages/Writing.tsx:130-134` (`messageFor`) — `err.retryAfter !== undefined` branch renders `Try again in about ${Math.ceil(err.retryAfter)} seconds`; this branch existed before the fix (built for the 423 case per the diff's own comment) and was dead for 429s until this change supplied a real value.
- Verified `res.send(message)` sends the configured object verbatim as JSON (`server/node_modules/express-rate-limit/dist/index.cjs:663-668`): `const message = typeof config.message === "function" ? await config.message(request, response) : config.message; … response.send(message);` — so the test's `res.body` is exactly the literal configured in `rateLimits.ts`, with no framework-level reshaping to account for.
- Confirmed the new test genuinely regression-tests the fix (not just re-asserting the fix's own shape): pre-fix `message` (`git show HEAD~1:server/src/middleware/rateLimits.ts`) has no `retry_after` key at all, so `body429.error.retry_after` would be `undefined` and `expect(typeof err?.retry_after).toBe('number')` (`gradeWriting.test.ts:132`) fails against the old code — confirmed via static diff + the `res.send()` behavior above (did not need to mutate the tracked file to prove this).
- Ran `npx vitest run tests/routes/gradeWriting.test.ts`: **10/10 pass**, including `POST /grade-writing — rate limit > expensive-bucket exceeded → 429 with a numeric retry_after (B-016)`.
- Ran the full client suite (`npx vitest run` in `client/`): **61 files / 590 tests pass**, no regressions from the B-015/B-007 changes.
