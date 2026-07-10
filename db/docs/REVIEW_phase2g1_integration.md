# REVIEW — Phase-2 Group 1 cross-cutting integration (045 + 046 + 047 + deploy)

**Reviewer scope:** how the three Group-1 migrations fit together and ship — the
combined chain, the deploy runbook, docs, and the test-integration fix
(`fa361df`). Branch `feat/phase2-g1-db-foundation` at `fa361df`, diffed against
`rebuild`. Individual reviews of 045/047 and 046 are owned by other reviewers;
overlaps are flagged in **Coordination**.

---

## Summary verdict

**NOT READY TO SHIP — 3 BLOCKERs.**

The combined chain is well-built at the migration layer: all three files are
ADR-013-compliant, idempotent, richly documented, and the full chain
001→047 applies, rolls back to 044, and re-applies cleanly under `migrate.py`
(gate reproduced: **29 passed in 19.58s**, exact command below). The chain-fix
`fa361df` is the right call and correct for `db/tests`.

What is broken is exactly the seam this review owns:

1. **047 breaks every raw-SQL applier of the chain** — the server
   integration-test harness (and the documented manual-psql path) applies
   `*.up.sql` without `migrate.py`, so `schema_migrations` does not exist and
   047's unguarded `REVOKE` fails. Empirically reproduced.
2. **The scripted deploy cannot ship this release and the required manual
   choreography is written down nowhere an operator would look.** The deploy
   aborts at 045 (destructive gate, no `--allow-destructive` in any script),
   and even past that, a single scripted run cannot succeed because the 047
   password step must land between "migrations applied" and "idle color up" —
   which the script does back-to-back with no seam.
3. **046 violates the expand/contract contract the whole blue/green deploy is
   built on**: the still-live old color's `ON CONFLICT (user_id)` loses its
   arbiter index the moment 046 applies, breaking live TOPIK saves until the
   flip — and breaking the post-flip auto-rollback path for this release.

Reproduced gate (report the real count — I did not trust the integrator's):

```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "/home/jared-williams/projects/9b. Korean Master":/repo:ro -w /repo python:3.12 \
  sh -ec 'pip install --quiet --no-cache-dir "psycopg[binary]==3.2.3" "structlog==24.4.0" \
  "testcontainers[postgres]>=4,<5" "pytest>=8,<10" && \
  python -m pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -p no:cacheprovider -q'
→ 29 passed in 19.58s
```

---

## BLOCKERs

### B-1. 047's unguarded `REVOKE ... ON TABLE schema_migrations` breaks the server test suite (and any raw-SQL apply)

`db/migrations/047_km_app_role.up.sql:131`:

```sql
REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM km_app;
```

The file's own header (`047_km_app_role.up.sql:12-13`) asserts
"`schema_migrations` exists whenever this runs: the runner's
`ensure_bookkeeping` creates it before any migration body." That is true **only
for `migrate.py`**. Two supported appliers run the chain without it:

- **The server integration-test harness** —
  `server/tests/helpers/pg.ts:41-63` (`applyMigrations`) reads every
  `*.up.sql` in order and executes them raw. It never creates
  `schema_migrations`. `pg.ts` is untouched by this branch.
- **The documented manual-psql path** — `db/migrations/README.md` repeatedly
  blesses `psql -v ON_ERROR_STOP=1 -1 -f NNN.up.sql` (e.g. lines 537, 599,
  670) as an application method.

**Empirical reproduction** (mimics `pg.ts` exactly — postgres:16-alpine, each
`up.sql` applied in a transaction with ON_ERROR_STOP):

```
FAILED at 047_km_app_role.up.sql:
psql:/m/047_km_app_role.up.sql:131: ERROR:  relation "schema_migrations" does not exist
```

Consequence: **every server integration test file that calls `startPostgres()`
fails at container setup** — that includes this branch's own new tests in
`server/tests/routes/topik.test.ts` (imports at line 40). The branch has not
been pushed, so CI has never run; the Python `db/tests` gate passes only
because `migrate.py` creates the bookkeeping table first. This is a
green-looking branch whose server testcontainer CI job is guaranteed red —
the exact failure mode the "CI double-push cancellation" memory warns gets
misdiagnosed.

**Fix direction (report only):** guard the REVOKE the same way 047 already
guards the role creation, e.g.

```sql
DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM km_app;
    END IF;
END $$;
```

(and re-run both the db/tests gate and at least one `startPostgres`-based
server test file to prove the chain applies both ways). Note the header claim
at lines 12-13 must be corrected too.

### B-2. The deploy runbook cannot ship this release — the required steps exist only in SQL headers, not in the runbook, and the scripted flow has no seam for them

Two independent facts about the scripts:

1. **Every scripted migration apply omits `--allow-destructive`:**
   `Deploy/azure-deploy-inactive.sh:122` (`run_migrate --dry-run up`) and
   `:131` (`run_migrate up`); `Deploy/local-standup.sh:109` and `:114`.
   045 is genuinely destructive (`045_hygiene_cleanup.up.sql:99-100`,
   `DROP TABLE`), and it is the **only** up-migration in the whole chain that
   trips `migrate.py`'s gate (verified by running the runner's own
   comment-stripped regex over all 94 files). So:
   - `azure-deploy-inactive.sh` **aborts at step 4** with "migration APPLY
     failed … restore from the pre-deploy backup if the schema is in a bad
     state" (`azure-deploy-inactive.sh:132-133`) — misleading advice, since a
     `DestructiveBlocked` abort applies nothing and needs no restore.
   - `local-standup.sh` (fresh-box cold bring-up) applies 001→044 and then
     **aborts mid-standup at 045**, leaving the stack half-stood-up
     ("the stack is not yet serving", `local-standup.sh:115`).
2. **Even past 045, one scripted run cannot succeed.** The script applies
   migrations (047 creates `km_app` with a NULL password verifier) and then
   immediately brings the idle color up (`azure-deploy-inactive.sh:149-155`),
   whose `DATABASE_URL` is now the km_app credential
   (`docker-compose.blue.yml:104`, green mirror). km_app cannot authenticate
   until `Deploy/set-km-app-password.sh` runs — and that script refuses to run
   before 047 is applied (`set-km-app-password.sh:52-58`). The password step
   *must* land inside a seam the script does not have. First run's idle color
   health check fails by design (production untouched — good), but the
   operator is left to reverse-engineer the sequence.

The actual working sequence for this release is:

1. Add `KM_APP_USER` / `KM_APP_PASSWORD` (`openssl rand -hex 32`) to
   `Deploy/.env` — note `${KM_APP_PASSWORD:?}` makes **every** compose command
   against either color file fail until this is done, including
   `rebuild-environment.sh`'s teardown.
2. `Deploy/local-build.sh <tag>` and `export DEPLOY_TAG=<tag>`.
3. `bash Deploy/db-backup.sh` (the scripted deploy normally does this before
   migrating — a manual flagged apply must not skip it).
4. Manual one-time apply: `run_migrate --allow-destructive up`
   (via `source Deploy/deployment-utils.sh; load_environment`).
5. `bash Deploy/set-km-app-password.sh`.
6. `Deploy/azure-deploy-inactive.sh <tag>` (migrations no-op; idle color now
   authenticates and health-checks).
7. `Deploy/azure-switch-production.sh <tag>` — **promptly** (see B-3).

**None of this appears in `Deploy/README.md`** — the release flow
(`Deploy/README.md:101-119`) and the first-time setup
(`Deploy/README.md:243`, `python db/migrate.py up`) are both now wrong for
this release, and the first-time path is wrong **forever** (a fresh DB always
traverses 045). The pieces are documented, but scattered where an operator
won't look mid-failure: 045's SQL header (`045_hygiene_cleanup.up.sql:26-35`),
047's ROLLOUT ORDER (`047_km_app_role.up.sql:71-76` — which itself doesn't
match the script's actual step order), the migrations README row
(`db/migrations/README.md:58`), and `.env.example`. Worse,
`Deploy/SECURITY.md:135-140` states a destructive migration "is a release
engineering error and aborts the deploy (`migrate.py` refuses destructive SQL
without `--allow-destructive`, which the deploy never passes)" — the security
doc flatly contradicts the release this branch ships, with no sanctioned
exception procedure.

**Fix direction:** a "shipping 045-047" runbook section in `Deploy/README.md`
(the 7 steps above), a permanent fix to the first-time-setup/cold-standup
instructions (fresh DBs always need the flag at 045 — either document
`run_migrate --allow-destructive up` for cold standup or teach
`local-standup.sh` an explicit opt-in flag), and a
`Deploy/SECURITY.md` §7 amendment describing the deliberate-destructive
exception process.

### B-3. 046 breaks the still-live old color and the post-flip rollback path (expand/contract violation)

`046_topik_attempts_history.up.sql:117` drops `uq_topik_attempts_user`. The
old code still serving production during the deploy window — `rebuild`'s
`server/src/routes/topik.ts:835` and `:1194` — upserts with
`ON CONFLICT (user_id) DO UPDATE`. After 046, the only unique on `user_id` is
the **partial** index (`WHERE status = 'active'`); an `ON CONFLICT (user_id)`
clause with no `WHERE` cannot infer it as arbiter, so Postgres raises
`42P10 — there is no unique or exclusion constraint matching the ON CONFLICT
specification` **on every execution**, not just on conflict. Concretely:

- From the moment 046 applies to the shared DB until the LB flips, the live
  active color's `PUT /topik/attempt` (autosave/resume) and mock-submit both
  500. The old color also mis-renders history: a migrated completed row (its
  `__closed__` tombstone stripped) looks to old code like a resumable
  in-progress attempt with empty picks.
- **The auto-rollback is broken for this release**:
  `Deploy/azure-switch-production.sh:85-102` recovers from a failed post-flip
  health check by flipping back to the prior color — old code on the
  migrated schema, i.e. the same 42P10 breakage. Rollback-by-flip is not a
  valid recovery once 046 is applied; the real recovery is the pre-deploy
  backup or roll-forward.

This matters doubly because B-2 forces a *manual, multi-step* window between
"046 applied" and "flip" — exactly when this breakage is live. On a
single-user app (per project scope) this is survivable **if documented**: do
the apply→flip during idle time, know the flip must be prompt, and know the
auto-rollback is off the table. The deploy scripts' own contract
(`azure-deploy-inactive.sh:9-17`, `Deploy/SECURITY.md` §7) says a non-additive
migration "MUST NOT run on the shared blue/green DB" — 046 is exactly that,
undocumented as such (046's header never mentions the old-color window; 045's
header, by contrast, is exemplary on its own gate). Needs either a two-phase
046 (additive first: add status + partial index, drop the old unique in a
follow-up after the flip) or an explicit, written acceptance of the outage
window + rollback caveat in the runbook. **Coordinate with the 046 reviewer.**

Note the smaller sibling: 045's new FK means old-color inserts into
`grammar_drill_attempts` for un-banked patterns now FK-fail instead of
inserting silently — per 045's header both old and new drill routes only
reference banked patterns, so this is acceptable, but it belongs in the same
runbook paragraph.

---

## SHOULD-FIX

### S-1. The "dry-run gate" does not gate what the deploy says it gates
`Deploy/azure-deploy-inactive.sh:117-127` calls the dry-run "the safety gate:
if it reports a destructive/non-additive change we ABORT." In fact
`migrate.py`'s dry-run returns after printing the plan
(`db/migrate.py:474-477`) and never evaluates `contains_destructive` — the
gate fires only in `apply_one` (`db/migrate.py:358`). So the abort happens at
the *apply* step, whose error text then wrongly suggests a backup restore
(`azure-deploy-inactive.sh:132-133`). Either make `--dry-run` evaluate the
destructive gate (a small, high-value runner change; needs an ADR-010
amendment note) or correct the comments/log messages so the operator isn't
told the wrong story at 2 a.m.

### S-2. Restore-reconcile docs now wrong for 045
`Deploy/README.md:185-186` and `VERIFICATION.md:268-269`:
"`python db/migrate.py up` — IF behind: forward-migrate (expand/contract =
safe)". Restoring any pre-045 dump and forward-migrating hits the destructive
gate at 045 and — per B-3 — is not "expand/contract = safe" through 046.
Add the flag and the caveat where the restore drill is documented.

### S-3. Stale comment contradicting the chain — `db/tests/test_migration_046.py:60-62`
"(There is no 045; the runner orders by version string and does not require
contiguity.)" — false since commit `16a5e10` added 045. `fa361df` fixed the
calls this comment sits above but not the comment. It actively misleads the
next reader about why `--target 044` skips a migration.

### S-4. Dev quickstarts break on fresh DBs
`README.md:25` and `db/README.md:91` (`python db/migrate.py up`) now abort at
045 on any fresh dev database. One line each ("the chain contains one
destructive migration, 045 — pass `--allow-destructive` on a fresh apply")
or a row in `db/README.md`'s troubleshooting table (`db/README.md:181`).

### S-5. `migrate.py` internal doc/code mismatch on the string-literal caveat
`db/migrate.py:288-293` (`strip_sql_noise` docstring) claims
`contains_destructive` uses it; `db/migrate.py:301-302` shows it uses
`strip_sql_comments` only — string literals are NOT stripped from the
destructive scan. Pre-existing on `rebuild` (out of this branch's diff), but
Group 1 is the first work to hit it: 047 had to spell "table truncation" to
dodge its own COMMENT literal (`047_km_app_role.up.sql:107-110`). Fix the
docstring (or the function) so the next migration author doesn't trust the
wrong sentence. I verified no literal in 045/046/047 accidentally trips the
scanner today.

---

## NITs

- `fa361df` also added `--allow-destructive` to the `--target 044 down` call
  (`db/tests/test_migration_046.py:294`) — unnecessary: rolling back
  047→046→045, none of those `.down.sql` bodies contain a
  `DESTRUCTIVE_PATTERNS` token (verified with the runner's regex). Harmless,
  but the commit message ("on 046 full-chain applies") doesn't mention it,
  and unneeded flags erode the gate's signal.
- `db/migrations/README.md:58` (045 row) says "apply with
  `--allow-destructive`" but doesn't say the scripted deploy will abort —
  the row is where a migration author looks, the runbook is where the
  operator looks; B-2's fix covers the latter.
- `047_km_app_role.down.sql` rollback requires repointing `DATABASE_URL`
  back to the superuser *by editing compose/.env* — the down header documents
  this well (`047_km_app_role.down.sql:8-14`), but it's another entry for the
  missing runbook section.

---

## PRAISE (genuine)

- **`fa361df` is the right call.** Adding the flag to the *tests* — rather
  than de-fanging 045 (e.g. renaming the DROPs or splitting them out) — keeps
  the destructive gate honest and keeps the full-chain tests traversing the
  real production chain. All three full-chain `up` applies in
  `test_migration_046.py` (lines 204, 279, 335) are covered; the
  `--target 044` up at line 179 is correctly left unflagged (no up ≤044 is
  destructive — verified). Complete for `db/tests`; B-1 is a 047 defect, not
  a gap in this fix.
- **ADR-013 holds across all three migrations** — no top-level
  BEGIN/COMMIT/ROLLBACK/SAVEPOINT in any of the six files (read directly;
  also enforced at discovery, and 29 passing runner tests prove discovery
  accepted them). PL/pgSQL `DO $$` blocks only.
- **047's password architecture is genuinely good**: secret never in a
  committed file, never in argv; `set-km-app-password.sh`'s stdin discipline
  and its end-to-end verify (authenticates *as* km_app over the host socket
  and asserts `rolsuper = f`, lines 78-89) is the right level of paranoia.
  The compose `${KM_APP_PASSWORD:?}` fail-loud (`docker-compose.blue.yml:104`)
  is exactly right.
- **The migration runner keeps the superuser** — verified end-to-end:
  `run_migrate` builds its DSN from `POSTGRES_USER`
  (`Deploy/deployment-utils.sh:480`), and both color compose files switch only
  the *app's* `DATABASE_URL` to km_app (blue:104; green mirrors it).
- **The three migrations don't step on each other**: 045 drops nothing 046/047
  touch; 046's trigger/table dependencies (037/015) are untouched by 045;
  047 last means its blanket + default-privilege grants cover the final
  shape. Full chain up→down-to-044→up round-trips cleanly under the runner.
- 045's header is a model of how to ship a destructive migration: the gate
  interaction, the exact lossy surfaces, and what the down can/cannot restore
  are all stated up front.
- `db/SECURITY.md` §T9 rewrite is accurate (including the honest "Residual"
  paragraph about the dev stack still using the bootstrap superuser).

---

## Answers to the review's focus questions

| Question | Answer |
|---|---|
| Combined chain applies 001→047? | **Yes under `migrate.py`** (29/29 reproduced, incl. full up→down→re-up). **No under raw SQL appliers** — fails at 047:131 (B-1). |
| Do the three migrations interact badly? | Not with each other. 046 interacts badly with the *old color's code* during the deploy window (B-3). |
| Deploy aborts at 045? | Yes — confirmed in both scripts, and only the SQL header/README row say so; runbook silent (B-2). |
| 047 ordering (env → migrate → password → health → flip)? | Conceptually documented in 047's header, but the scripted deploy has no seam between "migrate" and "color up", so the documented order is unexecutable as written (B-2). |
| `DATABASE_URL` → km_app in both colors? | Yes (blue:104, green mirror). |
| Runner still superuser? | Yes (`deployment-utils.sh:480`). |
| `fa361df` right + complete? | Right call; complete for db/tests; one unneeded flag (NIT), one stale comment left behind (S-3). |
| ADR-013 across all 3? | Compliant, both directions, all six files. |

## Coordination

- **B-1 → 047 reviewer** (the fix lives in 047's up.sql; the *detection* was
  cross-cutting — db/tests can't see it, only the server harness can).
- **B-3 → 046 reviewer** (two-phase alternative vs. documented outage window
  is a 046 design decision; the deploy/rollback consequences are mine).
- **S-5** is pre-existing `rebuild` code (`migrate.py` untouched by this
  branch) — should not block Group 1, but log it.
- Re-run gates after fixes: the db/tests container command above **plus** at
  least one `startPostgres()`-based server test file (e.g.
  `server/tests/routes/topik.test.ts`) — the latter is the regression proof
  for B-1 that the current green run cannot provide.
