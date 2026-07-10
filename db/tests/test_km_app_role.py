"""B-030: security assertions for migration 047 (`km_app` least-privilege role).

WHY THIS FILE EXISTS:
    047 is a SECURITY migration — its whole value is what the `km_app` role
    can NOT do. test_migrations_real.py proves foundation migrations apply
    and reverse; this file proves the *privilege boundary*:

      * km_app CAN run DML (SELECT/INSERT/UPDATE/DELETE) on app tables and
        consume sequences — including on a table created AFTER 047 by the
        migration-runner role (the ALTER DEFAULT PRIVILEGES path, which is
        what keeps Phase-2 tables from 500-ing the app).
      * km_app can NOT run DDL (CREATE/DROP/ALTER TABLE, CREATE INDEX),
        TRUNCATE, COPY ... FROM PROGRAM (the T9 RCE vector), CREATE ROLE,
        or rewrite `schema_migrations`.
      * 047 rolls back cleanly (role + grants + default-privilege entries all
        gone) and re-applies over a lingering cluster-wide role — roles are
        cluster-wide while schema_migrations is per-database, so re-apply
        after a DB rebuild is a real production scenario, not a test artifact.

    The password used here is a TEST-ONLY literal for the throwaway
    testcontainer (047 itself creates the role with NO password; prod sets one
    out-of-band via Deploy/set-km-app-password.sh). It is not a secret.

SCOPE NOTE: full app-against-km_app validation (the Express server actually
serving traffic as km_app) happens at deploy time on the IDLE blue/green color
behind the health gate — this file is the pre-merge approximation of it.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

import psycopg
import pytest
import structlog
from psycopg import conninfo, errors

from db import migrate  # type: ignore[import-not-found]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]


LOG = structlog.get_logger(__name__)

pytestmark = pytest.mark.skipif(
    PostgresContainer is None,
    reason="testcontainers not installed — `pip install testcontainers[postgres]`",
)

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)

# Test-container-only credential (the container is destroyed after the run).
# Deliberately NOT shaped like a real secret so scanners stay green.
KM_APP_TEST_PASSWORD = "km-app-testcontainer-only"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _copy_real_migrations(dest: pathlib.Path, versions: Iterable[str]) -> None:
    """Copy the production .up.sql/.down.sql for `versions` into `dest`
    (isolates the runner from sibling migrations — same pattern as
    test_migrations_real.py)."""
    dest.mkdir(parents=True, exist_ok=True)
    wanted = set(versions)
    copied: set[str] = set()
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix != ".sql" or not src.is_file():
            continue
        version_prefix = src.name.split("_", 1)[0]
        if version_prefix in wanted:
            shutil.copy2(src, dest / src.name)
            copied.add(version_prefix)
    missing = wanted - copied
    if missing:
        raise FileNotFoundError(
            f"expected real migration files for versions {sorted(missing)} "
            f"under {REAL_MIGRATIONS_DIR}, found none"
        )


def _as_km_app(dsn: str) -> str:
    """The superuser test DSN, re-pointed at km_app + the test password."""
    params = conninfo.conninfo_to_dict(dsn)
    params.update(user="km_app", password=KM_APP_TEST_PASSWORD)
    return conninfo.make_conninfo(**params)


def _role_exists(cur: psycopg.Cursor) -> bool:
    cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'km_app'")
    return cur.fetchone() is not None


def _default_acl_entries_for_km_app(cur: psycopg.Cursor) -> int:
    """Count pg_default_acl entries that grant anything to km_app.

    The `defaclacl::text LIKE` match is deliberate: after DROP ROLE the role
    name cannot appear in any surviving ACL (Postgres would have blocked the
    drop), so LIKE-on-name is exact for our purposes and avoids aclexplode
    gymnastics on a dropped-role OID.
    """
    cur.execute(
        "SELECT count(*) FROM pg_default_acl WHERE defaclacl::text LIKE '%km_app%'"
    )
    return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# Fixtures — same container-per-module / fresh-DB-per-test pattern as the
# sibling migration test files.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    """Per-test fresh state. Schema drop covers objects + per-schema
    default-privilege entries, but roles are CLUSTER-wide — drop a lingering
    km_app too so every test starts from a clean cluster, not just a clean
    schema."""
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
        if _role_exists(cur):
            cur.execute("DROP OWNED BY km_app")
            cur.execute("DROP ROLE km_app")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


@pytest.fixture()
def role_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (foundation tables the grants must cover) + 047 (the role)."""
    d = tmp_path / "migrations_role"
    _copy_real_migrations(d, versions={"001", "047"})
    return d


# ---------------------------------------------------------------------------
# 1. The security assertion: DML allowed, DDL / escalation denied
# ---------------------------------------------------------------------------

def test_047_km_app_dml_allowed_ddl_denied(
    env, dsn: str, role_dir: pathlib.Path
) -> None:
    LOG.info("km_app_role.apply", versions=("001", "047"))
    rc = migrate.main(["--migrations-dir", str(role_dir), "up"])
    assert rc == 0, f"migrate up returned {rc}; expected 0"

    with psycopg.connect(dsn, autocommit=True) as su, su.cursor() as cur:
        # Simulate the out-of-band Deploy/set-km-app-password.sh step (047
        # itself must NOT set a password — that is asserted implicitly: without
        # this ALTER the km_app connection below could never authenticate).
        cur.execute(f"ALTER ROLE km_app PASSWORD '{KM_APP_TEST_PASSWORD}'")

        # Role attributes: every escalation attribute must be off.
        cur.execute(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication,"
            "       rolbypassrls, rolinherit, rolcanlogin"
            "  FROM pg_roles WHERE rolname = 'km_app'"
        )
        row = cur.fetchone()
        assert row is not None, "km_app role missing after 047"
        assert row == (False, False, False, False, False, False, True), (
            f"km_app attribute drift: (super, createdb, createrole, replication,"
            f" bypassrls, inherit, login) = {row}"
        )

        # A table created AFTER 047 by the migration-runner role — the
        # ALTER DEFAULT PRIVILEGES path future migrations will ride.
        cur.execute(
            "CREATE TABLE post_047_widgets ("
            "  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
            "  label TEXT NOT NULL)"
        )

        # Grant matrix on pre-existing objects (001 tables + the runner's
        # bookkeeping table) via the catalog — no column-shape knowledge needed.
        expectations = [
            ("users", "SELECT", True),
            ("users", "INSERT", True),
            ("users", "UPDATE", True),
            ("users", "DELETE", True),
            ("users", "TRUNCATE", False),
            ("users", "REFERENCES", False),
            ("users", "TRIGGER", False),
            ("schema_migrations", "SELECT", True),   # read-only history
            ("schema_migrations", "INSERT", False),
            ("schema_migrations", "UPDATE", False),
            ("schema_migrations", "DELETE", False),
        ]
        for table, priv, expected in expectations:
            cur.execute("SELECT has_table_privilege('km_app', %s, %s)", (table, priv))
            got = cur.fetchone()[0]
            assert got is expected, f"km_app {priv} on {table}: {got}, expected {expected}"

        cur.execute("SELECT has_schema_privilege('km_app', 'public', 'USAGE')")
        assert cur.fetchone()[0] is True
        cur.execute("SELECT has_schema_privilege('km_app', 'public', 'CREATE')")
        assert cur.fetchone()[0] is False, "km_app must not be able to CREATE in public"

        # A pre-047 sequence (001's identity sequences): USAGE+SELECT yes,
        # UPDATE (setval) no.
        cur.execute(
            "SELECT c.oid::regclass::text FROM pg_class c"
            "  JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE c.relkind = 'S' AND n.nspname = 'public' LIMIT 1"
        )
        seq_row = cur.fetchone()
        assert seq_row is not None, "expected at least one sequence after 001"
        seq = seq_row[0]
        for priv, expected in (("USAGE", True), ("SELECT", True), ("UPDATE", False)):
            cur.execute("SELECT has_sequence_privilege('km_app', %s, %s)", (seq, priv))
            got = cur.fetchone()[0]
            assert got is expected, f"km_app {priv} on {seq}: {got}, expected {expected}"

    # ---- live path AS km_app -------------------------------------------------
    with psycopg.connect(_as_km_app(dsn), autocommit=True) as app, app.cursor() as cur:
        cur.execute("SELECT current_user")
        assert cur.fetchone()[0] == "km_app"

        # DML on the post-047 table exercises the default-privileges grant AND
        # identity-sequence USAGE in one go.
        cur.execute("INSERT INTO post_047_widgets (label) VALUES ('a') RETURNING id")
        assert cur.fetchone()[0] == 1
        cur.execute("UPDATE post_047_widgets SET label = 'b'")
        cur.execute("SELECT count(*) FROM post_047_widgets")
        assert cur.fetchone()[0] == 1
        cur.execute("DELETE FROM post_047_widgets")

        # DML privilege on a pre-047 table (WHERE false: the privilege check
        # fires at plan time regardless of matching rows).
        cur.execute("SELECT count(*) FROM users")
        cur.execute("DELETE FROM users WHERE false")

        # THE security assertion: everything DDL-shaped or escalation-shaped
        # must raise 42501 (insufficient_privilege covers both "permission
        # denied" and "must be owner").
        denied = [
            "CREATE TABLE km_app_hax (id INT)",
            "CREATE INDEX km_app_hax_ix ON post_047_widgets (label)",
            "ALTER TABLE post_047_widgets ADD COLUMN h INT",
            "DROP TABLE post_047_widgets",
            "TRUNCATE post_047_widgets",
            "COPY users FROM PROGRAM 'true'",  # the T9 RCE vector
            "CREATE ROLE km_app_evil",
            "INSERT INTO schema_migrations (version, name, checksum)"
            "  VALUES ('999', 'forged', 'deadbeef')",
            "UPDATE schema_migrations SET checksum = 'x' WHERE false",
            "DELETE FROM schema_migrations WHERE false",
        ]
        for stmt in denied:
            with pytest.raises(errors.InsufficientPrivilege):
                cur.execute(stmt)  # type: ignore[arg-type]
        LOG.info("km_app_role.denied_ok", statements=len(denied))


# ---------------------------------------------------------------------------
# 2. Round trip + idempotent re-apply over a lingering cluster-wide role
# ---------------------------------------------------------------------------

def test_047_round_trip_and_reapply_over_lingering_role(
    env, dsn: str, role_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(role_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        assert _role_exists(cur)
        # tables + sequences entries from the two ALTER DEFAULT PRIVILEGES
        assert _default_acl_entries_for_km_app(cur) == 2

    # Roll back ONLY 047 (--target 001 keeps 001 applied). 047's down contains
    # no destructive-scanner keywords (DROP ROLE/OWNED are not data loss), so
    # no --allow-destructive is needed — matching how a deploy would run it.
    rc = migrate.main(["--migrations-dir", str(role_dir), "--target", "001", "down"])
    assert rc == 0, "047 down failed"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        assert not _role_exists(cur), "km_app must be dropped by 047 down"
        assert _default_acl_entries_for_km_app(cur) == 0, (
            "default-privilege entries for km_app must not survive rollback"
        )
        cur.execute("SELECT version FROM schema_migrations")
        assert {r[0] for r in cur.fetchall()} == {"001"}

        # Second down of an already-rolled-back 047 exercises the down file's
        # own idempotence guard at the SQL level (the runner would normally
        # skip it — run the body directly, as a manual psql re-run would).
        cur.execute((role_dir / "047_km_app_role.down.sql").read_text(encoding="utf-8"))

        # Simulate the real re-apply scenario: the cluster still has a km_app
        # role (with WRONG, escalated attributes) left over from a previous
        # database life — 047 up must converge it, not error.
        cur.execute("CREATE ROLE km_app LOGIN CREATEDB")

    rc = migrate.main(["--migrations-dir", str(role_dir), "up"])
    assert rc == 0, "047 up must re-apply over a lingering km_app role"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SELECT rolcreatedb FROM pg_roles WHERE rolname = 'km_app'")
        assert cur.fetchone()[0] is False, (
            "re-apply must strip escalated attributes from a lingering role"
        )
        cur.execute("SELECT has_table_privilege('km_app', 'users', 'SELECT')")
        assert cur.fetchone()[0] is True
        assert _default_acl_entries_for_km_app(cur) == 2
