# ADR-010: Build `migrate.py` instead of adopting Alembic / Sqitch / Flyway

**Status:** Accepted
**Date:** 2026-05-28

> **Amendment (2026-07-10):** `--dry-run` now evaluates the destructive-SQL
> gate on the planned bodies (up and down) and exits non-zero on a pending
> destructive migration without `--allow-destructive`, instead of deferring
> the `DestructiveBlocked` to the apply step. Rationale: the blue/green deploy
> (`Deploy/azure-deploy-inactive.sh` step 4) documents its `--dry-run up` as
> the expand/contract safety gate, but the gate previously fired only in
> `apply_one` — so a destructive release aborted mid-deploy with misleading
> restore advice rather than at the plan stage. Found by the Phase-2 Group-1
> integration review (S-1). No new flags or features; the existing gate is
> evaluated one step earlier. Covered by
> `db/tests/test_migrations.py::test_dry_run_evaluates_destructive_gate`.

## Context

ADR-001 §D11 commits us to numbered forward/reverse SQL migration files. Any
mature shop typically reaches for an off-the-shelf migration tool. We
considered:

| Tool | Notes |
|---|---|
| **Alembic** | Python, mature, ubiquitous in the SQLAlchemy world. Presumes (and rewards using) SQLAlchemy models. Autogeneration is the headline feature. |
| **Sqitch** | Excellent SQL-first design (this is the model we conceptually like most). Written in Perl — adds a runtime nobody on the team uses. |
| **Flyway** | Industry standard. Requires a JVM. Free tier is fine for our needs. |
| **golang-migrate** | Single binary, simple. Adds a Go toolchain for builds, and is opinionated about file naming. |
| **dbmate** | Single binary, Ruby/Go, SQL-first. Smaller community, fewer guarantees about long-term maintenance. |

## Decision

Implement a small (~350-line) Python migration runner — `db/migrate.py` — that
covers exactly what we need and nothing more.

## Rationale

1. **We're SQL-native by policy.** ADR-001 §D12 ("no business logic in the
   DB") and §D11 ("forward + reverse SQL files") mean we treat the schema as
   first-class hand-written SQL. Alembic's autogen is anti-feature for us —
   it'd produce SQLAlchemy-shaped DDL that diverges from the bar we set in
   SENIOR_ENGINEER_BAR.
2. **Toolchain alignment.** Python is already in the stack (loaders, tests,
   this runner). Sqitch (Perl) and Flyway (JVM) add a runtime and a CI image
   for one tool each.
3. **Auditable.** Every senior reviewer can read 350 lines in 10 minutes and
   understand the entire migration system. That's not true of Alembic or
   Flyway.
4. **Feature subset is small and well-defined.** Discover, hash, apply in a
   transaction, record, refuse on mismatch, dry-run, target version. That's
   the whole spec. We don't need branching, environments, baselines, or
   pre/post hooks — those are Flyway features that solve problems we don't
   have.
5. **Testability.** We can write integration tests directly against
   `migrate.main()` — no subprocess shelling, no JDBC drivers to mock.

## Trade-offs and risks

- **NIH risk.** Building your own migration tool is a meme. Defense: the tool
  is small enough that the cost is bounded; the contract (file naming, table
  shape) is portable to Sqitch/Flyway later if we outgrow it.
- **Feature creep risk.** If we start adding `--baseline`, `--repair`,
  per-environment configs, we should stop and adopt Flyway instead. This ADR
  is the trigger point.
- **No GUI / IDE plugin.** Acceptable for our team-of-one and CI.

## Migration-out plan (if this ADR is reversed)

The bookkeeping table (`schema_migrations` with `version, name, checksum,
applied_at`) maps onto Sqitch's `changes` table and Flyway's
`flyway_schema_history` with a one-time shim migration. The SQL files
themselves are tool-agnostic.

## Consequences

- We commit to maintaining `migrate.py`. Any new feature requires an ADR
  amendment justifying it (or a switch to a real tool).
- The test suite (`db/tests/test_migrations.py`) covers the runner's
  behavior; the harness can be relied on by other agents.
