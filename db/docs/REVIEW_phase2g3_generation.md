# REVIEW — Phase 2 Group 3: Claude GENERATION engine (F-027 / F-073 / F-068)

**Scope:** migrations 053/054 (+ tests), `POST /writing/generate`, `POST /reading/generate`,
`GET /reading/generated[/:id]`, the `generateWritingPrompt` / `generateStory` proxy methods,
`prompts/generation.ts`, config/schema additions, `tests/services/claude/generation.test.ts`.
**Branch:** `feat/phase2-g3-backend-logic` @ 897101f
**Reviewer:** independent senior review (did not author this code)
**Date:** 2026-07-10

## Verdict: **PASS** — 0 BLOCKER · 2 SHOULD-FIX · 3 NIT · 4 PRAISE

Every focus question resolves cleanly:

| Focus | Answer | Evidence |
|---|---|---|
| 054 reversible + user-owned (IDOR-404 on GET /generated/:id)? | **Yes** | Down is a destructive-gated `DROP TABLE IF EXISTS` that fully reverses the up (`db/migrations/054_generated_stories.down.sql:16`); read is one user-scoped query with uniform 404 (`server/src/routes/reading.ts:574-583`), proven cross-user in `server/tests/routes/generation.test.ts:290` |
| Story `topic` injection-guarded + capped? | **Yes** | `sanitizeUserInput` (marker reject + control-char strip + cap) at `server/src/services/claude/index.ts:603-606`; route Zod cap 500 (`reading.ts:431`); `<user_input>` wrap with close-tag re-assert (`prompts/generation.ts:170-175`); system prompt treats it as data (`generation.ts:143-147`); rejection fires **before** any SDK call (`tests/services/claude/generation.test.ts:184-190`) |
| Writing-prompt gen carries no free text? | **Yes** | `mode`/`rubric` are closed enums, body `.strict()` + refine (`writing.ts:268-277`); proxy input schema likewise closed (`models.ts:453-461`); the entire user turn is built from enum branches (`prompts/generation.ts:86-92`) |
| Claude output schema-validated + 502 on failure; INSERT only after success? | **Yes** | Tool-forced output Zod-parsed (`index.ts:1000-1010` → `ClaudeOutputSchemaError`, httpStatus 502); route calls proxy **before** INSERT (`reading.ts:491-511`); "Claude failure → 502 and writes NO story row" proven at `tests/routes/generation.test.ts:223` |
| 053 enum-add correct (value-only, 031/032 pattern)? | **Yes** | `ADD VALUE IF NOT EXISTS` only (`053_claude_route_generation.up.sql:30-31`); documented no-op down (`.down.sql`); post-commit usability + no-op-down + re-up proven in `db/tests/test_migration_053.py` |
| cacheTtl 0 for variety? | **Yes** | Defaults 0 for both routes (`config.ts:115-116`); `CacheStore.put` skips the write entirely on ttl 0 (`cache.ts:246-258`); temperature 1.0 for regenerate freshness (`prompts/generation.ts:109,194`) |

ADR-013 compliance: neither migration contains top-level tx control; 054's header documents
runner ownership and the no-`CONCURRENTLY` choice (`054...up.sql:50-54`). ADR-020 compliance:
sanitize → wrap → tool-forced → Zod → cache/usage → typed errors, all through the single proxy
module.

---

## Gates (targeted — full suites confirmed by parent: server 1181/0, db 56/0)

```
npx vitest run tests/routes/reading.test.ts tests/services/claude/generation.test.ts tests/db/claude_route_enum.test.ts
  → 3 files, 42 passed / 0 failed  (73.6s)
npx vitest run tests/routes/generation.test.ts   (the generation ROUTE suite — see NIT-3)
  → 1 file, 28 passed / 0 failed   (92.0s)
```

Total for this slice: **70 passed / 0 failed.**

---

## SHOULD-FIX

### SF-1 — `mapClaudeError` flattens proxy 4xx errors into a 502
`server/src/routes/reading.ts:597-604` and `server/src/routes/writing.ts:331-338` map **any**
error carrying `httpStatus` to `new UpstreamError(...)` → 502. But the proxy's error hierarchy
deliberately encodes client-fault statuses: `PromptInjectionRejectedError.httpStatus = 400` and
`ClaudeRateLimitError.httpStatus = 429` (`server/src/services/claude/errors.ts:36-48`). On
`POST /reading/generate` — the one generation route with free user text — a topic containing an
injection marker (e.g. English "ignore previous …") is correctly refused, but the client sees a
**502 upstream failure** instead of a 400 input rejection, and the proxy's own per-route limiter
surfaces as 502 instead of 429. That misclassifies attacker/typo input as an outage (5xx alert
noise) and tells the client "retry later" when the correct signal is "fix your input."

The fix is already half-built: `UpstreamError` accepts a `{ status }` override in `details`
(`server/src/middleware/errors.ts:67-87` — the comment explicitly says it was added for the
Claude-proxy 429/504 case). `mapClaudeError` should pass `err.httpStatus` through for
proxy-origin 4xx (these are the *proxy's* statuses, not Anthropic's — SECURITY.md §13.7's
"never forward upstream status" is about the Anthropic response, which stays hidden).

**Coordination:** the identical helper exists in `grammarDrill.ts:533`, `diagnostic.ts:1596`,
and `images.ts` — this is an inherited convention, not a Group-3 invention. Fix all four
copies together (or extract one shared helper) rather than diverging this route pair.
Not a BLOCKER: no injection passes through; the request is refused either way.

### SF-2 — hardcoded `temperature` + the `opus` alias is a latent Anthropic 400
`prompts/generation.ts:109,194` set `temperature: 1.0` unconditionally, and `MODEL_ALIAS.opus`
resolves to `claude-opus-4-7` (`server/src/services/claude/index.ts:307-311`). Sampling
parameters (`temperature`/`top_p`/`top_k`) are **removed on Opus 4.7 and return a 400**. Today
this is unreachable from the wire — both route body schemas are `.strict()` without a `model`
key (proven: `tests/routes/generation.test.ts:138,210` send `model: 'opus'` and get 400) — but
`WritingPromptGenInputSchema`/`StoryGenInputSchema` still *accept* `model: 'opus'`
(`models.ts:460,490`), so the first internal caller that opts into opus gets a hard,
non-retryable Anthropic 400 that will surface as an unmapped 500. This is a codebase-wide
pattern (every prompt builder sets an explicit temperature), so treat it as a coordination
item: either strip sampling params when the resolved model is `claude-opus-4-7` in
`client.ts`/`resolveModel`, or drop `'opus'` from the input schemas until it's supported.

---

## NIT

1. **`wrap()` duplicates `wrapUserInput()`** — `prompts/generation.ts:170-175` re-implements
   `sanitize.ts:127-137` but throws a plain `Error` instead of
   `PromptInjectionRejectedError`, so if that last-line guard ever fired it would surface as a
   500 rather than a 4xx/502-class typed error. It is unreachable (sanitize rejects both tags
   upstream), but importing the shared helper keeps one canonical wrapper.
2. **Stale chain comment in the 053 test** — `db/tests/test_migration_053.py:55-56` says
   `down --target 052` "rolls back 054 … then 053"; since 055 landed on this branch the same
   command also rolls back 055 first. The test still passes (055's down is destructive-gated
   and the flag is passed); comment only.
3. **Gate list vs. actual route coverage** — the route-level tests for this slice live in
   `server/tests/routes/generation.test.ts` (28 tests: persistence, no-half-state 502, IDOR,
   list scoping), not in `reading.test.ts` (which covers chapters/positions only). Future
   fixpass gate lists for this feature should name `tests/routes/generation.test.ts`
   explicitly — running only the prescribed three files would have skipped the IDOR and
   orphan-row proofs entirely.

---

## PRAISE

- **Orphan-row discipline is designed and proven, not asserted.** The Claude call precedes the
  INSERT (`reading.ts:491-511`), the rationale is documented at the route header
  (`reading.ts:56-59`), and the failure path is tested end-to-end ("Claude failure → 502 and
  writes NO story row", `tests/routes/generation.test.ts:223`). Persist failure after a
  successful generation is deliberately a route failure (500), with the gradeWriting contrast
  explained — exactly the right call for library content.
- **DB CHECKs as a floor under the Zod caps, with the km lesson cited.** 054's header
  (`054...up.sql:29-35`) explicitly applies the "never trust an API schema looser than the DB
  constraint behind it" lesson: Zod caps (title 200 / body 6000 / topic 500) sit strictly
  under the CHECK ceilings (300 / 20000 / 2000), so a schema-valid story can always persist
  and an API cap raise needs no migration.
- **Two-sided compile-time route exhaustiveness + runtime drift guard.**
  `ROUTE_NAMES … satisfies readonly RouteName[]` plus the `Exclude<>`-based assertion
  (`config.ts:187-209`) makes the union↔array pairing unforgeable, and
  `tests/db/claude_route_enum.test.ts` (green) pins the Postgres enum to it against a freshly
  migrated DB — the 031/032 drift class is structurally closed.
- **054's migration tests prove each guard by the write it must reject** — enum-cast rejection,
  every length CHECK, NULL-vs-empty prompt, trigger bump, FK CASCADE, and a down that runs
  against a *non-empty* table then re-ups (`db/tests/test_migration_054.py`). The 053 test even
  proves post-commit enum usability from a fresh connection — the exact failure mode the
  migration comment warns about.
