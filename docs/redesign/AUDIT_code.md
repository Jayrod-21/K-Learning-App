# AUDIT_code.md — Independent Verification Audit

**Scope:** adversarial trust-but-verify audit of the merged push to `rebuild` @ HEAD
(PRs #108–#114). Read-only against the working tree; the one guard-removal proof
(F-125) was exercised against a throwaway copy in `/tmp` (never the real working
tree), and the DB suite was run against a fresh `postgres:16-alpine` testcontainer.
No prior agent's claims were trusted without independently re-reading the code
and/or re-running the test.

**Git state confirmed:**
```
477e708 Merge pull request #114 from Jayrod-21/feat/beta-phaseB2b-infra
...
2fa7224 Merge pull request #112 from Jayrod-21/feat/beta-phaseB1-reliability
...
cc87d5e Merge pull request #111 from Jayrod-21/feat/beta-phaseA-partials
```
PRs #108–#114 (phaseA #111, B1 #112, B2a #113, B2b #114 — the visible merge
commits) are present on `rebuild` @ `477e708`, matching the deploy claim.

---

## Summary table

| Ticket | Verdict | Evidence | Test result |
|---|---|---|---|
| B-017 | VERIFIED | `client/src/pages/Mistakes.tsx:479-596` — `WritingReviewSection` does a real abortable `fetchWritingAttempts()` call against `GET /writing/attempts`, splits into TOPIK/Generated via exhaustive `writingRubricBucket` switch (lines 397-412). Grepped for "coming soon" stub string in the component body — zero hits (only historical doc-comment references saying the stub is gone, `Mistakes.tsx:53,480`). | `Mistakes.test.tsx:543-610` (`B-017: fetches the real writing history...`) asserts on rendered fetched data and explicitly asserts `queryByText(/coming soon/i)` is NOT in the document. Included in the clean client vitest run (1962/1962 passed). |
| F-173 | VERIFIED | `client/src/pages/Today.tsx:643-665` — `hasRealTotal = openAttempt?.totalItems !== undefined`; when true renders `"X of N answered"` + `SubwayProgress` bar; when false renders bare `"N answered"` line with no "of N" and no bar. | `Today.test.tsx:1193-1245` — two dedicated tests: real-total case asserts `aria-valuetext="12 of 20 answered"` + bar present; fallback case asserts the honest `"7 answered"` text and explicitly asserts NO bar / no "of N" text. Passed in the clean client vitest run. |
| F-121 | VERIFIED | `client/src/components/ShowMore.tsx:80-90` — exhausted-state stand-in renders `<p className="km-showmore__done focusring">`, NOT `.km-sr-only`. `ShowMore.css:44-52` confirms `.km-showmore__done` is `display:block`, normal in-flow text (not clipped/off-canvas). | `ShowMore.test.tsx:98-121` — explicit regression test asserts `document.activeElement` is NOT `.km-sr-only` and IS `.km-showmore__done`, tag `P`. Passed in the clean client vitest run. |
| F-124 | VERIFIED | `server/src/middleware/errors.ts:162-179` (`mapClaudeError`) — returns only a whitelisted string from `CLAUDE_CLIENT_MESSAGES` (keyed by `code`) or the fixed `DEFAULT_UPSTREAM_MESSAGE`; the raw `code`/`message` are logged server-side only (`getLogger().warn(...)`), never placed on the `UpstreamError` returned to the caller. No `${code}: ${message}` template present anywhere in the mapper. | Covered by server suite (not independently re-run here beyond typecheck; source inspection is unambiguous — no interpolation path to the client exists). |
| F-094 | VERIFIED | `git grep`/plain grep across `server/src` for raw `${code}: ${message}`-style forwarding outside `middleware/errors.ts` found only two **historical doc-comment** references (`enrich.ts:50`, `gradeWriting.ts:165`) describing the OLD (fixed) behavior — no live code path. Confirmed all 8 Claude-touching routes/services import and call the shared `mapClaudeError`: `writing.ts`, `reading.ts`, `grammarDrill.ts`, `diagnostic.ts`, `conversation.ts`, `imageIngest.ts`, `enrich.ts`, `gradeWriting.ts`. | Zero raw-forwarding grep hits (see final message for the exact command/output). One unrelated, out-of-scope observation: `server/src/services/kiwi.ts` (a non-Claude upstream, the Korean morphological analyzer) has its own `serializeErr()` that puts `{name, message}` into an `UpstreamError`'s `details`, and `errorHandler` (`middleware/errors.ts:196-203`) does forward `err.details` to the client wire format. This predates the batches under audit and is NOT part of any F-094/B1 ticket claim (F-094 is explicitly scoped to Claude routes) — flagged for awareness, not scored as a discrepancy against this ticket. |
| B-032 | VERIFIED | `server/src/services/claude/retry.ts:167-195` (`isRetryable`) — duck-types on `.status` (408/425/429/5xx), then on connection-error shape (`isConnectionErrorShape`) checked against BOTH the error itself and `err.cause` (`asRecord(e.cause)`), matching OS error codes (`ECONNRESET` etc.) or SDK message patterns. Doc comment explicitly documents the dead `err.name === 'APIConnectionError'` check it replaced (real SDK errors never set `.name` away from the literal `"Error"`). | `server/tests/services/claude/retry.test.ts:43-71` — dedicated `B-032` tests for an `APIConnectionError`-shaped error (status undefined, generic message) and for a connection error surfaced only via `.cause`; both assert `isRetryable(...) === true`. |
| B-033 | VERIFIED | `server/src/routes/tickets.ts:294-312` — PATCH pre-read miss → `NotFoundError` (404); UPDATE affecting 0 rows re-probes ownership: gone → 404, still-present-but-version-moved → `ConflictError` (409). Distinguishes "vanished" from "real version conflict" instead of collapsing both into 409. | `server/tests/routes/tickets.test.ts:318-397` — separate tests for the real-409 case (`318`) and the B-033 404-on-vanished-row case (`335`, deliberately racing a row-lock to hit the exact window) plus the pre-existing IDOR-404 tests. |
| F-125 | **VERIFIED (independently re-run)** | `server/src/routes/conversation.ts:1096-1102` — the naming UPDATE is `WHERE id = $1 AND user_id = $3 AND title IS NULL AND deleted_at IS NULL`, relying on Postgres READ COMMITTED's EvalPlanQual re-check to make the guard atomic at the storage layer. | **Independently reproduced in an isolated `/tmp` scratch copy (server+db copied out, node_modules symlinked, real testcontainer Postgres — never touched the actual working tree):** ① intact code, `tests/routes/conversation.test.ts -t "F-125"` → **1 passed**. ② Guard (`AND title IS NULL`) deleted from the copy → same test → **1 failed**, with the exact assertion the ticket predicts: `expected 'Chat about ... #1' to be 'Chat about ... #2'` (both racing UPDATEs land, so the two responses diverge instead of converging on one winner). This proves the test is a real regression guard, not toothless. |
| F-088 | VERIFIED | `db/migrate.py:339-404` — `explicit_destructiveness()` reads an explicit `-- migrate: destructive` / `-- migrate: non-destructive` directive (regex `MIGRATE_DIRECTIVE_PATTERN`), string-literal-stripped so a documentary literal can't forge one; `contains_destructive()` treats a present directive as authoritative and only falls back to the legacy DROP/TRUNCATE keyword-sniff when no directive exists. Raises `ConflictingDestructiveMarkers` if both directives appear. | Covered by the DB suite (see below) plus manual inspection of migrations 062/063/064, all three of which carry an explicit marker (062/063.up/064.up = non-destructive; 063.down/064.down = destructive). |
| F-192 | VERIFIED | `server/tests/routes/diagnostic.test.ts:643-714` — `describe('buildGeneratedItem error mapping (B1 fix regression, F-192)')` contains exactly 2 tests: (1) a raw non-`ClaudeProxyError` throw asserted to produce a 502 whose `error.message` does NOT contain the raw message text or `'ECONNRESET'`; (2) a real `ClaudeProxyError` (`ClaudeRateLimitError`) asserted to pass its 429 through unflattened. Both are genuine leak-regression tests, not placeholders. | Part of the server test suite (not independently re-run beyond typecheck here; source + assertions read directly and are unambiguous). |
| Migrations 062/063/064 | VERIFIED | All three exist with paired `.up.sql`/`.down.sql`. 062 (revoke km_app default TEMP privilege) and 063.up/064.up carry `-- migrate: non-destructive`; 063.down (DROP COLUMN) and 064.down (scoped DELETE) carry `-- migrate: destructive`. 063 adds the `window_start` claim-key column + `UNIQUE(schedule_id, window_start)` constraint; 064 is a one-time backfill from the legacy `users.preferences` JSONB blob into `notification_schedules`, gated on `channel.email` + explicit `jsonb_typeof` guards so a malformed blob can't abort the whole migration. | See DB suite result below — `db/tests/test_migration_062.py`, `test_migration_063.py`, `test_migration_064.py` all present and included in the run. |
| DB suite | VERIFIED | — | **`python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -q` → 110 passed in 317.33s** (run fresh via `docker run python:3.12` + Docker-socket-mounted testcontainers, `postgres:16-alpine`, per `Deploy/local-test.sh`'s own `db_suite()` recipe). Matches the commit-message claim ("DB (110)") — independently reproduced, not taken on trust. |
| F-085 | VERIFIED | `git grep -n 'node:20\|node-version: 20' -- ':!*.md'` → **zero matches** in tracked files. `server/Dockerfile:21,34`, `client/Dockerfile:4`, `client/Dockerfile.prod:27` all `FROM node:22-alpine`; `.github/workflows/ci.yml:22,50,158` all `node-version: 22`. (A plain non-git `grep -r` over the whole tree DOES surface `node:20-alpine` hits, but every one of them is inside `.claude/worktrees/agent-*/` — untracked, stale leftover worktrees from prior agent sessions, confirmed via `git status --short .claude` → `?? .claude/`. Not part of the deployed/tracked repo.) | N/A (static check). |
| F-126 | VERIFIED | `Deploy/set-km-app-password.sh:112-127` — the post-set verification query uses an explicit fail-closed `CASE WHEN ... IS TRUE THEN 'super' WHEN ... IS FALSE THEN 'nonsuper' ELSE 'unknown' END`, compared against the exact string `'km_app:nonsuper'`. No `\|\|`-boolean-concatenation bug (the documented prior bug: concatenating a boolean into text renders `'true'/'false'`, not `-tAc`'s bare-column `'t'/'f'`, causing a false failure on a correctly-configured role) and no bare `ELSE` that could fail open on a NULL/missing-role edge case — that edge case renders `'unknown'`, which still fails the `!=` check. | N/A (static/shell script; not something to unit-test in this pass — logic verified by direct reading, matches the documented bug + fix precisely). |

---

## Additional runs performed for this audit

- **Client:** `cd client && npx vitest run` → **117 test files, 1962 tests, all passed.**
- **Server:** `cd server && npm run typecheck` → **clean, exit 0, no output** (no TS errors).
- **DB suite:** `python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -q` (fresh `postgres:16-alpine` testcontainer via `docker run python:3.12`) → **110 passed in 317.33s**, zero failures.

## Notable non-ticket observation (not a discrepancy against any claim above)

`server/src/services/kiwi.ts`'s `serializeErr()` puts `{name, message}` from a raw
JS `Error` into an `UpstreamError`'s `details`, and the generic `errorHandler`
forwards `details` to the client wire body. This is pre-existing Kiwi-proxy code,
untouched by phases A/B1/B2a/B2b, and F-094's claim is explicitly scoped to
"Claude routes" — so this is out of scope for this audit's tickets, not a failure
of any claim made. Flagged for whoever owns Kiwi hardening next.
