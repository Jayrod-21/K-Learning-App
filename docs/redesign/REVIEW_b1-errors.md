# Review

Branch `feat/beta-phaseB1-reliability` @ 8a38fd9 (base `rebuild`). Scope: F-124 (no more raw `${code}: ${message}` leak) + F-094 (consolidate the 4 private `mapClaudeError` copies onto the shared helper).

Files reviewed: `server/src/middleware/errors.ts`, `server/tests/middleware/errors.test.ts`, `server/src/routes/grammarDrill.ts` (+ test), `server/src/routes/diagnostic.ts` (+ test), `server/src/routes/conversation.ts`, `server/src/services/imageIngest.ts`, `server/tests/routes/images.test.ts`.

## Summary verdict

**REQUEST CHANGES**

The new shared `mapClaudeError` mechanism itself (whitelist + `DEFAULT_UPSTREAM_MESSAGE` + server-side-only logging) is well-designed, exhaustively scoped, and well-tested — genuinely closes the leak for every path that reaches it. The grammarDrill.ts/imageIngest.ts wire-contract change (400/429 passthrough instead of blanket 502) is the *correct* call, not a regression: the underlying conditions (proxy-side input-validation failure, prompt-injection rejection, the proxy's own per-route rate limiter) are genuinely caller-triggered, not upstream outages. diagnostic.ts's "behavior-neutral" claim is also verified true — I traced it, it holds.

However, the review's core question was "does the client-facing body ever contain raw upstream detail now?" and the answer is **still yes, on three live paths that this diff does not close**: diagnostic.ts's own pre-existing pre-wrap (which the F-094 migration correctly left inert but does not fix), and two un-migrated duplicate private mappers (`enrich.ts`, `gradeWriting.ts`) that this diff's new doc-comment incorrectly implies no longer exist. None of these are regressions introduced by this diff, but they mean F-124's stated goal ("mapClaudeError no longer leaks to clients") is not actually true end-to-end, and the new code comment overclaims completeness. Given the fix for all three is mechanical (near-identical to what this diff already did four times), I'd request they be closed in this same pass rather than deferred again under a new ticket number.

**Blocker count: 2** (both pre-existing, not introduced by this diff, but squarely within the ticket's stated security goal and cheap to fix now).

## Findings

### BLOCKER

1. **diagnostic.ts's `buildGeneratedItem` pre-wrap still forwards raw `err.message` to the client, completely bypassing the new whitelist.** (`server/src/routes/diagnostic.ts:512-516`)
2. **`enrich.ts` and `gradeWriting.ts` retain un-migrated, un-hardened private copies of the exact pre-F-124 leaky mapper**, and the new doc-comment's "SINGLE shared mapper for every Claude-touching route" claim is false as written. (`server/src/routes/enrich.ts:46-52`, `server/src/routes/gradeWriting.ts:161-168`, doc claim at `server/src/middleware/errors.ts:150-155`)

### SHOULD-FIX

1. No test asserts that `mapClaudeError` actually calls the logger with the raw detail — the "log server-side instead of forwarding" half of F-124 is unverified.
2. `mapClaudeError` logs uniformly at `.warn` for both benign 4xx and true 5xx-class outages.
3. `UpstreamError`'s `details: { status }` (set on the 4xx branch) flows into the wire response body via the generic error handler — redundant, pre-existing, low severity.

### NIT

1. 429 responses carry no `Retry-After` header.
2. New tests (`errors.test.ts`, `grammarDrill.test.ts`, `images.test.ts`) assert on `error.message`/`error.code` but never on `error.details`, so the details-echo behavior above is neither pinned nor caught.

### PRAISE

1. Whitelist scoping in `middleware/errors.ts` is exhaustive and provably correct: only the three ClaudeProxyError subclasses whose `httpStatus` actually falls in 400-499 are ever eligible for a whitelist lookup; every 5xx-class subclass always flattens to the generic fallback regardless of `code`. Verified against `services/claude/errors.ts`'s full class list.
2. `errors.test.ts` is genuinely adversarial — parametrized across every real proxy error class plus synthetic edge cases (malformed `httpStatus`, unwhitelisted code, non-object/null), not just happy-path.
3. The 400/429 wire-contract change is the semantically right call, correctly reasoned in the code comment and independently verified by me: `ClaudeInputValidationError`/`PromptInjectionRejectedError` (400) and `ClaudeRateLimitError` (429) are genuinely caller-triggered conditions, not upstream outages, so passing the status through is more useful to the client than a blanket 502 "retry later" — and no upstream/provider text leaks either way.
4. diagnostic.ts's "behavior-neutral" claim holds up under trace: `buildGeneratedItem`'s `.catch` wraps every thrown error into `UpstreamError` (which carries `status`, not `httpStatus`) before `next(mapClaudeError(err))` ever runs, so `mapClaudeError` is provably a no-op there. Good instinct not to touch it in this pass — the bug (see BLOCKER 1) is elsewhere in that same function, pre-existing.
5. `images.test.ts`'s new F-094 suite checks persisted state (`image_captures` count == 0) alongside the HTTP shape, not just status codes.

## Detailed findings

### BLOCKER 1 — diagnostic.ts leaks raw upstream/network error text via its own pre-wrap

`server/src/routes/diagnostic.ts:501-516`:

```ts
const { result } = await proxy
  .generateDiagnosticItem(...)
  .catch((err: unknown) => {
    throw new UpstreamError(
      `diagnostic ${section} item generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
```

This directly interpolates the caught error's `.message` into a client-facing `UpstreamError`. Because `UpstreamError` (an `AppError` subclass) carries `status`, not `httpStatus`, it never satisfies `mapClaudeError`'s `'httpStatus' in err` guard (`middleware/errors.ts:158`) — so by the time this reaches `next(mapClaudeError(err))` at any of the four diagnostic.ts call sites (lines 934-936, 1074-1076, 1245-1246, 1420-1421), `mapClaudeError` is a no-op pass-through and whatever message was built here goes straight to the wire via `errorHandler`'s `AppError` branch (`errors.ts:191-197`).

Traced what `err.message` can actually contain at this catch site:
- `ClaudeInputValidationError` / `PromptInjectionRejectedError`: templated zod `path=message` text (`services/claude/index.ts:1143-1149`) — internal field-path detail, not raw secrets, but still more than the whitelist would ever allow through.
- `ClaudeOutputSchemaError` (`services/claude/index.ts:840`, `:1052`): `` `${route} output failed schema: ${parsed.errors}` `` — zod's default message format embeds the actual malformed value the model returned (e.g. an invalid `kind` enum value), so this can leak literal (if benign) model-output content into the client response.
- **Worst case — a raw, unwrapped error**: `services/claude/retry.ts:96-99` explicitly rethrows non-retryable errors "as-is": `throw err;`. Any Anthropic SDK error or Node/undici network error that `isRetryable()` doesn't recognize (SDK 400/404/413/422 shapes, TLS errors, connection errors whose `code`/message don't match the retry wrapper's known regexes) propagates unwrapped up through `generateDiagnosticItem`, and lands directly in this `.catch` as `err`, whose raw `.message` (potentially containing hostnames, ports, or literal SDK error text) is then embedded verbatim into the client response.

This is the **only** place in the reviewed surface where this happens — every other route (writing.ts:509, reading.ts:556/852, grammarDrill.ts:245/522, conversation.ts:1061-1062) calls `mapClaudeError`/`instanceof AppError` directly on the un-wrapped error, so a raw un-typed error correctly falls through to the generic opaque 500 (`errors.ts:199-205`) instead. diagnostic.ts's pre-wrap defeats that safety net for itself.

**Fix:** don't interpolate `err.message` into the client-facing message. Either `throw mapClaudeError(err)` directly here (dropping the local wrap entirely, since `mapClaudeError` already returns a safe `UpstreamError` for `ClaudeProxyError` instances and passes non-proxy errors through to the generic-500 safety net), or keep a generic fixed string (`` `diagnostic ${section} item generation failed` ``, no interpolation) and log the raw `err` server-side the same way `mapClaudeError` now does. Either way, this needs a route-level regression test exercising a raw (non-`ClaudeProxyError`) thrown error to pin that the client never sees it — no existing diagnostic.ts test covers this catch block's message content (`diagnostic.test.ts` has zero diff in this branch).

### BLOCKER 2 — enrich.ts / gradeWriting.ts still run the pre-F-124 leaky mapper, and the new doc comment overclaims

`server/src/routes/enrich.ts:46-52`:
```ts
if (err && typeof err === 'object' && 'httpStatus' in err) {
  const status = (err as { httpStatus?: number }).httpStatus ?? 502;
  const code = (err as { code?: string }).code ?? 'upstream_error';
  const message = (err as { message?: string }).message ?? 'claude error';
  next(new UpstreamError(`${code}: ${message}`, { status }));
  return;
}
```
`server/src/routes/gradeWriting.ts:161-168` carries the byte-identical pattern.

Both routes call `getClaudeProxy()` (confirmed via grep: `enrich.ts`, `gradeWriting.ts` are in the full list of Claude-touching route files) and both still forward the raw `${code}: ${message}` to the client on **every** status the proxy error carries — not even gated to 4xx, since `status` is taken directly from `err.httpStatus` (with `?? 502` only as an absent-value fallback). This is exactly the vulnerability F-124 exists to close (per `BUGS_AND_FEATURES.md:1358-1360`: "a future non-generic message would leak to the client... harden to only forward a whitelisted/generic message"), and it is still fully live on two real endpoints (`POST /enrich`, `POST /grade-writing`) after this diff.

The new doc-comment this diff adds at `server/src/middleware/errors.ts:150-155` states:

> "F-094: the SINGLE shared mapper for every Claude-touching route (writing.ts / reading.ts / grammarDrill.ts / diagnostic.ts / conversation.ts / imageIngest.ts)."

That list omits `enrich.ts` and `gradeWriting.ts`, and grep confirms both are Claude-touching routes with their own independent mapper — so "the SINGLE shared mapper for every Claude-touching route" is not an accurate description of the codebase this diff produces. F-094's own ticket text (`BUGS_AND_FEATURES.md:1164`) is honest about this ("`gradeWriting.ts`/`enrich.ts` already pass status through inline and can adopt the helper for free") but frames it as optional cleanup, not a live security gap — I'd push back on that framing given what "adopt the helper" actually buys here is closing the exact leak F-124 is about.

**Fix:** migrate both onto `mapClaudeError` in this same pass — it's a 2-line swap identical to the four already done in this diff (delete the inline block, `import { mapClaudeError } from '../middleware/errors.js'`, `next(mapClaudeError(err))`). If genuinely deferring, at minimum fix the doc comment to not overclaim, and re-file F-094's remainder at a severity that reflects "live client info leak," not P3/P4 hygiene.

### SHOULD-FIX 1 — the "log server-side" half of F-124 is untested

`server/tests/middleware/errors.test.ts` (new file) thoroughly pins that the client-facing message never contains raw detail, across 8 test cases. None of them assert that `getLogger().warn(...)` (`middleware/errors.ts:163-166`) is actually invoked with the raw `claudeCode`/`claudeMessage`/`claudeHttpStatus`. The doc comment's entire justification for the whitelist ("The raw code/message are still captured, but only in the server-side log line below") is therefore unverified — a future refactor could silently delete that `getLogger().warn(...)` call (e.g. during an unrelated logging cleanup) and no test would catch the resulting loss of server-side visibility into the underlying Claude failure. Recommend adding one test using `setLoggerForTesting` (`logging.ts:48-50`) with a spy/mock logger, asserting the `.warn` call's payload fields.

### SHOULD-FIX 2 — uniform `.warn` severity across benign-4xx and true-outage 5xx

`server/src/middleware/errors.ts:163-166` logs every mapped Claude error at `.warn`, regardless of whether it's a genuinely benign, expected client-fault (injection rejection, per-route rate limit) or an actual infra/config failure (`ClaudeUnavailableError`, `ClaudeAuthError` — API key rejected). This isn't a monitoring blind spot in practice — `services/claude/retry.ts:78-83` and `:91-96` already emit a separate `.error`-level log for those specific cases before throwing — but the second, redundant `.warn`-level log this diff adds for the same 5xx failure is inconsistent severity and slightly muddies log-based alerting/queries that filter on level. Minor; consider differentiating by the mapped status (>=500 → `.error`).

### SHOULD-FIX 3 — `UpstreamError`'s `{ status }` details leak into the response body (pre-existing, not introduced here)

`middleware/errors.ts:169`: `new UpstreamError(clientMessage, { status })` — the `{ status }` object becomes `this.details` on the `AppError` (constructor at `errors.ts:96-105`), and `errorHandler`'s `AppError` branch (`errors.ts:194`) serializes `details: err.details ?? undefined` straight into the JSON body. So every 4xx-mapped Claude error's response body carries a redundant `error.details.status` field (e.g. `{ "status": 400 }`) that duplicates the HTTP status already on the response. Not sensitive (it's just the status code again), and this exact pattern predates this diff (already present for writing.ts/reading.ts pre-F-124, per the removed comment "Shared by the generation routes (writing.ts / reading.ts)" at the top of the old diff hunk) — flagging only because it's adjacent to the "no leak" claim and worth a deliberate decision rather than an accidental one. Consider either omitting `details` entirely for `UpstreamError`, or explicitly documenting that `details.status` is intentionally wire-visible and safe.

### NIT 1 — no `Retry-After` on 429s

`ClaudeRateLimitError` → 429 passthrough (`middleware/errors.ts:167-170`) doesn't set a `Retry-After` header, so clients can't back off intelligently. Minor completeness gap, not a leak (the client message already says "please slow down and try again shortly").

### NIT 2 — new tests don't assert on `error.details`

`errors.test.ts`, `grammarDrill.test.ts` (`server/tests/routes/grammarDrill.test.ts:182-231`), and `images.test.ts` (`server/tests/routes/images.test.ts:221-296`) all check `res.body.error.message`/`.code` for the absence of raw text, but none inspect `res.body.error.details`. Given SHOULD-FIX 3 above, this means the details-echo behavior is currently neither pinned as intentional nor caught as a regression either way.
