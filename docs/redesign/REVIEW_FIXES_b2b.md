# Re-Review: feat/beta-phaseB2b-infra fix-pass (be81d73 → 51176ac)

Independent re-reviewer. Did not write the code, the original review, or the
fix-pass. Verified against actual code/commands only — no claim taken on
faith from FIX_REPORT_b2b.md.

## Summary verdict

**PASS**

Both findings addressed as claimed. No regressions, no scope creep, no new
false-PASS surface introduced.

## Finding-by-finding

### SF-1 — stale `node:20-slim` doc comments — **FIXED**

- `server/tests/services/pdfPageRender.test.ts:6` — confirmed now reads
  `node:22-slim`.
- `server/tests/services/pdfPageRender.bounds.test.ts:11` — confirmed now
  reads `node:22-slim`.
- `git diff be81d73 51176ac` on both files shows exactly one line changed
  each (`node:20-slim` → `node:22-slim`), nothing else touched.
- Independent repo-wide grep (my own, not reusing the fix-pass's command):
  `git grep -n 'node:20\|node-version: 20' -- ':!*.md'` → **zero hits, exit
  code 1**. Confirms zero remaining `node:20`/`node-version: 20` in any
  tracked non-`.md` file. (`.claude/` is untracked scratch, correctly outside
  the tracked-tree claim; not evaluated as part of "the repo.")

### N-1 — fail-open `ELSE 'nonsuper'` — **FIXED (hardened, fail-closed)**

Read the live script (`Deploy/set-km-app-password.sh:96-124`). The CASE is
now:

```sql
CASE
    WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS TRUE  THEN 'super'
    WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS FALSE THEN 'nonsuper'
    ELSE 'unknown'
END
```

`IS TRUE`/`IS FALSE` are NULL-safe boolean predicates, and the added
`ELSE 'unknown'` gives a third, distinct token to anything that isn't a
confirmed boolean literal — a genuine fail-closed shape (`unknown` fails the
outer `!= 'km_app:nonsuper'` check, same as `super` does).

**Independently reproduced against a throwaway `postgres:16-alpine`**
(created/destroyed for this check only; shared `km-db` never touched):

| Scenario | Result | Expected |
|---|---|---|
| Real non-super role, real auth connection | `km_app_ns:nonsuper` | passes — confirmed |
| Real superuser role, real auth connection | `km_app_su:super` | fails check — confirmed |
| Simulated NULL/missing-role (nonexistent rolname substituted into the same query shape) | `ghost_role:unknown` | fails check — confirmed fail-closed |
| Same NULL scenario against the OLD (pre-fix) CASE shape, for contrast | `ghost_role:nonsuper` | reproduces the original fail-open bug |

This independently confirms: (a) the F-126 good-config-passes /
bad-config-fails behavior is intact, and (b) the new NULL/unexpected-state
path fails closed rather than silently passing — no new false-PASS was
introduced by the hardening. Note: the script's actual production call
pattern (`current_user` = the just-authenticated role) still can't reach the
`ELSE 'unknown'` branch — the NULL-simulation above uses a substituted
literal rolname to force the branch since a real connection can't produce it
— so this remains a defense-in-depth hardening rather than a fix to a
reachable bug, consistent with how the review and fix-pass both frame it.

## No-regression checks

- **`shellcheck -x Deploy/set-km-app-password.sh`** → clean, exit 0, zero
  output (no warnings, no info, not even the pre-existing SC1091).
- **`server/npm run typecheck`** (`tsc --noEmit`) → 0 errors.
- **Diff scope, `git diff --stat be81d73 51176ac -- .`**: exactly 5 files —
  `Deploy/set-km-app-password.sh` (22 lines), the two test-comment files (2
  lines total, 1 each), and two new doc files
  (`docs/redesign/FIX_REPORT_b2b.md`, `docs/redesign/REVIEW_b2b-infra.md`).
  No Dockerfile, CI workflow, compose file, or package.json was touched in
  this fix-pass — the F-085 node:22 sweep and docker-build-on-22 result from
  the prior pass (be81d73) are untouched and unaffected.

## Recommendation

**Ready to ship.** Both SHOULD-FIX/NIT items from the original review are
verifiably resolved, no regressions detected, no new false-PASS path exists.
SF-2 (`client/README.md` doc-parity note) remains an intentionally deferred,
non-blocking doc-only gap per the fix-pass's own scoping — does not affect
ship readiness.
