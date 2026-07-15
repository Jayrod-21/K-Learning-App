# Review: feat/beta-phaseB2b-infra (F-085 Node 22 sweep + F-126 password-verify fix)

Reviewer: independent senior DevOps/infra pass. Base: `rebuild` @ `be81d73`.
Scope: `git diff rebuild -- .` (13 files — Dockerfiles, CI, compose, package.json
engines, `set-km-app-password.sh`, docs).

## Summary verdict

**PASS WITH CONDITIONS**

Both tickets are substantively correct and independently verified:

- **F-126**: reproduced the bug live against a throwaway `postgres:16-alpine`.
  The OLD query (`... || (SELECT rolsuper ...)`) prints `km_app:false` for a
  correctly-configured non-superuser role — confirming the reported
  false-fail. The FIXED `CASE WHEN … THEN 'super' ELSE 'nonsuper' END` query
  correctly prints `km_app:nonsuper` for the non-super role and `km_app:super`
  for a superuser role, so the check now passes good config and still fails
  bad config. No false-PASS in the reachable code path (`current_user` is
  always the connecting role, always present in `pg_roles` — see NIT-1 for the
  one *unreachable* fail-open edge in the `CASE`'s `ELSE`).
- **F-085**: independently `docker build`ed `client/Dockerfile` with
  `--no-cache` against `node:22-alpine` — clean `npm ci`, 0 vulnerabilities,
  image built successfully. `server/Dockerfile` was already on
  `node:22-alpine` pre-branch (prior dep-vuln fix); `client/Dockerfile.prod`
  shares the identical `FROM node:22-alpine AS build` line as the verified
  dev Dockerfile. All 3 `setup-node` call sites in `.github/workflows/ci.yml`
  are on `node-version: 22`. `Deploy/local-test.sh`'s `NODE_IMAGE` variable is
  used consistently everywhere it builds JS-suite containers — no stray
  hardcoded `node:20`. The `engines: ">=20.19"` floor is confirmed correct:
  `uuid@14`'s installed `package.json` genuinely has **no** `engines` field
  (undeclared floor, as the PR's comments claim), and `>=20.19` is satisfied
  by the Docker/CI-pinned Node 22, so it cannot block CI or contradict the
  Dockerfiles.

**Conditions** (both SHOULD-FIX, not blockers — see Detailed findings):
1. Two **live, current** test-file doc comments
   (`server/tests/services/pdfPageRender.test.ts:6`,
   `server/tests/services/pdfPageRender.bounds.test.ts:11`) still describe
   the verify container as `node:20-slim`, even though the file whose
   comment they're paraphrasing
   (`server/src/services/pdfPageRender.ts`) and `Deploy/local-test.sh` itself
   were both correctly updated to `node:22-slim` in this same diff. This is
   exactly the kind of drift F-085 exists to kill — it happened to land in
   comments only (no functional CI impact), which is why this is SHOULD-FIX
   rather than a blocker, but it is a genuine, verified miss, not a nitpick.
2. `client/README.md` was not given the same "Requirements" / engines-floor
   rationale note that `server/README.md` got, despite `client/package.json`
   receiving the identical `engines: ">=20.19"` field. Minor doc-parity gap.

No blockers. The historical `db/docs/*.md` and `docs/redesign/BACKLOG_RECON_2.md`
hits from the repo-wide `node:20` grep are dated review/backlog records of
past states (correctly left untouched — rewriting history there would be
worse) and do not count against completeness.

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **SF-1**: Stale `node:20-slim` doc-comments in two live test files, left
  out of the sweep. `server/tests/services/pdfPageRender.test.ts:6`,
  `server/tests/services/pdfPageRender.bounds.test.ts:11`.
- **SF-2**: `client/README.md` missing the engines/Node-version rationale note
  that `server/README.md:6-16` got. Doc-parity gap only.

### NIT
- **N-1**: `Deploy/set-km-app-password.sh:102`'s `CASE WHEN (SELECT rolsuper
  …) THEN 'super' ELSE 'nonsuper' END` fail-opens to `'nonsuper'` if the inner
  scalar subquery ever returned NULL (e.g., zero matching rows) — confirmed
  live: substituting a nonexistent rolname into the same shape of query
  prints `postgres:nonsuper`, i.e., a false-PASS shape. In the ACTUAL script
  this is unreachable (`current_user` is by definition an existing role in
  `pg_roles`), so it's not exploitable today, but it's a fail-open pattern
  worth avoiding on principle (prefer `ELSE 'unknown'` + a stricter
  `= 'nonsuper'` positive-match check over `!= 'nonsuper'`, so an unexpected
  third state can't slip through as "verified fine").
- **N-2**: `shellcheck` on `Deploy/set-km-app-password.sh` and
  `Deploy/local-test.sh` returns only an informational SC1091 (can't follow a
  dynamically-sourced path) — pre-existing pattern, not introduced by this
  diff, not worth fixing.

### PRAISE
- **P-1**: The F-126 fix's in-line comment (`set-km-app-password.sh:79-95`) is
  an exceptional bug writeup — it explains the exact Postgres bool-to-text
  rendering distinction (bare column vs. concatenated/cast expression) that
  caused the bug, names the concrete incident it caused (Wave-1 deploy
  aborted 2026-07-11 on a correctly-configured role), and documents how it
  was verified. This is the standard of documentation that prevents the same
  class of bug from recurring.
- **P-2**: Every Dockerfile touched carries a comment explaining *why* Node 22
  specifically (Node 20 EOL date, uuid@14's undeclared floor) rather than a
  bare version bump — this is exactly the kind of rationale that keeps future
  driftback from happening.
- **P-3**: The secret-handling discipline in
  `set-km-app-password.sh` (password over stdin into a container-local env
  var, never argv/`ps`/logs; `\getenv` + `:'pw'` literal quoting for the SQL
  path) is unaffected by the F-126 change and remains correct — confirmed no
  new injection surface was introduced by the CASE-expression rewrite (no
  variable interpolation into the query at all; the only moving parts are
  static SQL literals).

## Detailed findings

**F-085 — Node sweep completeness**
- `.github/workflows/ci.yml:22,50,158` — all 3 `node-version` call sites at
  22. Confirmed via `grep -n "node-version"` post-diff: no remaining `20`.
- `client/Dockerfile:4` (`FROM node:22-alpine`) — independently
  `docker build --no-cache`ed; succeeded (`npm ci`: 629 packages, 0
  vulnerabilities).
- `client/Dockerfile.prod:26` — same base image as the verified `client/Dockerfile`; not independently rebuilt but shares the identical, verified `FROM` line and stage semantics.
- `server/Dockerfile:20,33` — both build and runtime stages already on
  `node:22-alpine` before this branch (prior dep-vuln-bump commit); this diff
  only touches the *test* file comment referencing it (see SF-1), not the
  Dockerfile itself, so no regression risk there.
- `services/kiwi/Dockerfile` — Python-based (`python:3.12-slim-bookworm`), out
  of scope for a Node sweep; correctly untouched.
- `Deploy/migrate.Dockerfile`, `Deploy/loader.Dockerfile` — both
  `python:3.12`-based, correctly out of scope.
- `Deploy/docker-compose.blue.yml:156`, `Deploy/docker-compose.green.yml:156`
  — healthcheck comment updated to `node:22-alpine`; verified no other
  `node:2*` references remain in either compose file.
- `Deploy/local-test.sh:12,46` — `NODE_IMAGE` updated to `node:22-slim`,
  and every downstream `docker run … "$NODE_IMAGE"` call site (lines 94, 123,
  182) references the variable, not a hardcoded tag, so there's nothing left
  to drift.
- `TESTS.md:24-25`, `FOLLOW_UPS.md:53` — runner column / nit note both updated
  to `node:22-slim` consistently.
- No `.nvmrc` / `.node-version` / Volta / asdf pin exists anywhere in the repo
  (only false positives under `node_modules/*/.nvmrc` from third-party
  packages, irrelevant) — nothing else needed bumping.
- **Miss (SF-1)**: `server/tests/services/pdfPageRender.test.ts:6` and
  `server/tests/services/pdfPageRender.bounds.test.ts:11` still say
  `node:20-slim` in their doc comments describing "the project's verify
  container" / "the verify container" — both are live, current-state
  comments (not historical review docs), and both are now factually wrong
  after `Deploy/local-test.sh` moved to `node:22-slim`. Not caught by the
  diff at all (confirmed via `git diff rebuild -- <both files>` = empty).
- `Deploy/azure-pipelines.yml` — no `node`-anything referenced (delegates
  entirely to the three Dockerfiles); correctly out of scope. Per project
  memory this pipeline also targets superseded infra (dad's server), not the
  current M-local deploy — not a blocker for this ticket either way.

**engines floor (`client/package.json:6-8`, `server/package.json:7-9`)**
- `">=20.19"` is satisfied by the CI/Docker-pinned Node 22 — `npm ci`/`npm
  install` will not hard-fail in either environment. Confirmed
  `node_modules/uuid/package.json` (server) has no `engines` field at all,
  matching the PR's claim that uuid@14's `>=20.19` floor (needed for
  `require(esm)`) is undeclared upstream — the added floor is a real,
  justified guard against a host running Node 20.0–20.18, not decorative.
- `server/README.md:5-16` documents the rationale well. `client/README.md`
  has no equivalent note (SF-2) — pure doc-parity gap, not a functional
  issue, since the client Dockerfile is what actually gates the runtime.

**F-126 — password-verify fix (`Deploy/set-km-app-password.sh:96-107`)**
- Live-tested against `postgres:16-alpine` (matches `km-db`'s image) with two
  freshly created roles, `LOGIN PASSWORD '…' NOSUPERUSER` and `LOGIN PASSWORD
  '…' SUPERUSER`:
  - OLD query shape → non-super role prints `<user>:false`
    (`!= '<user>:f'` incorrectly fails good config — bug reproduced).
  - FIXED query (`CASE WHEN rolsuper THEN 'super' ELSE 'nonsuper' END`) →
    non-super prints `<user>:nonsuper` (passes), superuser prints
    `<user>:super` (correctly fails the `!=` check). No false-PASS in the
    reachable path.
- `set -Eeuo pipefail` present (`:30`); `local verify;` and
  `verify="$(…)"` are two separate statements rather than a combined `local
  verify=$(…)`, which avoids the classic bash pitfall where `local`'s own
  exit status masks a failing command substitution — a failed psql auth
  attempt inside the substitution will correctly abort the script under
  `set -e` rather than silently leaving `$verify` empty and falling through.
- No new injection surface: the CASE rewrite introduces no variable
  interpolation into the SQL string (still a static literal); the password
  continues to travel via stdin into a container-local env var, never argv.
- `shellcheck` clean apart from an informational, pre-existing SC1091 (dynamic
  `source` path) unrelated to this diff.
- N-1 (fail-open `ELSE 'nonsuper'` on a hypothetically NULL subquery) is
  real but unreachable given `current_user` always resolving to an existing
  `pg_roles` row in this script's actual call pattern — recorded as NIT, not
  SHOULD-FIX.
