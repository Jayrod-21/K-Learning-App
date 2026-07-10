# FIX_REPORT — Server dependency bump fix-pass

**Worktree:** `/home/jared-williams/projects/9b. Korean Master/.claude/worktrees/agent-a866a005817c1f492`
**Branch:** `worktree-agent-a866a005817c1f492` (off `rebuild`), uncommitted. Nothing committed/pushed/deployed by this pass.
**Inputs:** `REVIEW_deps_runtime.md` (PASS WITH CONDITIONS), `REVIEW_deps_tests.md` (PASS). 0 BLOCKERS aggregate.
**Fixer:** independent fix-pass agent (did not author or review the original change).

---

## Dispositions

| Finding | Source review | Disposition | Change |
|---|---|---|---|
| **SF-1** — floating EOL `node:20-alpine` base, no guard for uuid@14's Node ≥20.19 floor | runtime | **FIXED** | `server/Dockerfile:21` and `server/Dockerfile:34`: both stages moved `node:20-alpine` → `node:22-alpine` (current LTS). Rationale comment added above the build FROM (`server/Dockerfile:16-20`) covering Node 20 EOL 2026-04-30, uuid@14's undeclared ≥20.19 `require(esm)` floor, and why the major is pinned (base drift can't silently move the runtime below the floor); one-line pointer comment above the runtime FROM (`server/Dockerfile:33`). No other Dockerfile lines touched. |
| **SF-2** — dead `err.name === 'APIConnectionError'` check in `isRetryable()`; plain connection errors not retried by `withRetry` | runtime | **DEFERRED** (ticket **B-032**) | None. `server/src/services/claude/retry.ts:151` left as-is. |
| **N1 / NIT** — stale "single-fork / shares one Node process" header comment in global test setup | tests | **FIXED** | `server/tests/setup.ts:4-11`: comment now states files run sequentially in per-file isolated forks (`fileParallelism: false`, `isolate: true`) and that tests in the **same file** share a process, which is why the per-test `resetLimiters()` remains necessary. Comment-only; the executable code (`beforeEach(resetLimiters)`) is untouched. `vitest.config.ts`'s comment was already accurate per both reviews — not touched. |

### SF-2 deferral rationale

- **Pre-existing, not introduced by this diff.** The runtime review verified the behavior is byte-identical on SDK 0.80 and 0.110 (`new APIConnectionError({})` → `.name === 'Error'` on both). The dep bump changes nothing here.
- **Already tracked** as ticket B-032; the runtime review itself says "follow-up, not necessarily this PR" and offers moving it to backlog as "a defensible position for a dep bump."
- **Fixing it here would be scope creep** in a dependency-vuln deliverable: it needs a design choice (export a type-guard through the `SdkLike` seam per ADR-020's SDK-import-free rule vs. `constructor.name` check vs. message-regex addition) plus a regression test constructing a real `APIConnectionError`. That belongs in its own reviewed change.
- **Mitigated meanwhile:** timeouts (`"Request timed out."`) do match `/timeout/i` and retry correctly, and the SDK internally retries connection errors twice (`maxRetries` default 2) before surfacing.

### N-1 / N-2 (runtime-review NITs, for completeness)

- **N-1** (`engines: { node: ">=20.19" }` in `server/package.json`): not applied. The reviews required only SF-1 + the setup.ts NIT; SF-1's pinned `node:22-alpine` base now enforces the floor for the artifact that ships. Adding `engines` is reasonable follow-up hardening but is additional surface (CI/dev `engine-strict` interactions) beyond the assigned scope. Flagged for the backlog alongside B-032.
- **N-2** (SDK-internal retries stack under `withRetry`): pre-existing, unchanged by the bump, explicitly "consider" wording in the review — backlog with B-032, not this PR.

---

## Validation

### SF-1 (Dockerfile) — deploy-time-validated change

No unit test applies to a base-image pin; the authoritative validation is the `docker build` + health-check on the IDLE blue/green color at deploy time (per the blue/green protocol — never rebuild the active color in place). What was verified here:

- `docker build --check .` in `server/` → **"Check complete, no warnings found"**; BuildKit resolved `docker.io/library/node:22-alpine` metadata successfully. Dockerfile is well-formed.
- `git diff` confirms the Dockerfile change is exactly the two FROM lines + comments — no layer, COPY, RUN, or CMD changes.
- Compatibility basis (from the runtime review's evidence, not re-derived): uuid@14 needs `require(esm)` ≥20.19 or ≥22.12; current `node:22-alpine` is well past 22.12. `apk add poppler-utils` and the multi-stage layout are unchanged and Node-version-independent.

### Gates (run in `server/` after edits)

| Gate | Command | Result |
|---|---|---|
| Audit | `npm audit --audit-level=high` | **found 0 vulnerabilities**, exit 0 |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| Lint | `npm run lint` | exit 0 — **0 errors**, 52 warnings, all pre-existing `@typescript-eslint/no-non-null-assertion` in `src/` files untouched by this diff and by this fix-pass |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | exit 0 |

### Vitest suite — deliberately NOT re-run

The full suite (~12 min, testcontainers) was already green post-bump per the test review's independent run: **52 files passed / 1 skipped, 980 tests passed / 4 skipped, exit 0**. This fix-pass changed (a) a Dockerfile, which has no test surface, and (b) comment-only lines in `tests/setup.ts` — the diff touches nothing executable (verified via `git diff`; the `beforeEach(resetLimiters)` body is byte-identical). A comment cannot change runtime behavior, and typecheck/lint/build confirm the file still parses clean. Re-running the suite would add no information; judged not warranted.

---

## Self-assessment vs the quality bar

- **Minimal + faithful:** 2 files changed by this pass; the Dockerfile diff is 2 FROM lines + comments, setup.ts diff is comment-only. Nothing the reviews PRAISED was touched (SdkLike seam, lockfile, vitest.config.ts comment, real_smoke.test.ts refactor all untouched).
- **Config pins explicit:** floating EOL base replaced with pinned-major current LTS on **both** stages (build/runtime parity preserved), with the rationale in-file so the next editor knows why the pin exists.
- **No scope creep:** SF-2/N-1/N-2 deferred with written rationale rather than silently dropped or opportunistically fixed. Adjacent `node:20` references deliberately left alone (see below).
- **Reversible:** uncommitted working-tree edits in an isolated worktree; revert = `git checkout -- server/Dockerfile server/tests/setup.ts`.
- **No swallowed errors / type safety:** no runtime code changed; all gates exit 0.

## Out-of-scope observations for the re-reviewer (untouched on purpose)

1. `client/Dockerfile:1` and `client/Dockerfile.prod:23` still use `node:20-alpine`. SF-1 was scoped to `server/Dockerfile` (the image that runs uuid@14); the client is a separate deliverable and neither review covers it. Same EOL argument will eventually apply — backlog candidate.
2. `.github/workflows/ci.yml:22,50,158` pin `node-version: 20`; setup-node resolves latest 20.x (≥20.19), so CI still runs uuid@14 correctly today, but CI now tests on a different Node major than the runtime image. Backlog candidate alongside item 1.
3. `Deploy/docker-compose.{blue,green}.yml:149` comments mention "node:20-alpine runtime" as healthcheck rationale — the rationale (node binary exists, no wget/curl assumption) holds identically on `node:22-alpine`; the version string in the comment goes slightly stale once this lands. Cosmetic; those files live outside this worktree's diff scope and per project memory any compose/base change must ride the IDLE-color deploy flow.
