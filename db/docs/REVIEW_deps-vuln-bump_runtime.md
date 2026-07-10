# Review: Server Dependency Bump — Dependency + Runtime Correctness

**Reviewer scope:** dependency correctness + runtime behavior of the bumps (`@anthropic-ai/sdk` ^0.80.0→^0.110.0, `uuid` ^10→^14.0.1, `vitest` ^2.1.8→^4.1.10 + vite 8, `@types/uuid` removed). Test-suite integrity is another reviewer's slice; vitest was not run here.

**Branch:** `worktree-agent-a866a005817c1f492` off `rebuild`, uncommitted.
**Files changed:** `server/package.json`, `server/package-lock.json`, `server/vitest.config.ts`, `server/tests/services/claude/real_smoke.test.ts` — nothing else.

---

## Summary verdict: PASS WITH CONDITIONS

Zero blockers. The audit goal is genuinely achieved (7 vulns → 0, verified live), typecheck and build pass, and every SDK API surface the app touches was verified byte-for-byte against the installed 0.110.0 types and dist — no silent semantic changes affect this codebase. The uuid@14 ESM-under-CJS question was tested at actual runtime (compiled `dist/` output, on the exact Node the production base image ships) and works. Conditions: the `node:20-alpine` base image is now an EOL runtime and carries the only real fragility introduced by this bump (uuid@14's undeclared Node ≥20.19 floor) — pin/upgrade it (SF-1).

---

## Findings index

| ID | Severity | Summary | Location |
|----|----------|---------|----------|
| SF-1 | SHOULD-FIX | `node:20-alpine` is floating **and** Node 20 is EOL (2026-04-30); uuid@14 needs ≥20.19 with no `engines` guard anywhere | `server/Dockerfile:16,28` |
| SF-2 | SHOULD-FIX (pre-existing) | `isRetryable()` name-check `'APIConnectionError'` never matches at runtime — SDK errors report `.name === 'Error'` on both 0.80 and 0.110 | `server/src/services/claude/retry.ts:151` |
| N-1 | NIT | Add `"engines": { "node": ">=20.19" }` to `server/package.json` to make the uuid@14 floor install-time-visible | `server/package.json` |
| N-2 | NIT (pre-existing) | SDK-internal retries (default `maxRetries: 2`) stack silently under `withRetry`, contradicting retry.ts's own header rationale | `server/src/services/claude/client.ts:178-182` |
| P-1 | PRAISE | The `SdkLike` seam absorbed 30 SDK minors with zero source changes | `server/src/services/claude/client.ts:115-156` |
| P-2 | PRAISE | Lockfile is clean, minimal, and honest | `server/package-lock.json` |

---

## Verification evidence (adversarial re-check, not trusted from any prior report)

### 1. Audit / typecheck / build — all verified PASS, real output

Run in the worktree at `server/`:

- `npm audit --audit-level=high` → **`found 0 vulnerabilities`**, exit 0. Plain `npm audit` also reports 0 total (so the fix cleared the 5 moderates too, not just the crit/high).
- `npm run typecheck` (`tsc --noEmit`) → exit 0, no output.
- `npm run build` (`tsc -p tsconfig.build.json`) → exit 0; `dist/` emitted (see §3 for a runtime load test of the compiled output).

### 2. SDK 0.80 → 0.110 runtime surface — verified against installed `node_modules`, not just "it compiles"

The app's entire SDK contact surface lives in `client.ts` (sole importer — confirmed by grep; `claudeProxy.ts:12` mentions the package only in a comment asserting it does *not* import it, so the ADR-020 §10 single-importer invariant holds). Each touchpoint checked against `node_modules/@anthropic-ai/sdk` 0.110.0:

| App usage | 0.110.0 reality | Verdict |
|---|---|---|
| `messages.create(req)` → `{id, model, stop_reason, content[], usage}` (client.ts:188-191) | Unchanged shape; `Usage.input_tokens`/`output_tokens` still non-nullable `number`; `cache_read_input_tokens`/`cache_creation_input_tokens` still `number \| null` — identical nullability to 0.80 (diffed both installed type files), and client.ts already guards the nullable ones with `?? 0` (client.ts:300-301) | ✅ same |
| `messages.stream(req, { signal })` two-arg call (client.ts:220-228) | `stream<Params>(body, options?: RequestOptions)` at `resources/messages/messages.d.ts:74`; `RequestOptions.signal?: AbortSignal` at `internal/request-options.d.ts:91` — the cast-around-`SdkLike` passthrough is still valid | ✅ same |
| `for await (const ev of stream)` (client.ts:237) | `MessageStream implements AsyncIterable<MessageStreamEvent>` (`lib/MessageStream.d.ts:22,118`) | ✅ same |
| `stream.finalMessage()` (client.ts:262) | `finalMessage(): Promise<ParsedMessage<ParsedT>>` (`lib/MessageStream.d.ts:108`) — resolves the same raw `Message` shape `normalizeResponse` expects | ✅ same |
| Stream event duck-typing `content_block_delta`/`text_delta`/`message_stop` (client.ts:246-253) | Wire event types unchanged; unknown events are already skipped by design | ✅ same |
| `cache_control: { type: 'ephemeral', ttl?: '5m' \| '1h' }` (client.ts:29-33) | `CacheControlEphemeral.ttl?: '5m' \| '1h'` — exact match | ✅ same |
| Error duck-typing by `status` (retry.ts:143-144, 163-167) | `APIError.status` still `readonly status` with the numeric HTTP code; subclass hierarchy (RateLimitError etc.) unchanged; `APIConnectionError.status === undefined` on both versions | ✅ same (but see SF-2 for the `name` check) |
| Constructor `new Anthropic({ apiKey, timeout, baseURL? })` (client.ts:178-182) | All three options present; `timeout` still milliseconds, default 10 min | ✅ same |

**New 0.110 behaviors checked for silent impact — none fire for this app:**

- **Non-streaming timeout guard** (new): 0.110's `messages.create` throws `AnthropicError("Streaming is required…")` for large `max_tokens` — but only when `this._client._options.timeout == null` (`resources/messages/messages.js:30-33`). This app always sets a client-level timeout (`CLAUDE_TIMEOUT_MS` has a Zod `.default(60_000)`, config.ts:32), so the guard is statically unreachable. Verified, not assumed.
- **Deprecated-model `console.warn`** (new): 0.110 warns to stderr (bypassing pino) for models in `DEPRECATED_MODELS` or `thinking.type=enabled` on certain models. The app's models (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7` — config.ts:19-21,40-44) appear in neither list. No log-noise regression.
- **New transitive runtime dependency:** `standardwebhooks@1.0.0` (plus its deps `fast-sha256`, `@stablelib/base64`) is now a direct dependency of `@anthropic-ai/sdk` (verified via `npm ls`) — it backs the SDK's new webhooks helper. Legitimate, unused by this app, ships in the production image. Acceptable; noted for awareness.
- **SDK-internal retry default:** `maxRetries` still defaults to 2 on both versions — no change from the bump (see N-2 for the pre-existing stacking concern).

Empirical error-shape check (both versions, run live):

```
0.110: new APIConnectionError({}) → name: "Error", msg: "Connection error.", status: undefined
0.80:  new APIConnectionError({}) → name: "Error", msg: "Connection error.", status: undefined
```

Identical — the bump does not change error classification behavior (see SF-2 for what this reveals).

### 3. uuid@14 ESM under the CJS server — verified at runtime, including the compiled artifact

- Installed `uuid@14.0.1` is **ESM-only**: `"type": "module"`, the `"node"` export condition points at `dist-node/index.js` which is `export {...}` ESM (no CJS build, no nested `package.json` overriding the type). **It also declares no `engines` field**, so npm gives zero install-time protection on an old Node — the failure mode is a runtime `ERR_REQUIRE_ESM` crash-loop.
- The server is CJS (`"type": "commonjs"`, `module: "commonjs"`); the single import site is `server/src/middleware/correlation.ts:13` (`import { v4 as uuidv4 } from 'uuid'`), which compiles to `require("uuid")` (confirmed in `dist/middleware/correlation.js:4`).
- This works only via Node's `require(esm)` support, unflagged in **Node ≥20.19** (and ≥22.12).
- **Runtime verification:** `require('./dist/middleware/correlation.js')` loads and `require('uuid').v4()` produces a UUID on local Node v20.20.2. ✅
- **Docker verification:** the `node:20-alpine` image cached on this machine (M — which per project memory is the production build+run host) was executed directly: it contains **Node v20.20.2** → satisfies ≥20.19. The image as it exists on the deploy host today runs this code correctly. ✅

So: works today, on the machine that matters. The residual risk is the tag, not the code — see SF-1.

### 4. package-lock integrity — clean

- Resolved versions match the manifest exactly: `@anthropic-ai/sdk@0.110.0`, `uuid@14.0.1`, `vitest@4.1.10`, `vite@8.1.4`; root-package dependency ranges in the lock (`^0.110.0`, `^14.0.1`, `^4.1.10`) match `package.json`. Lockfile v3.
- Every `resolved` URL in the lock points at `registry.npmjs.org` — no phantom registries or git/tarball URLs.
- `npm ls --depth=0` reports no invalid/missing/UNMET.
- All 40 net-new packages in the lock diff trace to expected parents: the rolldown/lightningcss family + `@standard-schema/spec` are vite 8 / vitest 4's tree (dev-only); `standardwebhooks`/`fast-sha256`/`@stablelib/base64` are SDK 0.110's webhooks dependency (§2). Nothing orphaned or unexplained.
- `@types/uuid` removal is complete and safe: absent from the lock, no references in `src/`, `tests/`, or any tsconfig, and typecheck passes — uuid@14 ships its own types (`./dist/index.d.ts` via the export map), which is exactly why the removal is correct rather than cosmetic.

### 5. Unrelated changes — none

`git status` shows exactly four modified files. The two non-dependency files are direct consequences of the vitest 2→4 major, not scope creep:

- `server/vitest.config.ts` — vitest 4 removed `poolOptions.forks.singleFork`; replaced with `fileParallelism: false`. The in-file comment correctly explains what `singleFork` was load-bearing for (sequential testcontainers, deterministic rate-limiter state) and why `isolate: true` is now kept.
- `server/tests/services/claude/real_smoke.test.ts` — moves `makeProxy()` from collection time into `beforeAll` so a skipped suite never reads env under vitest 4's per-file forks.

Both belong to the test-integrity reviewer's slice for correctness-of-tests judgment; from the dependency/runtime side they are appropriately scoped.

---

## Detailed findings

### SF-1 (SHOULD-FIX) — Pin/upgrade the Node base image: floating `node:20-alpine` is EOL and is the only guard for uuid@14's Node floor

`server/Dockerfile:16` and `server/Dockerfile:28` — both stages use floating `node:20-alpine`.

Three converging problems:

1. **uuid@14 requires Node ≥20.19 and declares no `engines`** (§3). `npm ci` succeeds on any Node; the failure is a runtime `ERR_REQUIRE_ESM` crash-loop on container start. A build on any machine with a stale cached `node:20-alpine` (< 20.19, plausible since Docker won't re-pull a floating tag without `--pull`) produces an image that passes build and dies at runtime. Today M's cache is 20.20.2 so this doesn't fire — but nothing *enforces* that.
2. **Node 20 reached end-of-life 2026-04-30.** The tag will never receive another security patch. In a PR whose entire purpose is dependency-vuln hygiene, shipping the runtime on an EOL Node is the same class of problem one level down.
3. The floating tag makes the deployed runtime unreproducible in general (blue/green protocol notes in project memory make rollback-parity matter here).

**Recommendation:** move both stages to `node:22-alpine` (LTS through 2027, `require(esm)` supported since 22.12 — current 22.x is well past that), or at minimum pin `node:20.20-alpine` with an explicit acknowledgment that it is EOL. Pair with N-1. Not a blocker because the code demonstrably runs on the image currently resolved on the production host — but this should land before or with this bump.

### SF-2 (SHOULD-FIX, pre-existing — not a regression of this diff) — `isRetryable()`'s `APIConnectionError` name check is dead code; plain connection errors are not retried by `withRetry`

`server/src/services/claude/retry.ts:151`:

```ts
if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
```

The SDK's error classes never assign `this.name` (verified in `core/error.js` on both installed versions), so instances report `.name === 'Error'` — empirically confirmed on 0.80 and 0.110 (§2). The check has never matched. Trace for a plain connection failure (`APIConnectionError`, message `"Connection error."`): `status` is `undefined` → name check fails → no `.code` → message regex `/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i` does **not** match `"Connection error."` → classified non-retryable and rethrown raw. This contradicts ADR-020 §6 ("Retryable: … any `APIConnectionError` from the SDK") and the route contract (raw SDK error instead of `ClaudeUnavailableError` → likely a 500 instead of the designed 502).

Mitigations that keep this out of blocker territory: (a) timeouts (`APIConnectionTimeoutError`, message `"Request timed out."`) DO match `/timeout/i` and retry correctly; (b) the SDK internally retries connection errors twice before surfacing (default `maxRetries: 2`); (c) **behavior is byte-identical on 0.80, so this bump changes nothing** — flagged because this review's job was to verify the error-shape contract, and the verification exposed it.

**Recommendation (follow-up, not necessarily this PR):** replace the name check with `err instanceof Anthropic.APIConnectionError` (client.ts could export a type-guard through the seam to keep retry.ts SDK-import-free per ADR-020), or `e.constructor?.name === 'APIConnectionError'` (verified to work: `constructor.name` IS the class name), or add `connection error` to the message regex. Add a regression test constructing a real `APIConnectionError`.

### N-1 (NIT) — Declare the Node floor in `package.json`

`server/package.json` has no `engines` field. `"engines": { "node": ">=20.19" }` (plus CI/local `engine-strict`) turns SF-1's silent runtime crash into a loud install-time error on any under-versioned Node. Cheap insurance that uuid upstream declined to provide.

### N-2 (NIT, pre-existing) — SDK-internal retries stack under `withRetry`, contrary to retry.ts's own stated design

retry.ts's header says the wrapper exists *instead of* the SDK's `maxRetries` ("The SDK retries silently; we want WARN-log + cost row"), but `client.ts:178-182` never sets `maxRetries: 0`, so the SDK's default 2 silent retries run *inside each* `withRetry` attempt — worst case 4 × 3 = 12 upstream attempts on a flapping 429/5xx, with the inner 8 invisible to logs and dashboards. Unchanged by this bump (default was 2 on 0.80 too). Consider `maxRetries: 0` in the constructor to make ADR-020 §6 the single retry authority.

### P-1 (PRAISE) — The `SdkLike` seam did exactly what it was designed to do

`client.ts:115-156`'s minimal structural type over the SDK (`create`/`stream`/`finalMessage` + raw snake_case response shape) meant a 30-minor-version bump required **zero source changes** in the Claude module — and this review could verify the seam against the new SDK point-by-point instead of auditing a diff. The comment at client.ts:214-219 anticipating exactly this kind of upgrade ("a future SDK upgrade that renames the option only requires touching this one site") aged well: the two-arg `stream(req, {signal})` shape is still the real 0.110 signature. Don't let a future refactor replace this seam with direct SDK type imports.

### P-2 (PRAISE) — Honest, minimal lockfile

The lock diff is exactly the three bumped trees plus the SDK's one new dependency — no opportunistic drive-by bumps of unrelated packages, all-npmjs resolution, and the `@types/uuid` removal was done properly (verified no dangling references) rather than left to rot.

---

## Coordination observations (for the aggregator / other reviewer)

1. **`vitest.config.ts` + `real_smoke.test.ts` belong to the test-integrity reviewer's verdict.** From this slice they are legitimate bump consequences, not scope creep. The material judgment call the other reviewer should ratify: the migration from `singleFork: true` (shared process) to `fileParallelism: false` + default `isolate: true` (fresh fork per file) changes test *isolation semantics*, not just scheduling — the in-file comment claims per-file isolation is now required for `vi.mock` in `pdfPageRender.bounds.test.ts` and `uploads.test.ts`, and that `tests/setup.ts` per-test resets cover the rest. That claim should be verified by actually running the suite (their slice, not mine).
2. **SF-1 (Dockerfile) technically touches a file outside the diff** — the fix-pass agent should treat it as an accompanying hardening change, and per project memory (`km_nginx_api_route_allowlist`, blue/green protocol) any base-image change must go through the normal IDLE-color deploy flow, never an in-place rebuild of the active color.
3. **SF-2 and N-2 are pre-existing** — if the fix-pass wants to keep this PR minimal (a defensible position for a dep bump), both can move to `BUGS_AND_FEATURES.md` as backlog items instead; they should not silently disappear.
