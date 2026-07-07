# FIX: Sweep CRITICAL #1 — unobserved `sdkFinal` rejection crashes the server

Source: `db/docs/SWEEP_server_services.md` row #1. Status: **CONFIRMED REAL, FIXED, verified green.**

## Verification (traced before fixing)

1. `server/src/services/claude/client.ts:262` — `stream()` returns `final = stream.finalMessage().then(normalizeResponse)`. The `.then()` derives a NEW promise; if it rejects and no handler is ever attached, it is an unhandled rejection (the SDK's inner promise is "handled" by the `.then` registration, the derived one is not).
2. `server/src/services/claude/index.ts:623-686` (`generateConversation` worker) — `sdkFinal` was only awaited at :633, AFTER the `for await (const ev of sdkEvents)` loop at :628. On a mid-stream failure the Anthropic SDK rejects BOTH the event iterator and `finalMessage()`; the loop throw jumps to the catch at :678 and `sdkFinal` is never observed. The route-level `final.catch()` in `routes/conversation.ts` covers the proxy's outer `finalPromise`, not this inner promise.
3. `server/src/index.ts:47-50` — `process.on('unhandledRejection', ...)` logs fatal and calls `process.exit(1)`.

Net: one dropped/errored/aborted chat stream → whole API server exits, killing all in-flight requests. Single call site (`this.client.stream` appears only in the conversation worker). The existing stub's `{error}` path could not surface this: it rejects `finalMessage()` with an EMPTY event stream, so the loop completes and `await sdkFinal` handles the rejection — only an iterator-level mid-stream throw triggers the bug.

## Fix (minimal)

`server/src/services/claude/index.ts` — immediately after destructuring `client.stream(...)`:

```ts
void sdkFinal.catch(() => undefined);
```

Observes `sdkFinal` on every path the instant it exists. `.catch()` derives a separate promise, so the happy-path `await sdkFinal` still receives the original value/rejection unchanged; a mid-stream error now surfaces solely through the worker's existing catch (queue `error` event + rejected `finalPromise`), which the route already handles.

## Process-level handler: deliberately unchanged

`src/index.ts` still exits on `unhandledRejection`. Reasons:
- All deploy compose files (`docker-compose.yml`, `Deploy/docker-compose.{blue,green,shared}.yml`) run `restart: unless-stopped` — the container self-heals in seconds.
- The file's own header states the fail-loud/supervisor-restarts philosophy; Node guidance treats an unhandled rejection as unknown program state, and log-and-continue risks limping with corrupted state (worse for a personal app than a brief restart).
- The primary fix removes this crash vector at its source; softening the global handler would mostly mask future bugs of the same class rather than fix them.

## Regression test

`server/tests/services/claude/index.test.ts` — `generateConversation — streaming > mid-stream failure surfaces as a handled stream error — no unhandled rejection`.

- Stub extension in `tests/services/claude/setup.ts`: new `StubResponseSpec.streamError` makes the stub emit deltas, then reject the iterator mid-stream AND reject `finalMessage()` with the same error (real SDK shape). The stub pre-observes only its inner promise; the client's derived promise — the one under test — gets no artificial handler.
- Asserts (a) the consumer receives `start` → `delta`s → terminal `error` event and `final` rejects with the original error (normal handled path), and (b) a `process.on('unhandledRejection')` probe stays empty across two macrotask turns.
- Proven to catch the bug: with the source fix stashed, the test fails with `[Error: simulated mid-stream connection drop]` escaping as an unhandled rejection; with the fix, it passes.

## Verify result

`docker run … node:20-slim … npx tsc --noEmit && npx vitest run tests/services/claude tests/routes/conversation.test.ts`:

- **STC=0** (typecheck clean)
- **Test Files 10 passed | 1 skipped (11); Tests 125 passed | 4 skipped (129)** (skips = env-gated real-API smoke suite)

Files changed:
- `server/src/services/claude/index.ts` (fix + comment)
- `server/tests/services/claude/setup.ts` (`streamError` stub capability)
- `server/tests/services/claude/index.test.ts` (regression test)
