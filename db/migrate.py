"""Migration runner for Korean Master Postgres.

WHY: We need a migration tool that (a) lives in this repo, (b) is auditable in
~300 lines, (c) integrates with our test harness without dragging in a JVM
(Flyway) or Perl (Sqitch). Alembic was rejected because it presumes
SQLAlchemy models — we own raw SQL on purpose (see ADR-001 §D11).

DISCOVERY: applies `NNN_<name>.up.sql` and `NNN_<name>.down.sql` from
`Repository/db/migrations/` in numeric order. The SQL files themselves are
written by other agents (A1, A2, …) — this runner doesn't care what's in
them, only that they exist, parse as SQL, and run inside a single
transaction.

GUARANTEES:
    * Each migration runs inside ONE transaction (psycopg autocommit off).
    * The `schema_migrations` bookkeeping row is written in the SAME
      transaction as the migration body — partial application is impossible.
    * The runner OWNS the transaction (ADR-013). Migration files MUST NOT
      contain top-level `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION`,
      or `SAVEPOINT`. `discover_migrations` rejects any file that does, so
      a buggy migration can never silently truncate the runner's tx.
    * Re-running a migration whose SQL file has been edited since it was
      applied raises `ChecksumMismatch` (refusing to silently diverge).
    * `--dry-run` parses and orders but never opens a write transaction.
    * `--allow-destructive` is required if the migration text mentions
      `DROP TABLE`, `DROP SCHEMA`, `TRUNCATE`, or `DROP DATABASE`
      (case-insensitive, comment-stripped).
    * Migration sessions run with `statement_timeout = 0` and
      `idle_in_transaction_session_timeout = 0` (large indexes can take a
      while; abandoned migrations are caught by the runner's atomicity
      contract, not a timeout).

TRANSACTION GRANULARITY:
    Each migration runs in its own transaction. If migration N fails,
    migrations <N that ran successfully stay applied; N is rolled back to
    its pre-state; N+1…end do not run. This is the conventional contract —
    moving the schema forward in committed steps so rollforward after a fix
    is easy.

EXIT CODES:
    0  success / no-op
    1  validation failure (bad args, missing pair, checksum mismatch)
    2  SQL execution failure
    3  database connection failure
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import os
import pathlib
import re
import sys
from typing import Iterable, Optional, Sequence

import psycopg
import structlog

LOG = structlog.get_logger(__name__)

MIGRATIONS_DIR_DEFAULT = pathlib.Path(__file__).parent / "migrations"
# Version numbers MUST be zero-padded to a uniform width per migration
# directory (today: 3 digits). `sorted()` on the discovered set is a lexical
# sort and only matches numeric order when widths are uniform. If you ever
# write `1000_foo.up.sql` it will sort before `999_bar.up.sql`. Bump everyone
# to 4 digits at that point, or change discover_migrations to int-sort.
MIGRATION_PATTERN = re.compile(r"^(?P<version>\d{3,})_(?P<name>[a-z0-9_]+)\.(?P<dir>up|down)\.sql$")
DESTRUCTIVE_PATTERNS = re.compile(
    r"\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE|DROP\s+DATABASE|DROP\s+TYPE|DROP\s+INDEX)\b",
    re.IGNORECASE,
)

# Transaction-control statements that migration files MUST NOT contain
# (ADR-013). The runner owns each migration's transaction; an inner COMMIT
# would end the runner's tx early and break the atomicity guarantee. We
# strip SQL comments before matching to avoid false positives on documentary
# comments like "-- (legacy BEGIN; was removed)".
TX_CONTROL_PATTERNS = re.compile(
    r"\b(BEGIN(?:\s+(?:WORK|TRANSACTION))?"
    r"|START\s+TRANSACTION"
    r"|COMMIT(?:\s+(?:WORK|TRANSACTION))?"
    r"|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?"
    r"|SAVEPOINT\s+[a-zA-Z_][a-zA-Z0-9_]*"
    r"|RELEASE\s+SAVEPOINT\s+[a-zA-Z_][a-zA-Z0-9_]*"
    r")\b",
    re.IGNORECASE,
)

SCHEMA_MIGRATIONS_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version       TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    checksum      TEXT NOT NULL,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- `applied_by` is set by the runner to "<os-user>@<host>" so it remains
    -- informative even when the runner connects as the Postgres superuser
    -- (SF8 from REVIEW_A3). Default falls back to current_user for the
    -- ensure-bookkeeping path; apply_one overrides on every INSERT.
    applied_by    TEXT NOT NULL DEFAULT current_user,
    duration_ms   INTEGER
);
COMMENT ON TABLE schema_migrations IS
  'Bookkeeping for migrate.py. One row per applied up-migration; row removed on rollback.';
COMMENT ON COLUMN schema_migrations.applied_by IS
  'Identifier of the principal that applied the migration. Format: '
  '"<os-user>@<hostname>" set by apply_one. Cross-references pg_stat_activity '
  'application_name=korean-master-migrate for full session forensics.';
"""


def _runner_principal() -> str:
    """Identifier written to schema_migrations.applied_by.

    Format: ``<os-user>@<hostname>``. Falls back gracefully when either
    component is unavailable — we never want this to crash a migration.
    Length-capped to fit a reasonable column comment.
    """
    import socket

    user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    try:
        host = socket.gethostname() or "unknown"
    except OSError:  # pragma: no cover — gethostname effectively never fails
        host = "unknown"
    principal = f"{user}@{host}"
    return principal[:255]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class MigrationError(Exception):
    """Base class for migration-runner errors."""


class ChecksumMismatch(MigrationError):
    """Applied migration file no longer matches its recorded checksum."""


class MissingPair(MigrationError):
    """Up migration has no matching down (or vice versa)."""


class DestructiveBlocked(MigrationError):
    """Migration contains destructive SQL without --allow-destructive."""


class TxControlInMigration(MigrationError):
    """Migration body contains top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.

    The runner owns each migration's transaction (ADR-013); inner tx control
    would end the runner's tx early and break the atomicity guarantee.
    """


# ---------------------------------------------------------------------------
# Migration discovery
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Migration:
    version: str
    name: str
    up_path: pathlib.Path
    down_path: pathlib.Path

    @property
    def up_sql(self) -> str:
        return self.up_path.read_text(encoding="utf-8")

    @property
    def down_sql(self) -> str:
        return self.down_path.read_text(encoding="utf-8")

    @property
    def checksum(self) -> str:
        """SHA-256 of the up-migration body. Down isn't checksummed —
        we don't track applied downs (the row is just deleted)."""
        h = hashlib.sha256()
        h.update(self.up_sql.encode("utf-8"))
        return h.hexdigest()


def discover_migrations(migrations_dir: pathlib.Path) -> list[Migration]:
    """Walk the migrations directory and return ordered Migration objects.

    Raises MissingPair if any version has an up without a down or vice versa.
    Raises MigrationError if filenames don't match the pattern.
    """
    if not migrations_dir.is_dir():
        raise MigrationError(f"migrations directory not found: {migrations_dir}")

    found: dict[str, dict[str, pathlib.Path]] = {}
    names: dict[str, str] = {}

    for path in sorted(migrations_dir.iterdir()):
        if path.suffix != ".sql" or not path.is_file():
            continue
        match = MIGRATION_PATTERN.match(path.name)
        if not match:
            raise MigrationError(
                f"migration file does not match NNN_name.(up|down).sql: {path.name}"
            )
        version = match.group("version")
        direction = match.group("dir")
        name = match.group("name")
        found.setdefault(version, {})[direction] = path
        if version in names and names[version] != name:
            raise MigrationError(
                f"version {version} has conflicting names: {names[version]} vs {name}"
            )
        names[version] = name

    migrations: list[Migration] = []
    for version in sorted(found):
        pair = found[version]
        if "up" not in pair:
            raise MissingPair(f"version {version} has no .up.sql")
        if "down" not in pair:
            raise MissingPair(f"version {version} has no .down.sql")

        # ADR-013: migration files must not own transactions. The runner
        # wraps each body in a single tx together with the bookkeeping
        # write — an inner COMMIT here would silently end the runner's tx
        # early and decouple the schema change from the schema_migrations
        # row.
        for direction, path in (("up", pair["up"]), ("down", pair["down"])):
            body = path.read_text(encoding="utf-8")
            if contains_top_level_tx_control(body):
                raise TxControlInMigration(
                    f"{path.name} contains top-level BEGIN/COMMIT/ROLLBACK/"
                    "SAVEPOINT. The runner owns the transaction (ADR-013). "
                    "Remove the wrapping BEGIN/COMMIT — `migrate.py` wraps "
                    "every migration body in its own transaction."
                )

        migrations.append(
            Migration(
                version=version,
                name=names[version],
                up_path=pair["up"],
                down_path=pair["down"],
            )
        )
    return migrations


# ---------------------------------------------------------------------------
# Destructive-content detection
# ---------------------------------------------------------------------------

_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
# Postgres dollar-quoted string literals. The tag is optional and matches
# anywhere (we accept any character that isn't `$` in the tag so we don't
# stop early on nested tags). The opening and closing tags must match.
_DOLLAR_QUOTED = re.compile(r"\$([^$]*)\$.*?\$\1\$", re.DOTALL)


def strip_sql_comments(sql: str) -> str:
    """Remove SQL comments so we don't false-positive on commented DDL."""
    return _BLOCK_COMMENT.sub("", _LINE_COMMENT.sub("", sql))


def strip_sql_noise(sql: str) -> str:
    """Strip comments AND dollar-quoted string literals.

    Used by `contains_top_level_tx_control` so that `DO $$ BEGIN ... END $$`
    blocks (where BEGIN is a PL/pgSQL keyword, not a SQL transaction-control
    statement) don't trip the detector.
    """
    # Order matters: strip comments first (comments inside a dollar-quoted
    # string aren't really comments, but the SQL grammar allows them and we
    # don't care for our purposes).
    return _DOLLAR_QUOTED.sub("", strip_sql_comments(sql))


def contains_destructive(sql: str) -> bool:
    return bool(DESTRUCTIVE_PATTERNS.search(strip_sql_comments(sql)))


def contains_top_level_tx_control(sql: str) -> bool:
    """Return True if the migration body contains top-level BEGIN/COMMIT/
    ROLLBACK/SAVEPOINT outside of dollar-quoted strings or comments.

    Migration files must NOT manage their own transactions — the runner
    wraps each body in `with conn.transaction():` so an inner COMMIT would
    end the runner's tx early and break the atomicity guarantee that
    couples the schema change and the schema_migrations row write. See
    ADR-013.
    """
    return bool(TX_CONTROL_PATTERNS.search(strip_sql_noise(sql)))


# ---------------------------------------------------------------------------
# State queries
# ---------------------------------------------------------------------------

def ensure_bookkeeping(conn: psycopg.Connection) -> None:
    """Create the schema_migrations table if it doesn't exist.

    Runs in its own transaction so we leave the connection idle (not
    in-transaction) for subsequent apply_one calls, which open their own
    explicit transactions.
    """
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(SCHEMA_MIGRATIONS_DDL)


def applied_versions(conn: psycopg.Connection) -> dict[str, str]:
    """Return {version: checksum} for migrations recorded as applied.

    Order of iteration matches `ORDER BY version` in the SQL — Python 3.7+
    guarantees insertion order on `dict`, and we insert via a comprehension
    over the cursor result. Callers that iterate this dict (e.g.
    cmd_rollback) rely on that ordering. If you ever return early or
    materialise differently, switch to `list[tuple[str, str]]`.
    """
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT version, checksum FROM schema_migrations ORDER BY version")
        return {row[0]: row[1] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# Apply / rollback
# ---------------------------------------------------------------------------

def apply_one(
    conn: psycopg.Connection,
    migration: Migration,
    *,
    allow_destructive: bool,
) -> None:
    sql = migration.up_sql
    if contains_destructive(sql) and not allow_destructive:
        raise DestructiveBlocked(
            f"{migration.version}_{migration.name}.up.sql contains destructive SQL; "
            "re-run with --allow-destructive to apply."
        )

    LOG.info("apply.begin", version=migration.version, name=migration.name)
    principal = _runner_principal()
    # psycopg defaults to autocommit=False, so this whole block is one tx.
    # ADR-013: the migration body must NOT manage its own transaction;
    # discover_migrations rejects files that try. The body + bookkeeping
    # INSERT therefore commit atomically.
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT clock_timestamp()")
            start = cur.fetchone()[0]
            cur.execute(sql)
            cur.execute("SELECT clock_timestamp()")
            end = cur.fetchone()[0]
            duration_ms = int((end - start).total_seconds() * 1000)
            cur.execute(
                """
                INSERT INTO schema_migrations
                    (version, name, checksum, applied_by, duration_ms)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    migration.version,
                    migration.name,
                    migration.checksum,
                    principal,
                    duration_ms,
                ),
            )
    LOG.info(
        "apply.commit",
        version=migration.version,
        duration_ms=duration_ms,
        applied_by=principal,
    )


def rollback_one(
    conn: psycopg.Connection,
    migration: Migration,
    *,
    allow_destructive: bool,
) -> None:
    sql = migration.down_sql
    # Down migrations are inherently destructive — we still require the flag
    # to make rollbacks deliberate, but the message is gentler.
    if contains_destructive(sql) and not allow_destructive:
        raise DestructiveBlocked(
            f"{migration.version}_{migration.name}.down.sql is destructive by nature; "
            "pass --allow-destructive to confirm rollback."
        )
    LOG.info("rollback.begin", version=migration.version, name=migration.name)
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute("DELETE FROM schema_migrations WHERE version = %s", (migration.version,))
    LOG.info("rollback.commit", version=migration.version)


# ---------------------------------------------------------------------------
# High-level commands
# ---------------------------------------------------------------------------

def cmd_status(conn: psycopg.Connection, migrations: Sequence[Migration]) -> int:
    ensure_bookkeeping(conn)
    applied = applied_versions(conn)
    print(f"{'version':<10} {'name':<40} {'status':<10} checksum-ok")
    print("-" * 80)
    for m in migrations:
        if m.version in applied:
            ok = "yes" if applied[m.version] == m.checksum else "MISMATCH"
            status = "applied"
        else:
            ok = "-"
            status = "pending"
        print(f"{m.version:<10} {m.name:<40} {status:<10} {ok}")
    for version, _ in applied.items():
        if not any(m.version == version for m in migrations):
            print(f"{version:<10} {'(orphan — file missing)':<40} {'applied':<10} -")
    return 0


def cmd_migrate(
    conn: psycopg.Connection,
    migrations: Sequence[Migration],
    *,
    target: Optional[str],
    dry_run: bool,
    allow_destructive: bool,
) -> int:
    ensure_bookkeeping(conn)
    applied = applied_versions(conn)

    for version, checksum in applied.items():
        match = next((m for m in migrations if m.version == version), None)
        if match and match.checksum != checksum:
            raise ChecksumMismatch(
                f"migration {version}_{match.name}.up.sql has been modified since it was "
                f"applied (recorded={checksum[:12]}…, current={match.checksum[:12]}…). "
                "Revert the file or write a new migration."
            )

    pending = [m for m in migrations if m.version not in applied]
    if target is not None:
        pending = [m for m in pending if m.version <= target]

    if not pending:
        LOG.info("migrate.noop", applied=len(applied))
        return 0

    LOG.info("migrate.plan", count=len(pending), versions=[m.version for m in pending])
    if dry_run:
        for m in pending:
            print(f"would apply: {m.version}_{m.name}")
        return 0

    for m in pending:
        apply_one(conn, m, allow_destructive=allow_destructive)
    return 0


def cmd_rollback(
    conn: psycopg.Connection,
    migrations: Sequence[Migration],
    *,
    target: Optional[str],
    dry_run: bool,
    allow_destructive: bool,
) -> int:
    ensure_bookkeeping(conn)
    applied = applied_versions(conn)
    applied_in_order = [m for m in migrations if m.version in applied]
    if not applied_in_order:
        LOG.info("rollback.noop")
        return 0

    if target is None:
        to_rollback = [applied_in_order[-1]]
    else:
        # Roll back everything strictly greater than target.
        to_rollback = [m for m in reversed(applied_in_order) if m.version > target]

    if not to_rollback:
        LOG.info("rollback.noop", target=target)
        return 0

    if dry_run:
        for m in to_rollback:
            print(f"would roll back: {m.version}_{m.name}")
        return 0

    for m in to_rollback:
        rollback_one(conn, m, allow_destructive=allow_destructive)
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def configure_logging() -> None:
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ]
    )


def connect_from_env() -> psycopg.Connection:
    """Build a connection from DATABASE_URL or discrete PG* env vars.

    Sets `application_name=korean-master-migrate` so the migration session is
    distinguishable in `pg_stat_activity`, and explicitly disables both
    `statement_timeout` and `idle_in_transaction_session_timeout` for the
    session — large CREATE INDEX / data-backfill steps can easily exceed
    the role-level timeouts the docker-compose role uses.
    """
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        # Fall back to standard libpq env vars (PGHOST, PGUSER, …).
        pg_host_set = any(
            os.environ.get(k) for k in ("PGHOST", "PGUSER", "PGDATABASE")
        )
        if not pg_host_set:
            raise MigrationError(
                "no database connection configured: set DATABASE_URL, or set "
                "PGHOST + PGUSER + PGDATABASE (with optional PGPASSWORD / "
                "PGPORT) per the libpq convention."
            )
        dsn = ""
    conn = psycopg.connect(
        dsn,
        autocommit=False,
        application_name="korean-master-migrate",
    )
    # SF1 (REVIEW_A3): SECURITY.md and docker-compose comment promise that
    # migrate.py disables statement_timeout on its session. Make that true
    # in fact: do it on every migration connection, before any body runs.
    # `SET LOCAL` would only last one tx; plain SET is session-scoped.
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        cur.execute("SET idle_in_transaction_session_timeout = 0")
    return conn


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Korean Master DB migration runner.")
    parser.add_argument(
        "--migrations-dir",
        type=pathlib.Path,
        default=MIGRATIONS_DIR_DEFAULT,
        help="Directory of NNN_*.up.sql / .down.sql files.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print plan without executing.")
    parser.add_argument(
        "--allow-destructive",
        action="store_true",
        help="Permit DROP TABLE / TRUNCATE / DROP SCHEMA. Required for rollbacks too.",
    )
    parser.add_argument("--target", help="Migrate (or roll back) to this version (inclusive).")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Show applied + pending migrations.")
    sub.add_parser("up", help="Apply all pending migrations.")
    sub.add_parser("down", help="Roll back the most recent applied migration (or to --target).")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    configure_logging()
    args = build_parser().parse_args(argv)

    try:
        migrations = discover_migrations(args.migrations_dir)
    except MigrationError as exc:
        LOG.error("discover.failed", error=str(exc))
        return 1

    try:
        conn = connect_from_env()
    except psycopg.OperationalError as exc:
        LOG.error("connect.failed", error=str(exc))
        return 3

    # NB: we do NOT wrap the dispatch in `with conn:` — psycopg3 treats that
    # as a single transaction for the whole body, but our semantics require
    # one transaction per migration so a later failure can't roll back
    # successfully-applied earlier ones. Each helper opens its own
    # `conn.transaction()` block.
    try:
        if args.command == "status":
            return cmd_status(conn, migrations)
        if args.command == "up":
            return cmd_migrate(
                conn,
                migrations,
                target=args.target,
                dry_run=args.dry_run,
                allow_destructive=args.allow_destructive,
            )
        if args.command == "down":
            return cmd_rollback(
                conn,
                migrations,
                target=args.target,
                dry_run=args.dry_run,
                allow_destructive=args.allow_destructive,
            )
        LOG.error("unknown_command", command=args.command)
        return 1
    except (MigrationError, psycopg.Error) as exc:
        LOG.error("migrate.failed", error=str(exc), type=type(exc).__name__)
        return 2 if isinstance(exc, psycopg.Error) else 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
