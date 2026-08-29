# Korean Master — Project Instructions

Production for this app is **this machine (M) only**. It is served at
`korean.jaredstudio.com` through Cloudflare, fronted by the `km-lb` nginx
container on ports 1840/1841.

## Deployment

Deploys are blue/green. `km-lb` points at exactly one color at a time; the other
color is idle and is the rollback target. Deploy to the **idle** color, health
check it, then flip. Never recreate the active color in place — doing so
destroys the ability to roll back.

Scripts live in `Deploy/`: `local-test.sh`, `local-build.sh`, `local-standup.sh`,
`bg-health.sh`, `check-active-env.sh`.

## Blue/Green Deploy Workflow (Korean Master)
Standard sequence: run full test gates → self-review pass → address findings → commit → open PR → blue/green flip → verify migration applied → confirm live. Do not flip to live until the test suite has completed, not merely started.

### Migrations
The deploy runner applies migrations and records them in `schema_migrations`.
Never hand-apply a migration to `km-db` with `psql` — a manual apply leaves the
tracking table out of sync and breaks the next deploy. Confirm the applied
version by querying `schema_migrations` after the flip, not by grepping deploy
output for the word "FAIL".

### nginx route allow-list
Any new top-level API prefix must be added to the `km-lb` allow-list regex in
**both** `Deploy/nginx-blue-active.conf` and `Deploy/nginx-green-active.conf`.
Without it the SPA catch-all shadows the new route and requests return the
client bundle instead of JSON.

## Tests

`TESTS.md` is the manifest — `/testcheck` runs from it. Schema, migration, or
other cross-cutting changes run the **full** server + ingest + db suites, not
just the changed slice: a schema-valid foreign key can still be domain-wrong.

## Backlog

`BUGS_AND_FEATURES.md` at the repo root is the live task list and the source of
truth for feature status. Reconcile it against `git log` on each ship rather
than trusting any summary of it.
