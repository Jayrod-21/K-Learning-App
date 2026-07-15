# Fix Report — B1 Reliability batch

Branch `feat/beta-phaseB1-reliability` (base `rebuild`). Independent fix-pass over the two review documents `REVIEW_b1-reliability.md` (R1) and `REVIEW_b1-errors.md` (R2). The fix author did not write the original code or the reviews.

Scope addressed: R2's two BLOCKERs (diagnostic.ts raw-error leak; two un-migrated leaky mappers + a false doc claim) and R1's SHOULD-FIX (F-125 proof test could not detect removal of the `AND title IS NULL` guard).

## Per-finding disposition

### BLOCKER 1 (R2) — diagnostic.ts `buildGeneratedItem` leaked raw `err.message` to the client — FIXED

`server/src/routes/diagnostic.ts`, `buildGeneratedItem` (the `.catch` on `generateDiagnosticItem`).

Before, the catch interpolated the caught error's `.message` into a client-facing `UpstreamError`:

```ts
.catch((err: unknown) => {
  throw new UpstreamError(
    `diagnostic ${section} item generation failed: ${err instanceof Error ? err.message : String(err)}`,
  );
});
```

Because `UpstreamError` carries `status`, not `httpStatus`, this bypassed the shared `mapClaudeError` whitelist entirely and rode straight to the wire via `errorHandler`'s `AppError` branch. Worst case (a raw, unwrapped Anthropic-SDK / undici network error rethrown verbatim by `retry.ts:96-99`) that put hostnames/ports/literal SDK text on the response body.

Fix: the catch now routes through the shared safe mapper.
- If `mapClaudeError(err) !== err` (a recognized `ClaudeProxyError` carrying `httpStatus`), the returned value is already a whitelisted, wire-safe `UpstreamError` (and `mapClaudeError` has already logged the raw `code`/`message` server-side). We rethrow that mapped error — so a proxy 400/429 now reads as 400/429 here too, consistent with every other Claude-touching route (the F-094 consolidation the reviewers praised).
- Otherwise (a non-proxy raw error, no `httpStatus`) we log the raw `name`/`message` server-side at `.error` level and rethrow a **fixed** generic `UpstreamError('diagnostic ${section} item generation failed')` — no interpolation. This preserves the route's existing "any generation failure is a 502" contract for raw errors while never forwarding raw text.

Client now sees a safe generic message + correct status; the server log keeps the real detail.

### BLOCKER 2 (R2) — two leaky mapper copies + false doc claim — FIXED

`server/src/routes/enrich.ts` and `server/src/routes/gradeWriting.ts` each still ran a byte-identical copy of the pre-F-124 mapper that forwarded raw `${code}: ${message}` to the client on every status:

```ts
if (err && typeof err === 'object' && 'httpStatus' in err) {
  const status = (err as { httpStatus?: number }).httpStatus ?? 502;
  const code = (err as { code?: string }).code ?? 'upstream_error';
  const message = (err as { message?: string }).message ?? 'claude error';
  next(new UpstreamError(`${code}: ${message}`, { status }));
  return;
}
next(err);
```

Both were migrated onto the shared helper — the same 2-line swap already applied to the four consolidated routes:

```ts
import { mapClaudeError } from '../middleware/errors.js';
// ...
} catch (err) {
  next(mapClaudeError(err));
}
```

The unused `UpstreamError` import was dropped from both files (verified: `grep UpstreamError` on both returns nothing).

The false doc comment at `server/src/middleware/errors.ts` (the `F-094` block) that claimed a "SINGLE shared mapper for every Claude-touching route (writing.ts / reading.ts / grammarDrill.ts / diagnostic.ts / conversation.ts / imageIngest.ts)" — omitting `enrich.ts` and `gradeWriting.ts` — was made TRUE and accurate: the list now includes `enrich.ts` and `gradeWriting.ts`, notes that several of the removed copies forwarded the raw `${code}: ${message}` (the exact leak F-124 closes), and documents that `diagnostic.ts`'s own pre-wrap now calls the helper too rather than embedding `err.message`.

### SHOULD-FIX (R1) — F-125 proof test was toothless — FIXED

`server/tests/routes/conversation.test.ts`, the "two concurrent first-name calls (F-125)" block.

Root cause (as R1 reproduced): both racing calls computed a byte-identical candidate title (the stub derived it purely from the same pre-write conversation content), so deleting the `AND title IS NULL` guard left the test green — with identical candidates, "both writes land" and "exactly one write lands" are indistinguishable from the response side.

Fix: the test now swaps in a `nameConversation` stub that folds a per-invocation counter into the title, so the two racing calls produce **distinct** candidates (`… #1` and `… #2`). Assertions added/strengthened:
- `expect(nameCalls).toBe(2)` — proves the race window was actually hit (both calls read the row as unnamed and both burned a Claude call), a precondition for the divergent-title setup to mean anything.
- `expect(r1.body.title).toBe(r2.body.title)` — with the guard, the loser's UPDATE affects 0 rows (EvalPlanQual re-checks `title IS NULL` against the committed row), so it falls through to the re-read branch and returns the WINNER's title; both responses converge. **Without** the guard, both UPDATEs match unconditionally and each returns its OWN `#1`/`#2` candidate via `RETURNING title`, so r1 and r2 diverge → this assertion FAILS.
- `expect(r1.body.title).toMatch(/#[12]$/)` and `expect(row.rows[0]!.title).toBe(r1.body.title)` — pin that the persisted row is exactly the converged-on candidate, not a clobbered hybrid or the loser's value.

The test now fails if the `AND title IS NULL` guard is removed.

### Consequent test adjustments from the enrich/gradeWriting migration — FIXED

Migrating `gradeWriting.ts` / `enrich.ts` onto the shared mapper changed two tests that had encoded the OLD leaky pass-through behavior:

- `tests/routes/gradeWriting.test.ts` "B4 httpStatus error" asserted a raw upstream **504** passed straight through. The shared `mapClaudeError` deliberately flattens every 5xx-class proxy failure to a blanket **502** with a fixed generic message (SECURITY.md §13.7 — never forward the upstream status/message). Updated the assertion to `502` and ADDED positive leak-closure assertions (`error.message` must NOT contain `b4_timeout` / `upstream timeout`). This test previously proved the leak existed; it now proves it's closed.
- `tests/routes/enrich.test.ts` "B4 throws with httpStatus" (a 429) still passes its 4xx STATUS through (correct — a rate-limit is caller-triggered, not an outage), but its assertions only checked status + code (which held under the old leaky code too). Added leak-closure assertions that the wire `error.message` is the whitelisted generic string, not the raw `${code}: ${message}` (`b4_rate_limited` / `too many tokens`). This makes the enrich migration load-bearing for F-124.

Both are legitimate consequences of the intended consolidation (the reviewers praised the 5xx→502 flatten and the 4xx passthrough as the correct semantics), not regressions.

## R1 NITs

- NIT 1 (`.cause` unwrapping is one level deep / doc slightly overstates it) — DEFERRED. Not in the assigned scope (BLOCKERs + SHOULD-FIX), and the fix the reviewer describes is a comment tightening on `retry.ts` unrelated to the leak paths this pass targets. The reviewer themselves rated it "not worth blocking on."
- NIT 2 (bare `timeout` in `CONN_ERROR_MESSAGE_RE` is broad) — DEFERRED. Pre-existing, no current caller trips it (reviewer-confirmed), out of scope.
- NIT 3 (retry test naming) — no action needed; it was praise.

## Grep-proof: ZERO remaining raw-error-forwarding paths on a Claude/upstream path

From `server/`:

```
$ grep -rn 'new UpstreamError(`${' src/
(no matches)

$ grep -rln "'httpStatus' in err" src/ | grep -v 'middleware/errors.ts'
(no matches — the only occurrence is inside mapClaudeError itself in middleware/errors.ts)

$ grep -rn 'mapClaudeError' src/routes/*.ts src/services/imageIngest.ts
  every Claude-touching route (writing / reading / grammarDrill / diagnostic /
  conversation / enrich / gradeWriting / imageIngest) forwards via mapClaudeError
```

There is no remaining `${code}: ${message}` interpolation, and no raw upstream-error `httpStatus`-destructuring block, anywhere outside the single shared `mapClaudeError` in `middleware/errors.ts`. `mapClaudeError` itself never puts raw `code`/`message` on the wire — it logs them server-side (`getLogger().warn`) and returns a whitelisted client message.

(The remaining `err.message` hits under `src/routes`/`src/services` are all server-side-only log payloads or SSE frames gated on `err instanceof AppError` — `conversation.ts` streaming/persistence catches, `health.ts` dbError, `kiwi.ts` serialize, and diagnostic.ts's new server-side `.error` log — none forward raw upstream text to a client response body.)

## Gate (targeted; the full ~17min testcontainer suite runs at re-review / pre-deploy)

From `server/`:

- `npm run typecheck` (`tsc --noEmit`): **0 errors.**
- `npm run lint`: **0 errors, 73 warnings** — all pre-existing `@typescript-eslint/no-non-null-assertion`; none introduced by this diff (touched files enrich.ts / gradeWriting.ts / errors.ts have 0 warnings; diagnostic.ts's warnings are all pre-existing lines unrelated to the catch edit).
- `npx vitest run` on the affected + adjacent files — **12 test files passed, 405 tests passed, 0 failed** (~390s against real Postgres testcontainers):

  | File | Passed |
  |------|--------|
  | tests/routes/diagnostic.test.ts | 46 |
  | tests/routes/enrich.test.ts | 10 |
  | tests/routes/gradeWriting.test.ts | 20 |
  | tests/routes/generation.test.ts | 30 |
  | tests/routes/writing.test.ts | 39 |
  | tests/routes/reading.test.ts | 63 |
  | tests/routes/grammarDrill.test.ts | 27 |
  | tests/routes/images.test.ts | 22 |
  | tests/routes/conversation.test.ts | 75 |
  | tests/routes/tickets.test.ts | 35 |
  | tests/middleware/errors.test.ts | 8 |
  | tests/services/claude/retry.test.ts | 30 |
  | **Total** | **405** |

  Iteration note: the FIRST full run of this set caught a real consequence of the migration — `gradeWriting.test.ts`'s "B4 httpStatus error" asserted the OLD 504 pass-through (that run: 1 failed / 404 passed). That test encoded the pre-consolidation leaky behavior; it was corrected to the shared mapper's 502-flatten (see "Consequent test adjustments" above) and the re-run is fully green at 405/405. The full ~17min testcontainer suite runs at the independent re-review + pre-deploy gate.

## Self-assessment

- Both BLOCKERs are code-level fixes verified by typecheck + the affected-route test suites; the diagnostic fix deliberately reuses the already-praised shared mapper rather than inventing a parallel path.
- One intentional behavior change is worth flagging for the re-reviewer: diagnostic.ts's catch now lets a `ClaudeProxyError` 4xx pass through as 4xx (via the shared mapper) instead of the old blanket 502. This matches the F-094 consolidation the reviewers explicitly praised as the correct call (an injection rejection / proxy limiter should read as 400/429 everywhere). Raw non-proxy errors still map to 502, so the "claude is down → 502" decoupling test is unaffected.
- The F-125 test is now load-bearing: I reasoned through the guard-removal case (both UPDATEs match, distinct `RETURNING` titles, `r1.title !== r2.title`) rather than mutating the shared checkout to prove it, per the no-`git`-mutation constraint on this shared tree.
