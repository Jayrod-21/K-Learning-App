# ADR-009: Single compose file vs split db compose

**Status:** Accepted
**Date:** 2026-05-28

## Context

The task brief offered the option of extracting the DB service into
`docker-compose.db.yml` and using `-f` to compose layers. Splitting can be
cleaner for stacks where the DB is independently lifecycled (shared infra,
multiple apps, dev vs prod variants).

## Decision

Keep DB, server, and client in a single `docker-compose.yml` at
`Repository/docker-compose.yml`.

## Rationale

1. **Three services, one operator.** Dad's box runs the full stack as one
   unit. `docker compose up` is the operational primitive; splitting forces
   `-f` discipline forever.
2. **Health-gated startup.** The `server` service uses
   `depends_on: db: condition: service_healthy`. That dependency only resolves
   cleanly when the services live in the same project.
3. **No multi-app reuse.** We aren't sharing this Postgres with anything else.
   The hypothetical second consumer of a split DB compose doesn't exist.
4. **Documentation in one place.** Comments at the top of the compose file
   explain the design; readers don't have to assemble it mentally from
   fragments.

## Trade-offs

- If a second app ever needs to share this Postgres, we'll extract then. The
  rule-of-three applies: extract on the third reuse, not the first speculation.
- `docker compose restart db` to bounce just the DB still works inside a
  combined file. No real loss of isolation.

## Consequences

- One file to read, one project name (`korean-master`).
- Resource limits, healthchecks, networks, and logging configs all live next to
  the service they apply to.
- Profiles (`docker compose --profile`) remain available if we later need a
  "db only" mode for offline schema work.
