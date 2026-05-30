# REVIEW — Pass 3B services (P3B)

Reviewer: Independent senior (30 yrs). Did not author.
Scope: 10 service modules + 10 test files + `src/types/domain.ts` additions.
Date: 2026-05-29.

---

## Verdict

**PASS WITH CONDITIONS** — boundary contract (api.ts / `ApiError`) is preserved cleanly, TS strict discipline holds across the board, sseStream is conservatively engineered with most of the right defences in place, and tests exercise the documented contracts. The streaming layer has two real gaps worth fixing before P3B ships (Content-Type sanity check, dual-callback contract for the `event: error` SSE protocol event), plus a handful of smaller hygiene items. No BLOCKERs.

| Category    | Count |
|-------------|-------|
| BLOCKER     | 0     |
| SHOULD-FIX  | 5     |
| NIT         | 7     |
| PRAISE      | 9     |

---

## BLOCKER

(none)

---

## SHOULD-FIX

### SF-1 — `sseStream.ts` does not validate `Content-Type: text/event-stream` on the response

`sseStream.ts:147-172` checks `response.ok` and parses error envelopes for non-OK responses, but never inspects `response.headers.get('content-type')` on the success path. An upstream misconfiguration that returns `200 OK` with `Content-Type: text/html` (a stray reverse-proxy intercept page, a 200 SSO redirect, a B4 endpoint accidentally returning JSON) silently produces zero events and resolves `onDone()` — the UI shows a "successful empty turn" instead of an actionable error. The threat-model comment header at lines 11-16 names SSE as the contract but nothing enforces it on the wire.

Mitigation: after the `if (!response.ok …)` block, read `response.headers.get('content-type')`; if it does not start with `text/event-stream` (case-insensitive, ignoring `;` parameters), reject with `ApiError({ code: 'stream_parse', message: 'unexpected content-type' })`. The eval criteria explicitly call this out and it costs ~6 lines.

### SF-2 — `streamMessage` fires `onError` twice when the server emits an in-band `event: error`

`conversation.ts:115-117` translates an SSE-level `event: error` into `opts.onError?.(new Error(ev.data || 'stream error'))` — synchronously, while the parser is still inside the read loop. The stream then continues to read; if the server follows that error event with EOF, `onDone` ALSO fires (line 120 maps `opts.onDone` through). If the server instead drops the connection, `sseStream` rejects and the same `opts.onError` is fired a SECOND time by the `onError: opts.onError` wiring at line 121.

Two real problems:
1. **Single-rejection discipline broken**: `sseStream.ts` document its contract as "After this, the promise also rejects" (line 51) — i.e. consumer gets one onError + one rejection. The conversation wrapper turns the in-band `error` event into a third notification path the consumer can't disambiguate from a transport error.
2. **Type drift**: `streamMessage.onError` is typed `(err: Error) => void` (line 68), but `sseStream`'s `SseHandlers.onError` is typed `(err: ApiError) => void`. The wrapper widens to plain `Error` at line 116, then narrows back via direct assignment at line 121 — the consumer can't tell which kind of error they have. `instanceof ApiError` works in practice but the type isn't telling them that.

Recommendation: define the contract in code. Either (a) on in-band `error`, ALSO abort the read loop so the rejection is the only notification, or (b) introduce a distinct `onStreamError(serverPayload: string)` callback for in-band errors and reserve `onError(err: ApiError)` for transport. (a) is simpler and matches how the SSE protocol expects an `error` event to be terminal anyway.

### SF-3 — `conversation.ts` re-derives `baseURL` from `import.meta.env`, bypassing `api.ts`'s tripwire

`conversation.ts:106-107` reads `import.meta.env.VITE_API_URL` and concatenates the path directly. This duplicates the same env access in `api.ts:127` and — more importantly — fetch-based streaming sidesteps the dev-mode `warnInsecureCrossOriginCookiePosture` warning that `api.ts:147-169` installs for axios users. If a developer mistakenly points `VITE_API_URL` at a cross-origin host over HTTP, axios calls warn but the streaming call silently 401s with no diagnostic.

Recommendation: export a `getApiBaseUrl(): string` (or `resolveApiUrl(path)`) helper from `api.ts` and have `conversation.ts` call it. One source of truth for "what's the base URL" + the warning fires once at module init regardless of which surface the dev hits first.

### SF-4 — Per-keystroke services missing `AbortSignal`

The eval criteria specifically flag this. Three services are realistic candidates for per-keystroke / per-drag invocation:

- `lemmatize(text: string)` — `lemmatize.ts:21`. Tokenisation is exactly the shape a "highlight a Korean sentence as the user types/drags" UI uses. No signal.
- `searchEntries(opts)` — `vocab.ts:50`. Search-as-you-type vocab search. No signal.
- `listPatterns(opts)` — `grammar.ts:34`. Same shape, search-as-you-type KGIU. No signal.
- `identifyPattern(body)` — `grammar.ts:68`. Drag-to-highlight → Claude identify. Expensive bucket + the user may keep adjusting the highlight. No signal.

`define` and `enrich` are less obvious (single tap → one call) but `identifyPattern` especially should accept a signal because each adjusted highlight should cancel the in-flight Claude call to avoid burning rate budget on a stale span.

The api wrapper already accepts `config` (signal lives in axios's `AxiosRequestConfig`) so the cost is one optional parameter per service:

```ts
export async function lemmatize(text: string, signal?: AbortSignal): Promise<LemmaToken[]> {
  const res = await api.post<LemmatizeResponse>('/lemmatize', { text }, { signal });
  return res.tokens;
}
```

Right now the only way to abort is to throw away the axios instance, which the call site can't do.

### SF-5 — `defineEntry`'s URL has a trailing slash that differs from every other route

`define.ts:22` posts to `/define/` (trailing slash). Every other service in this batch uses unsuffixed segments (`/vocab/entries`, `/grammar/kgiu`, `/conversation`). Trailing slashes are not semantically identical to unsuffixed paths in Express's default routing (the difference matters under strict routing or behind some reverse proxies that normalise one but not the other). The test at `define.test.ts:19` codifies the slash. Either:

(a) the server route is actually mounted at `/define/` (then document it inline so a future cleanup pass doesn't silently strip the slash and 404), or
(b) the slash is a typo and should match the rest of the surface.

Either way, the inconsistency is a footgun. The comment at `define.ts:13-16` discusses the `word`/`lemma` naming but says nothing about the trailing slash.

---

## NIT

### N-1 — `streamMessage.onError`'s parameter type widens to `Error`

`conversation.ts:68` types it `(err: Error) => void`; in practice the err is always either an `ApiError` (from `sseStream`) or a plain `Error` (from the in-band `error` event path at line 116). Tightening to `(err: ApiError | Error) => void` — or better, picking ONE shape per SF-2 — would let consumers branch on `err.code` without an `instanceof ApiError` guard.

### N-2 — `sseStream.ts` `findEventBoundary` double-scans the buffer per chunk

`sseStream.ts:257-263` calls `indexOf('\n\n')` and `indexOf('\r\n\r\n')` on the WHOLE buffer every loop iteration. For a 1 MB buffer hosting 1000 small events, this is O(n²). Real fix: track the last-scanned position so each call only scans the freshly-decoded suffix. Not a hot path today (events are small + most chunks land on boundaries) but worth a comment noting the bound if not fixed.

### N-3 — `parseSseBlock` accepts `\r\n` line endings inside a block but the split is `\n`-only

Line 82: `block.split('\n')`. A CR-LF–terminated event WHERE the boundary was detected as `\n\n` (the LF half of a CR-LF-CR-LF, in unusual misalignments) leaves a trailing `\r` on each non-final field line. The fix is a one-liner: `.replace(/\r$/, '')` on `raw` before classification, or change to `block.split(/\r?\n/)`. Today's test suite doesn't exercise this branch.

### N-4 — `stripUndef` only lives in `vocab.ts`; `grammar.ts` reinvents the same loop

`vocab.ts:146-153` and `grammar.ts:37-41` implement the same "filter undefined values into a Record<string, string|number>" pattern. Per Bar §2 "DRY with the rule of three" this is the second occurrence — fine to leave, but the third (it's coming when `reading.ts:39-47` gets options) should extract this to `services/_params.ts` or similar.

### N-5 — `auth.ts` imports `User` from `hooks/auth-context`, an unusual direction

`auth.ts:25` does `import type { User } from '../hooks/auth-context'`. This makes the services layer depend on the hooks layer (type-only, so no runtime cycle), which inverts the usual layering. The `User` type morally belongs in `types/domain.ts` next to `AuthMeResponse` — moving it there would let both hooks and services import from the same neutral type module.

### N-6 — `MAX_BUFFER_BYTES = 1_000_000` is bytes-named but checked against string `.length` (UTF-16 code units)

`sseStream.ts:73` calls itself `MAX_BUFFER_BYTES` and the comment at line 71 says "1 MB". The check at line 211 is `buffer.length > MAX_BUFFER_BYTES` — that's UTF-16 code units, not bytes. For all-ASCII the two agree; for Korean (the entire domain!) each char is 1 UTF-16 unit but 3 UTF-8 bytes. The cap is roughly 3× tighter in actual bytes than the name implies, and the comment about "Real SSE events from B4 are well under 64 KB" probably reasons in bytes. Either rename to `MAX_BUFFER_CHARS` or compare against a byte count. The current behaviour is *safer*, not less safe, so this is a NIT — but the name is misleading.

### N-7 — Conversation `onDone` test asserts `onError` is called for `event: error` but doesn't assert `onDone` is NOT also called

`conversation.test.ts:115-130`: the mock fires `onEvent({event:'error', data:'oops'})` then immediately `handlers.onDone?.()`. The test verifies `onError` was called but does NOT verify `onDone` was suppressed. Under SF-2's recommendation `event: error` should be terminal and `onDone` should NOT fire — once that contract is added, this test will need to assert it.

---

## PRAISE

### P-1 — `ApiError` boundary contract preserved across the board

Every service in this pass routes through `api.{get,post,patch,put,delete}` and unwraps the envelope at the call site (`auth.ts:30`, `vocab.ts:55`, `grammar.ts:42`, etc.). No service catches the `ApiError` to translate or swallow it — they all let it propagate. The Pass-1 PRAISE point about "one error type at the call site" survives.

### P-2 — `sseStream.ts` threat-model comment header is exemplary

Lines 18-36 enumerate FIVE attack/failure vectors with the specific defence for each: cookie posture, backpressure, abort, info leakage, error normalisation. This is the standing-orders-mandated format from CLAUDE.md done right; every other service file in this batch follows the same shape.

### P-3 — Reader cancel-on-abort race fix is correct

`sseStream.ts:178-181` adds the `abort` listener inline (with `{ once: true }`) and the read loop at line 191-198 also rechecks `signal.aborted` BEFORE the `done` branch. This is the bug the parent reviewer flagged pre-review (reader.cancel() resolves `done:true` instead of throwing), and the fix is the right pattern: don't rely on `read()` to reject on cancel; check the signal explicitly. The comment at lines 186-190 documents why.

### P-4 — `finally`-block listener cleanup

`sseStream.ts:248` removes the abort listener in the `finally`. A re-used `AbortController` (or a long-lived signal across multiple stream calls) won't leak listeners. Tidy.

### P-5 — Buffer overflow defence with a documented threshold

`sseStream.ts:71-73` + 211-218 caps the partial-event buffer at 1 MB with the rationale in the comment. The cap throws `ApiError({code:'stream_parse'})` — same shape as parse-error, so callers don't need a new branch. Defence-in-depth done quietly.

### P-6 — Optimistic concurrency wiring is faithful

`vocab.submitReview` (`vocab.ts:73`), `conversation.appendMessage` (line 44), and the `ReviewSubmission`/`AppendMessageBody` types all carry `expected_version`. The threat-model comments at `vocab.ts:13-15` and `conversation.ts:6-9` explicitly describe the 409 surface. Per SENIOR_ENGINEER_BAR §1 "Optimistic concurrency via the `version` column" the wire shape supports it end-to-end.

### P-7 — `updateMetric` `encodeURIComponent`s the path segment

`progress.ts:38-39` calls `encodeURIComponent(metricType)` before interpolating into the path. The unit test at `progress.test.ts:36-38` explicitly exercises the unsafe-char path. The comment isn't needed; the test names "defence in depth". This is the only path-interpolation site in the batch that does it explicitly, and metric_type is the only one that's a free-form string (the rest are numbers or string unions).

### P-8 — `X-Request-Id` plumbing for idempotency-by-request-id

`conversation.ts:78-83` + 127-129 forwards an optional `requestId` as `X-Request-Id`. The docstring is unambiguous about WHEN to reuse it ("on retry of the same turn — never on a different turn"). The implementation is the right shape: header only added when present, no header injection if blank/whitespace. Server-side dedup contract is documented in the option comment so a future maintainer can find it.

### P-9 — Test coverage hits the documented failure modes

Each service test file covers happy + at least one 4xx ApiError + one network ApiError (auth.test.ts, define.test.ts, lemmatize.test.ts, progress.test.ts, reading.test.ts, enrich.test.ts, grammar.test.ts, vocab.test.ts, conversation.test.ts). `sseStream.test.ts` specifically covers parse, multi-event split across chunks, comment lines, buffer overflow, abort mid-stream, transport rejection, and 4xx envelope mapping. Matches the eval criteria one-for-one.

---

## Cross-cutting observations

- **`verbatimModuleSyntax` / `erasableSyntaxOnly` discipline**: every service uses `import type` for type-only imports (`auth.ts:21`, `vocab.ts:22`, `grammar.ts:13`, etc.). No enums, no parameter properties. Clean.
- **No `any`**: confirmed by grep — no `: any` and no `as any` in any of the 10 service files. The `unknown` payloads in `domain.ts` (e.g. `EnrichResult.result: unknown`, `KgiuEntryDetail.examples: unknown`) are intentional escape hatches owned by B4/B2 and consumed by future enrichers, not type laziness.
- **CSRF/SameSite posture**: no service adds a custom `X-CSRF-Token`, every state-changing service threat-model comment explicitly references `SameSite=Strict` as the defence and the contingency if it ever loosens. Posture is consistent with `client/SECURITY.md` §2-3.
- **No axios internals leak**: the only axios surface any service touches is `AxiosRequestConfig` via the `api.{get,…}` wrapper signature, and only `vocab.ts` / `reading.ts` / `grammar.ts` use the `{ params }` field — `AxiosRequestConfig` is an exported axios type but it's used opaquely, not destructured for axios-only knobs. Boundary holds.

---

## Recommendation

Fix SF-1 (Content-Type check) and SF-2 (onError contract) before P3B merges — both are real correctness issues in the streaming path and both are cheap. SF-3/4/5 can land in the same fix-pass or as follow-ups; NITs at maintainer's discretion. PRAISE items in P-1, P-3, P-5, P-8 should be carried forward into a future FIXPASS3_AGGREGATE.md to protect against regressions.
