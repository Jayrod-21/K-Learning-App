# Review — b6-errors (F-195 kiwi hygiene, F-193 /identify mapper, scheduleId typing)

Reviewer: independent senior backend. Branch `worktree-agent-a1fd8330d7b581634` @ e76c55d vs `rebuild`.

## Summary verdict

**PASS — 0 BLOCKER, 0 SHOULD-FIX, 3 NIT, 3 PRAISE.**

Gates (exact): `npm run typecheck` → 0 errors. `npx vitest run tests/services/kiwi.test.ts tests/routes/lemmatize.test.ts tests/routes/grammar.test.ts tests/services/notificationDelivery.test.ts` → 4 files passed, **94/94 tests passed** (97.5s).

Traced every throw/catch path in `kiwi.ts` — no remaining path puts raw upstream text on the wire. Status-override hole genuinely closed. F-193 preserves no-leak 500 for non-proxy errors + correct 4xx passthrough / 5xx flatten. scheduleId string end-to-end, runtime-pinned by test.

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

1. **`isTransient` omits `UND_ERR_BODY_TIMEOUT`** — `server/src/services/kiwi.ts:128-132`. Body-stall after headers throws raw undici `BodyTimeoutError` from `res.body.text()` (kiwi.ts:70) → non-transient (kiwi.ts:100) → route `next(err)` → generic opaque 500, not retry+502. **No leak** (generic handler emits only `something went wrong`), pre-existing behavior, outside this diff's error-hygiene scope. Note if fixing: catch handles it correctly either way.
2. **`mapClaudeError` 4xx passthrough puts `details: { status }` on the wire** — `server/src/middleware/errors.ts:175` + errorHandler details forwarding at errors.ts:200. Server-minted number gated to 400–499, harmless, but slightly inconsistent with the "no details" posture the diff otherwise enforces. Pre-existing, not introduced here.
3. **F-193 test doesn't pin the whitelisted message string** — `server/tests/routes/grammar.test.ts:815-847` asserts status + `upstream_error` code + raw-text absence but not e.g. 429 → `'too many requests — please slow down and try again shortly'`. Absence assertion is the substantive one; message pin is a cheap addition.

### PRAISE

1. **F-195 is complete, not cosmetic.** Every constructor in kiwi.ts now takes message-only (kiwi.ts:75, 79, 84, 93, 114); raw body/cause/Zod issues moved to server-side logs with correlationId and 500-char truncation (kiwi.ts:121-126). The header comment (kiwi.ts:11-21) documents both the leak class and the override hole.
2. **Status-override regression test is a direct reproduction** — `tests/services/kiwi.test.ts:123-131` feeds upstream body `{"status": 200}` on a 500 and asserts wire status stays 502. Exactly the hole, exactly the fix.
3. **Wire-level absence assertions are real** — lemmatize tests assert `res.text` lacks `'boom'` / `'bad input'` / `'ECONNREFUSED'` AND `details` undefined (tests/routes/lemmatize.test.ts:123-124, 135-147, 161-164), against a real HTTP fake + real undici, no module mocks.

## Detailed

### F-195 — kiwi.ts leak trace (every throw path)

| Path | Site | Wire message | Raw detail destination | Leak? |
|---|---|---|---|---|
| Upstream 400 | kiwi.ts:71-76 | `kiwi rejected input` (fixed) | `logUpstreamDetail` (kiwi.ts:74) | No |
| Upstream 5xx (both attempts) | kiwi.ts:77-80 → rethrow kiwi.ts:107 | `kiwi <status>` (status = undici numeric, not upstream text) | log (kiwi.ts:78) | No |
| Upstream 3xx/4xx≠400 | kiwi.ts:82-85 | `kiwi <status>` | log (kiwi.ts:83) | No |
| Zod parse fail | kiwi.ts:86-94 | `kiwi returned malformed payload` (fixed) | `issues` logged (kiwi.ts:89-92) | No |
| Network exhaustion | kiwi.ts:110-114 | `kiwi unreachable` (fixed) | `serializeErr` cause logged (kiwi.ts:111) | No |
| Non-transient throw (e.g. body timeout) | kiwi.ts:100 rethrow raw | n/a — non-AppError → errorHandler generic 500 `something went wrong` (errors.ts:205-211) | full stack logged (errors.ts:207) | No (see NIT 1) |

`safeParseJson`'s `{ raw: text.slice(0,500) }` fallback (kiwi.ts:134-140) now only feeds the Zod parse of a 2xx payload; on failure the raw never leaves the log. `serializeErr` (kiwi.ts:142-147) is log-only. Sole consumer of `lemmatize()` is `server/src/routes/lemmatize.ts:28` with plain `next(err)` — no re-attachment of details downstream.

**Status-override hole:** `UpstreamError`'s constructor honors `details.status` number (errors.ts:96-105). Pre-fix, kiwi.ts passed `safeParseJson(text)` (attacker/upstream-controlled) as details — a body `{"status": N}` rewrote our HTTP status. Post-fix no kiwi path passes details. Swept ALL remaining `new UpstreamError(...)` sites: errors.ts:175 (`{ status }` where status is the proxy's own `httpStatus`, type-checked number gated 400-499 at errors.ts:173 — trusted); diagnostic.ts:546, 558, 580, 957 — all message-only (diagnostic.ts:558 interpolates `result.kind`, but that value is schema-constrained to the `synonym|cloze|pattern` literal union before reaching the check). Hole closed globally.

**Tests assert absence, not just status:** service level `tests/services/kiwi.test.ts:100-121` (`details` toBeUndefined + `JSON.stringify(err)` lacks upstream text — AppError's public fields are enumerable so stringify covers details); wire level `tests/routes/lemmatize.test.ts:123-124` (400 body `bad input` absent), `:135-147` (502 body `boom` absent + `details` undefined), `:158-164` (unreachable: `ECONNREFUSED` absent + `details` undefined). Note the fixed 400 message `kiwi rejected input` contains the word `input`, so the `'bad input'` absence assertion is not vacuously satisfied by phrasing overlap — checked.

### F-193 — grammar.ts /identify

- `server/src/routes/grammar.ts:535-542`: catch → `next(mapClaudeError(err))`, matching the consolidated routes (writing/reading/grammarDrill/diagnostic/conversation/imageIngest/enrich/gradeWriting per errors.ts:150-153 doc, updated to list grammar.ts).
- Non-proxy path preserved: `mapClaudeError` returns `err` unchanged when no `httpStatus` key (errors.ts:164, 179) → errorHandler non-AppError branch → opaque 500. Pinned by pre-existing test `tests/routes/grammar.test.ts:778-798` ("B4 throws → 500 (no leak)", asserts `b4 internal` absent) — still passing, so no regression.
- Proxy path: new `it.each` matrix `tests/routes/grammar.test.ts:815-847` — 429/ClaudeRateLimitError→429, 400/PromptInjectionRejectedError→400, 503/ClaudeUnavailableError→502; all assert `error.code === 'upstream_error'` + `raw proxy failure detail` absent from full body. Wire-level via real supertest app with injected broken proxy — real tests, not mocks of the assertion target.

### scheduleId — BIGINT→string

- `server/src/services/notificationDelivery.ts:74-76`: `claimDelivery(scheduleId: string, ...)`; rationale doc at :68-73 matches the `deliveryId` string contract. Param feeds `query` `$1` directly — no `Number()`/`parseInt` coercion anywhere (`grep` swept `src/`; **zero production callers exist yet**, so no call-site breakage possible — type change lands ahead of the sender).
- Test pins runtime contract both ways: `tests/services/notificationDelivery.test.ts:57-61` (`seedSchedule` returns pg-native string) + `:73-76` (`expect(typeof scheduleId).toBe('string')` on the actual node-postgres value, not a cast).

### Gate transcript

- `npm run typecheck` — clean exit, 0 errors.
- `npx vitest run tests/services/kiwi.test.ts tests/routes/lemmatize.test.ts tests/routes/grammar.test.ts tests/services/notificationDelivery.test.ts` — `Test Files 4 passed (4)`, `Tests 94 passed (94)`. (One benign pg deprecation warning about `client.query()` overlap, unrelated to this diff.)
