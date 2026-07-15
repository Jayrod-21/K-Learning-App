# Fix Report: feat/beta-phaseB2b-infra (addressing REVIEW_b2b-infra.md)

Base for this pass: `be81d73` on `feat/beta-phaseB2b-infra`.
Reviewed findings addressed: **SF-1** (SHOULD-FIX) and **N-1** (NIT).
SF-2 (client/README.md doc-parity gap) was out of scope for this pass — not
requested — and is left for a follow-up doc pass; noted here so it isn't lost.

## Disposition

### SF-1 — Stale `node:20-slim` doc comments (FIXED)

- `server/tests/services/pdfPageRender.test.ts:6` — `node:20-slim` → `node:22-slim`.
- `server/tests/services/pdfPageRender.bounds.test.ts:11` — `node:20-slim` → `node:22-slim`.

Both comments now correctly describe the verify container as `node:22-slim`,
matching `Deploy/local-test.sh`'s `NODE_IMAGE` and every Dockerfile touched by
F-085. No functional code changed (doc-comment only), so no test re-run risk
beyond typecheck (see Gate below).

**Repo-wide `node:20` completeness grep (post-fix):**

Ran against `git ls-files` (i.e. the tracked repo — the actual shipped
content, not local scratch), the same scope the original reviewer used:

```
git ls-files -z | xargs -0 grep -lE "node:20(-slim|-alpine)?\b|node-version:\s*['\"]?20\b"
```

Result: **49 files**, every single one a `.md` doc under `db/docs/`,
`docs/redesign/`, `Deploy/FIX_REPORT.md`, `Deploy/REVIEW_FIX*.md`, or
`BUGS_AND_FEATURES.md` — all dated review/backlog/fix-report records of past
states, matching the original reviewer's call that this class of doc is
correctly left untouched (rewriting historical review docs to retroactively
say "22" would falsify the historical record of what was reviewed at the
time).

**Zero hits in any non-`.md` tracked file** — confirmed by piping the same
list through `grep -v '\.md$'`, which returned nothing (exit 1 / no match).
That means zero hits in any Dockerfile, `.github/workflows/*.yml`,
`docker-compose*.yml`, `package.json`, shell script, or source/test file —
i.e. exactly the SF-1 gate (ZERO functional/live hits) is met.

One caveat for transparency: an unfiltered filesystem grep (not
`git ls-files`) also turns up ~900 hits under `.claude/worktrees/*` — these
are untracked, stale local scratch copies of the repo left over from prior
agent worktree sessions (confirmed via `git status --porcelain .claude` →
`?? .claude/`, i.e. wholly untracked, not part of the repo that ships or
gets reviewed/deployed). They are not part of the tracked tree, are not
touched by this diff, and are excluded from the completeness claim on the
same basis the original reviewer excluded historical `.md` docs: they are not
live, shipped content. Recommend an out-of-band cleanup (`rm -rf
.claude/worktrees`) at some point, but it's not in scope for this fix-pass and
not a "node:20 in the repo" finding.

### N-1 — `set-km-app-password.sh` fail-open `ELSE` (HARDENED)

`Deploy/set-km-app-password.sh` — the verify query's `CASE` used to be:

```sql
CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     THEN 'super' ELSE 'nonsuper' END
```

If the inner scalar subquery ever returned `NULL` (no matching `pg_roles`
row), `CASE WHEN NULL THEN … ELSE 'nonsuper' END` renders `'nonsuper'` — the
exact success token the outer `!=` check looks for. That's a fail-open shape:
an inconclusive/erroneous check would render as PASS. Unreachable in the
script's actual call pattern today (`current_user` is definitionally the role
we just authenticated as, always present in `pg_roles`), but a security
verification gate shouldn't rely on "this branch can't happen" for its
correctness.

Fixed to an explicit three-way `CASE` with a positive match on each expected
boolean state and a distinct token for anything else:

```sql
CASE
    WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS TRUE  THEN 'super'
    WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS FALSE THEN 'nonsuper'
    ELSE 'unknown'
END
```

`IS TRUE` / `IS FALSE` are NULL-safe boolean predicates (unlike bare `WHEN
<expr> THEN`, which treats `NULL` as falsy and falls through). Now: real
non-super → `'nonsuper'` (passes, F-126 behavior preserved), real superuser →
`'super'` (still fails the `!= 'km_app:nonsuper'` check, F-126 behavior
preserved), and `NULL`/missing-role/any other value → `'unknown'` (fails the
check — fail-closed). Added an inline comment above the query (see script)
explaining the exact fail-open shape being avoided and why, per the review's
"add a comment" ask.

## Gate results

- **`shellcheck -x Deploy/set-km-app-password.sh`** → **clean** (exit 0, zero
  output — no warnings, no info-level SC1091 or otherwise).
- **Repo-wide `node:20` grep** → **ZERO** hits in any tracked non-`.md` file
  (see SF-1 section above for full methodology and the historical-doc /
  untracked-worktree carve-outs, both consistent with the original review's
  own exclusions).
- **`server/` `npm run typecheck`** (`tsc --noEmit`) → **0 errors** (host
  Node `v20.20.2`).
- **`client/`** has no `typecheck` script (its `build` script is `tsc -b &&
  vite build`). Running `npx tsc -b --noEmit` hit a pre-existing, unrelated
  environment issue: `node_modules/.tmp/*.tsbuildinfo` is owned by `root`
  (leftover from a prior root-run process on this shared machine), so the
  incremental build-info write fails with `EACCES` under the current
  `jared-williams` user — not caused by, or related to, this diff. Worked
  around by running the two underlying project configs directly with
  `--noEmit` (bypasses the `.tsbuildinfo` write entirely):
  `npx tsc --noEmit -p tsconfig.app.json` → **0 errors**;
  `npx tsc --noEmit -p tsconfig.node.json` → **0 errors**. Recommend an
  out-of-band `sudo chown -R $(whoami) client/node_modules/.tmp` (or `rm -rf
  client/node_modules/.tmp`) to fix the underlying permission issue for
  future `npm run build`/CI-equivalent local runs; not part of this diff's
  scope.
- **Fail-closed SQL re-verification**, against a throwaway `postgres:16-alpine`
  container (`km-verify-tmp`, created and destroyed for this check only —
  the shared `km-db` container was never touched):
  - Non-super role, real authenticated connection, NEW `CASE` →
    `km_app_ns:nonsuper` (passes — F-126 behavior intact).
  - Superuser role, real authenticated connection, NEW `CASE` →
    `km_app_su:super` (still correctly fails the `!=` check).
  - Simulated NULL/missing-role scenario (rolname substituted to a
    nonexistent role, reproducing the subquery-returns-NULL shape), NEW
    `CASE` → `ghost_role:unknown` (fails the check — **fail-closed**,
    confirmed fixed).
  - Same NULL scenario against the OLD `CASE` shape, run side-by-side for
    contrast → `ghost_role:nonsuper` (the fail-open bug, reproduced one more
    time to confirm the diagnosis was correct before trusting the fix).

## Self-assessment

Both findings addressed as scoped. SF-1's fix is a pure doc-comment
correction with no runtime surface, verified by grep + typecheck (which would
have caught any accidental syntax breakage from the edit — it didn't, none
occurred). N-1's fix changes live SQL inside a deploy script; verified by
re-deriving all three relevant states (non-super/super/NULL-shape) against a
disposable Postgres 16 container matching `km-db`'s image, not just by
reading the SQL. Did not touch or restart the shared `km-db` container at any
point — the live role's password is unaffected by this fix-pass.

Not done, intentionally: SF-2 (`client/README.md` doc-parity note) — outside
the two findings this pass was scoped to address; flagging so it isn't
silently dropped from the backlog.
