# ADR-012: Postgres image choice and version-pin policy

**Status:** Accepted
**Date:** 2026-05-28

## Context

ADR-001 §D1 requires Postgres 16+. The compose file needs to choose a
concrete image and a pin policy that balances reproducibility against
security-patch responsiveness.

## Decision

- **Image:** `postgres:16-alpine` (official Docker Hub, Alpine variant).
- **Major version:** Pinned to `16`. No floating `:latest`.
- **Minor version:** Floating within `16` (the upstream `16-alpine` tag is
  rebuilt for minor releases).
- **Digest pin slot:** A commented-out
  `image: postgres:16-alpine@sha256:…` line is reserved in the compose file.
  Populate after the first `docker pull` to lock the exact image bytes; bump
  the digest deliberately when reviewing a minor upgrade.
- **Upgrade cadence:** Review the Postgres 16 release notes monthly. Pull
  + run the integration tests against the new digest before promoting.

## Rationale

1. **Alpine variant.** Smaller image (~80 MB vs ~150 MB), fewer attack-surface
   packages installed by default. Alpine's `musl` libc has occasionally
   caused subtle issues with some extensions; for our use (vanilla Postgres
   + maybe `pg_trgm` later), it's safe.
2. **Major pin.** Major upgrades (16 → 17) require `pg_upgrade` and explicit
   coordination. Never let those happen on `docker compose pull`.
3. **Minor float.** Security patches in Postgres minor releases (e.g.,
   16.3 → 16.4) are exactly what we want delivered automatically. Pinning
   to a specific minor would block CVE fixes.
4. **Digest pin (deferred-on).** Floating minors + reproducibility tension
   is resolved by populating the digest pin when we want a frozen build
   (e.g., for a release tag), and floating otherwise.

## Alternatives considered

- **`postgres:16` (Debian-based).** Larger, more familiar tooling. Rejected
  for image size; nothing in our stack needs Debian specifically.
- **`postgres:latest`.** Banned by ADR-001 and basic operational hygiene.
- **Bitnami / community variants.** Larger trusted-set than we want.
  Bitnami's images are well-maintained, but they add config layers we
  don't need.
- **CrunchyData PG Operator / Spilo.** Right for k8s; wildly overkill for a
  single Docker host running one DB.

## Trade-offs

- Floating minor means a `docker compose pull` can change the running
  binary. Mitigation: pin the digest before releases; run smoke tests after
  every pull.
- Alpine's musl differs from glibc in edge cases. Mitigation: integration
  tests run against the same image; surprises surface in CI.

## Consequences

- `docker compose pull` is safe-by-default but should be paired with a
  smoke test (just `make db-up && make db-migrate-status` is enough).
- Major upgrade is an event: write an ADR, do a dump+restore on a scratch
  container, schedule the cutover.
