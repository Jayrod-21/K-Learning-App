# Re-Review — Fix-pass verification, server dependency bump

**Re-reviewer:** Independent (did not author the bump, the original reviews, or the fix-pass).
**Worktree:** `/home/jared-williams/projects/9b. Korean Master/.claude/worktrees/agent-a866a005817c1f492` (branch `worktree-agent-a866a005817c1f492` off `rebuild`, uncommitted).
**Inputs verified against actual code, not trusted from reports:** `REVIEW_deps_runtime.md`, `REVIEW_deps_tests.md`, `FIX_REPORT.md`.
**Date:** 2026-07-09

---

## Summary verdict: **PASS**

Every fix-pass claim survived adversarial verification against the working tree. SF-1 is genuinely fixed (both Dockerfile stages on `node:22-alpine`, change limited to the two FROM lines plus rationale comments, `docker build --check` clean). The tests NIT is genuinely fixed (comment-only edit to `tests/setup.ts`; executable code byte-identical). SF-2's deferral is sound: the code is provably pre-existing (`git diff rebuild -- server/src/` is empty — the bump and fix-pass touched zero source files) and B-032 is a real, correctly-worded ticket in `BUGS_AND_FEATURES.md:1100`. All four gates re-run green in the worktree. No regressions, no scope creep, nothing the original reviews praised was disturbed.

**New blockers: 0.**

---

## Finding-by-finding table

| Finding | Source | Orig severity | Fix status | Notes |
|---|---|---|---|---|
| SF-1 — floating EOL `node:20-alpine` base; no guard for uuid@14's Node ≥20.19 floor | runtime review | SHOULD-FIX | **FIXED** | Verified via `git diff rebuild -- server/Dockerfile`: exactly two FROM lines changed (`server/Dockerfile:21`, `:34`), both now `node:22-alpine`, plus a 5-line rationale comment above the build FROM and a 1-line pointer above the runtime FROM. No layer/COPY/RUN/CMD/EXPOSE changes. `docker build --check .` → "Check complete, no warnings found"; BuildKit resolved `docker.io/library/node:22-alpine` metadata from the registry. Node 22 is the right call: supported through 2027-04-30, `require(esm)` unflagged since 22.12 (current 22.x is far past that), matches the original reviewer's explicit recommendation, and pinning the major closes the base-drift hole that made uuid@14's undeclared floor dangerous. Two minor observations, neither blocking: (a) the comment calls 22 "current LTS" — as of mid-2026 Node 22 is in *maintenance* LTS (24 is the active LTS); still fully supported, phrasing is merely loose. (b) `node:22-alpine` is not in M's local Docker image cache (only `node:20-alpine`/`node:20-slim` are), so the first real deploy build will pull it fresh — normal, but the blue/green IDLE-color flow is where the authoritative build+health-check happens, exactly as FIX_REPORT states. |
| SF-2 — dead `err.name === 'APIConnectionError'` check in `isRetryable()`; plain connection errors never retried by `withRetry` | runtime review | SHOULD-FIX (pre-existing) | **DEFERRED-WITH-DOC** | Deferral verified sound, not a dodge. (1) Genuinely pre-existing: `git diff rebuild -- server/src/` is empty — neither the bump nor the fix-pass touched any source file; `retry.ts:151` is unchanged from `rebuild`, and the original review empirically showed identical `.name === 'Error'` behavior on SDK 0.80 and 0.110, so the bump changes nothing here. (2) Genuinely out of scope for a dep-vuln deliverable: the fix requires a design choice (type-guard through the `SdkLike` seam per ADR-020's SDK-import-free rule vs `constructor.name` vs message-regex) plus a new regression test — its own reviewed change. (3) B-032 is a **real filed ticket**: `BUGS_AND_FEATURES.md:1100` ("`withRetry` never retries plain connection errors (dead error-name check)", P3/BACKEND, correct root-cause description and fix hint, explicitly notes it's pre-existing and surfaced by this fixpass). The original review itself blessed exactly this disposition ("follow-up, not necessarily this PR"; "a defensible position for a dep bump" — with the condition that it "not silently disappear", which the ticket satisfies). |
| N1 — stale "single-fork / shares one Node process" header comment | tests review | NIT | **FIXED** | Verified via `git diff rebuild -- server/tests/setup.ts` and full file read: the hunk touches only the JSDoc header. The new text is accurate — files run sequentially in per-file isolated forks (`fileParallelism: false`, `isolate: true` — matches `vitest.config.ts` and the tests reviewer's verified vitest-4 semantics), tests in the *same* file share a process, which is precisely why the per-test `resetLimiters()` safety net remains necessary. `import` lines and the `beforeEach(resetLimiters)` body are byte-identical to `rebuild`. |
| N-1 — add `"engines": { "node": ">=20.19" }` to `server/package.json` | runtime review | NIT | **DEFERRED-WITH-DOC** | Verified not applied: `git diff rebuild -- server/package.json` shows only the three version bumps + `@types/uuid` removal — no `engines` field, no other edits. Acceptable: the pinned `node:22-alpine` base now enforces the floor for the artifact that ships; `engines` would protect only dev machines/CI (M runs 20.20.2 ≥ 20.19, CI resolves latest 20.x — both above the floor today). Reasonable follow-up hardening; see Recommendation on filing it. |
| N-2 — SDK-internal retries (`maxRetries` default 2) stack under `withRetry` | runtime review | NIT (pre-existing) | **DEFERRED-WITH-DOC** | Verified unchanged (no source edits at all). Pre-existing on 0.80, "consider" wording in the original review. Legitimate backlog. Note: FIX_REPORT says "backlog with B-032," but B-032's ticket text covers only the dead name check, not this — see Recommendation. |
| P-1 — `SdkLike` seam absorbed the SDK bump with zero source changes | runtime review | PRAISE | **INTACT** | `server/src/` diff vs `rebuild` is empty; seam untouched. |
| P-2 — clean, minimal, honest lockfile | runtime review | PRAISE | **INTACT** | Fix-pass touched neither `package.json` nor `package-lock.json`. |
| P1 (tests) — load-bearing, accurate `vitest.config.ts` comment | tests review | PRAISE | **INTACT** | `vitest.config.ts` untouched by the fix-pass (its diff vs `rebuild` is the original `singleFork` → `fileParallelism` migration both reviews already ratified). |
| P2 (tests) — `real_smoke.test.ts` `beforeAll` refactor | tests review | PRAISE | **INTACT** | File untouched by the fix-pass. |

---

## New findings introduced by the fix-pass

- **BLOCKER:** none.
- **SHOULD-FIX:** none.
- **NIT — "current LTS" phrasing in the new Dockerfile comment** (`server/Dockerfile:16`). Node 22 is maintenance LTS (Node 24 is the active LTS as of Oct 2025); "current LTS" is loose but not wrong enough to matter — 22 is supported through April 2027 and is the conservative, reviewer-recommended choice. Fix opportunistically if the file is ever touched again; do not respin for this.
- **PRAISE — surgical discipline.** The fix-pass diff is exactly 2 files: two FROM lines + comments in the Dockerfile, and a comment-only edit in `tests/setup.ts`. It resisted the temptation to opportunistically fix SF-2, add `engines`, or "helpfully" bump the client/CI — and documented every deferral in writing instead of letting items evaporate. FIX_REPORT's claims matched the tree 1:1; nothing in it was found to be overstated.

---

## Gates re-run (this re-review's own runs, in the worktree `server/`)

| Gate | Command | Result |
|---|---|---|
| Audit | `npm audit --audit-level=high` | **found 0 vulnerabilities**, exit 0 |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0, no output |
| Lint | `npm run lint` | exit 0 — **0 errors**, 52 warnings, all pre-existing `@typescript-eslint/no-non-null-assertion` in `src/` files untouched by this diff |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | exit 0 |
| Dockerfile | `docker build --check .` | "Check complete, no warnings found"; `node:22-alpine` metadata resolved |

**Vitest rerun: I agree it is unnecessary.** The tests reviewer independently reproduced the full suite green post-bump (52 files passed / 1 skipped, 980 tests passed / 4 skipped, exit 0), and I verified the fix-pass diff on top of that state touches nothing with a test surface: a Dockerfile (not exercised by vitest) and a comment-only hunk in `tests/setup.ts` whose executable lines are byte-identical to what ran green. Typecheck/lint/build re-confirm the edited file parses clean. A ~12-minute testcontainers rerun would add no information.

## Regression / scope-creep sweep

- `git status --porcelain`: exactly the 6 expected modified files (4 from the original bump + `server/Dockerfile` + `server/tests/setup.ts` from the fix-pass) plus the 3 untracked review/fix `.md` artifacts. Nothing else.
- `git diff rebuild -- server/src/` is **empty** — zero source-code changes across bump + fix-pass combined.
- `server/package.json` / lockfile / `vitest.config.ts` / `real_smoke.test.ts` diffs are unchanged from what the original reviews examined and ratified.
- Nothing committed, pushed, or deployed.

## Adjacent items the fix-pass flagged — independent judgment

| Item | Blocker for this deliverable? | Judgment |
|---|---|---|
| `client/Dockerfile:1` + `client/Dockerfile.prod:23` still `node:20-alpine` | **No** | Verified the client has **no uuid dependency** (grep of `client/package.json`), so uuid@14's Node floor doesn't apply. In `Dockerfile.prod`, Node appears only in the *build* stage — the runtime is `nginx:1.27-alpine` — so EOL-Node exposure is build-tooling-only, not a shipped runtime. Server/client Node parity is not required (separate images, separate dependency trees). Legitimate backlog. |
| `.github/workflows/ci.yml:22,50,158` `node-version: 20` | **No, but closest to the line** | setup-node resolves latest 20.x (≥20.19), so CI runs uuid@14 correctly today. The real cost is that CI now tests on a different Node major (20) than the runtime image (22) — CI never exercises the actual production Node. For this Express/TS app the 20→22 behavioral delta is small and the full suite already passed on 20.20.2, so not a blocker; but this is a 3-line change that should land as a prompt follow-up, ideally before Node 20's toolchain drifts further. |
| `Deploy/docker-compose.{blue,green}.yml:149` healthcheck comments say "node:20-alpine runtime" | **No** | The rationale the comment supports (use the node binary, don't assume wget/curl) holds identically on `node:22-alpine`. Purely cosmetic staleness in files outside this diff; fix when those files are next touched via the IDLE-color deploy flow. |
| N-1 `engines` field | **No** | Covered above — the shipped artifact is now guarded by the base pin; `engines` adds dev/CI install-time loudness only. Backlog. |

None of these blocks the deliverable. One process gap worth closing: **of the five deferred/flagged items, only SF-2 has an actual filed ticket (B-032).** N-1, N-2, the client base image, the CI node-version, and the compose-comment staleness exist in writing only inside `FIX_REPORT.md` — an untracked worktree file that disappears when this worktree is cleaned up. They should be filed in `BUGS_AND_FEATURES.md` (a single "Node 22 alignment follow-ups" item would do, with N-2 appended to B-032's notes or its own line) before the worktree is torn down.

## Bar checklist post-fix

- [x] Audit: 0 vulnerabilities at every level (7 → 0, held after fix-pass)
- [x] Typecheck / lint / build: all exit 0, re-run by this re-review
- [x] Test suite: green post-bump (independently reproduced by tests reviewer); fix-pass diff has no test surface — rerun waived with justification
- [x] Dockerfile: well-formed (`docker build --check` clean), both stages on supported Node ≥ uuid@14 floor, build/runtime base parity kept
- [x] Diff minimality: fix-pass = 2 FROM lines + comments; no source, no lockfile, no test-logic changes
- [x] All original findings dispositioned: 2 FIXED, 3 DEFERRED with written rationale, 0 dropped silently
- [x] Deferrals traceable: SF-2 → B-032 filed; remainder documented in FIX_REPORT (filing recommended, see above)
- [x] Praised items intact: SdkLike seam, lockfile, vitest.config comment, real_smoke refactor — all untouched
- [x] Nothing committed/pushed/deployed; change reversible

## Recommendation

**Ready to ship.** No new blockers, no regressions, all gates green, and every fix claim verified true against the tree. Two non-blocking asks before/at merge time:

1. **File the unfiled follow-ups** in `BUGS_AND_FEATURES.md` (CI `node-version` 20→22 — the most substantive; client Dockerfiles' `node:20-alpine`; `engines` field; N-2 maxRetries stacking; compose-comment staleness) so they survive worktree cleanup. B-032 already covers SF-2.
2. At actual deploy, follow the blue/green protocol as FIX_REPORT already stipulates — build the IDLE color (which will pull `node:22-alpine` fresh; it is not yet in M's image cache) and health-check before flipping `km-lb`.

No further fix-pass round is needed.
