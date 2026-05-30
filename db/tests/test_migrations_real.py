"""Closes A-FU-1. Synthetic tests in test_migrations.py don't catch
real-migration bugs; these tests apply the actual production migrations.

WHY THIS FILE EXISTS:
    test_migrations.py exercises the *harness* against synthetic
    `CREATE TABLE foo` migrations. That proves the runner's discovery,
    bookkeeping, atomicity, and checksum logic — but it cannot catch a
    bug in the real 001/002 SQL (a typo in a FK declaration, a missing
    extension, a down.sql that doesn't actually drop what up.sql created,
    etc.). REVIEW_A3 flagged this as a gap (A-FU-1). These tests close
    the gap by applying the production `.up.sql` / `.down.sql` files
    against a real Postgres-16 testcontainer via `migrate.main()`.

SCOPE:
    Only 001_core_schema and 002_darakwon_corpora — the foundation
    layer. Later migrations (003+) are covered by their own A-* tickets.

TEST INVENTORY:
    1. test_apply_001_and_002_against_testcontainers
    2. test_atomicity_on_bookkeeping_failure
    3. test_round_trip_001
    4. test_round_trip_002

DETERMINISM:
    Every test copies the two real migration files into a tmp_path-scoped
    directory and points the runner at that directory via
    `--migrations-dir`. That isolates each test from sibling migrations
    (003..010) and lets the existing `dsn` fixture (DROP SCHEMA public
    per-test) keep tests independent of order.

OUT OF SCOPE:
    Schema *shape* assertions beyond "the table exists" — those live in
    A1's and A2's dedicated schema tests. We're verifying the migrations
    APPLY and ROLL BACK cleanly through the production runner, not the
    column-level correctness of each table.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

import psycopg
import pytest
import structlog

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


# ---------------------------------------------------------------------------
# Constants — source of truth for the real migration files
# ---------------------------------------------------------------------------

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)

# Sample tables created by each migration. We don't enumerate every table —
# just enough to prove the body ran. The full schema shape is A1/A2's
# responsibility.
TABLES_001: tuple[str, ...] = ("users", "grammar_entries")
TABLES_002: tuple[str, ...] = ("kgiu_entries", "vocab_entries")
ALL_FOUNDATION_TABLES: tuple[str, ...] = TABLES_001 + TABLES_002


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _copy_real_migrations(
    dest: pathlib.Path,
    versions: Iterable[str],
) -> None:
    """Copy the production .up.sql / .down.sql files for the given versions
    into `dest`. Isolates the test from sibling migrations (003+) so the
    runner only sees the foundation layer.
    """
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


def _list_user_tables(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT tablename
              FROM pg_tables
             WHERE schemaname = 'public'
               AND tablename NOT LIKE 'pg_%'
             ORDER BY tablename
            """
        )
        return [r[0] for r in cur.fetchall()]


def _applied_versions(conn: psycopg.Connection) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations")
        return {r[0] for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# Fixtures — borrow the session-scoped container, give each test a fresh DB
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    """One Postgres container per test session. Reused across all tests in
    this module — orders of magnitude faster than per-test containers."""
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    """Per-test fresh DB: drop + recreate the public schema. Matches the
    pattern in test_migrations.py so the two files share a container."""
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


@pytest.fixture()
def foundation_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """A tmp directory containing only 001 + 002, copied from production."""
    d = tmp_path / "migrations_foundation"
    _copy_real_migrations(d, versions={"001", "002"})
    return d


@pytest.fixture()
def only_001_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    d = tmp_path / "migrations_001"
    _copy_real_migrations(d, versions={"001"})
    return d


# ---------------------------------------------------------------------------
# 1. End-to-end: 001 + 002 apply cleanly via the real runner
# ---------------------------------------------------------------------------

def test_apply_001_and_002_against_testcontainers(
    env, dsn: str, foundation_dir: pathlib.Path
) -> None:
    """The real `migrate.py up` command applies the production 001 + 002
    SQL files end-to-end against a real Postgres 16.

    Asserts the sample foundation tables exist and both versions are
    recorded in `schema_migrations`.
    """
    LOG.info("real_migrate.start", versions=("001", "002"))
    rc = migrate.main(["--migrations-dir", str(foundation_dir), "up"])
    assert rc == 0, f"migrate up returned {rc}; expected 0"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in ALL_FOUNDATION_TABLES:
            assert name in tables, (
                f"expected table {name!r} after applying 001+002, "
                f"got: {sorted(tables)}"
            )
        applied = _applied_versions(conn)
        assert applied == {"001", "002"}, (
            f"expected schema_migrations rows for 001+002, got {applied}"
        )


# ---------------------------------------------------------------------------
# 2. Atomicity: bookkeeping failure on 002 must NOT leave 002's tables
# ---------------------------------------------------------------------------

def test_atomicity_on_bookkeeping_failure(
    env, dsn: str, foundation_dir: pathlib.Path
) -> None:
    """If the bookkeeping INSERT for 002 fails, 002's DDL must NOT survive
    and no schema_migrations row for 002 may exist.

    Setup:
        1. Apply 001 normally via `migrate.main up --target 001`.
        2. Pre-insert a schema_migrations row with version='002' so the
           runner's INSERT into schema_migrations will fail with a PK
           conflict during apply_one(migration=002).
        3. Invoke apply_one directly on the 002 Migration — the body's
           CREATE TABLEs would succeed, but the bookkeeping INSERT will
           conflict and abort the surrounding `conn.transaction()`.

    Asserts:
        * apply_one raises psycopg.Error.
        * None of 002's tables exist after the failure.
        * The schema_migrations row for 002 is the pre-seeded one (not
          the runner's), proving the runner's INSERT never committed.
        * 001's tables and bookkeeping row are untouched.

    This proves ADR-013 atomicity for the REAL 002 migration, not just
    the synthetic one-table case covered in test_migrations.py.
    """
    # Step 1: apply 001 normally.
    rc = migrate.main(
        ["--migrations-dir", str(foundation_dir), "--target", "001", "up"]
    )
    assert rc == 0, f"applying 001 returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        baseline_tables = set(_list_user_tables(conn))
        for name in TABLES_001:
            assert name in baseline_tables, (
                f"sanity: 001 should have created {name}; "
                f"got {sorted(baseline_tables)}"
            )
        for name in TABLES_002:
            assert name not in baseline_tables, (
                f"sanity: 002 hasn't run yet but {name} already exists"
            )

    # Step 2: pre-insert a conflicting bookkeeping row for version 002.
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO schema_migrations
                (version, name, checksum, applied_by, duration_ms)
            VALUES ('002', 'pre-existing-fault-injection',
                    'deadbeefcafebabe', 'a-fu-1-test', 0)
            """
        )

    # Step 3: discover, locate 002, apply it directly. The body would
    # succeed, but the runner's INSERT into schema_migrations collides
    # with the pre-seeded row and the whole transaction aborts.
    migrations = migrate.discover_migrations(foundation_dir)
    target = next((m for m in migrations if m.version == "002"), None)
    assert target is not None, "discover_migrations did not surface 002"

    conn = migrate.connect_from_env()
    try:
        with pytest.raises(psycopg.Error):
            migrate.apply_one(conn, target, allow_destructive=False)
    finally:
        conn.close()

    # Verify: 002's tables must NOT exist, and the bookkeeping row is the
    # pre-seeded one.
    with psycopg.connect(dsn, autocommit=True) as conn:
        post_tables = set(_list_user_tables(conn))
        for name in TABLES_002:
            assert name not in post_tables, (
                f"ADR-013 violated: {name} from 002 survived a failed "
                f"bookkeeping write. Got tables: {sorted(post_tables)}"
            )
        for name in TABLES_001:
            assert name in post_tables, (
                f"collateral damage: {name} from 001 disappeared "
                f"during the failed 002 apply"
            )
        with conn.cursor() as cur:
            cur.execute(
                "SELECT name FROM schema_migrations WHERE version = '002'"
            )
            row = cur.fetchone()
            assert row is not None, (
                "schema_migrations row for 002 vanished — pre-seeded row "
                "should still be present after the runner's INSERT failed"
            )
            assert row[0] == "pre-existing-fault-injection", (
                f"runner's INSERT for 002 committed despite the conflict; "
                f"name={row[0]!r}"
            )
            cur.execute(
                "SELECT count(*) FROM schema_migrations WHERE version = '001'"
            )
            assert cur.fetchone()[0] == 1, "001 bookkeeping row was lost"


# ---------------------------------------------------------------------------
# 3. Round-trip 001: up → tables exist → down → tables gone → up → clean
# ---------------------------------------------------------------------------

def test_round_trip_001(
    env, dsn: str, only_001_dir: pathlib.Path
) -> None:
    """Apply 001, assert tables, roll back, assert gone, re-apply, assert
    clean. Proves 001's down.sql truly reverses its up.sql — a class of
    bug synthetic tests can't catch.
    """
    # Up #1
    rc = migrate.main(["--migrations-dir", str(only_001_dir), "up"])
    assert rc == 0, f"first up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in TABLES_001:
            assert name in tables, f"001 up failed to create {name}"

    # Down
    rc = migrate.main(
        ["--migrations-dir", str(only_001_dir), "--allow-destructive", "down"]
    )
    assert rc == 0, f"down returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in TABLES_001:
            assert name not in tables, (
                f"001 down.sql failed to drop {name}; remaining tables: "
                f"{sorted(tables)}"
            )
        assert _applied_versions(conn) == set(), (
            "schema_migrations should have no rows after rolling back 001"
        )

    # Up #2 — must succeed again, proving down was clean.
    rc = migrate.main(["--migrations-dir", str(only_001_dir), "up"])
    assert rc == 0, f"re-apply after rollback returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in TABLES_001:
            assert name in tables, (
                f"re-apply of 001 failed to create {name} — down.sql "
                f"left residue that broke up.sql idempotency"
            )


# ---------------------------------------------------------------------------
# 4. Round-trip 002: same loop, against the layered foundation
# ---------------------------------------------------------------------------

def test_round_trip_002(
    env, dsn: str, foundation_dir: pathlib.Path
) -> None:
    """Same round-trip as test_round_trip_001 but for 002.

    002 depends on 001 (FKs into users, etc.), so we apply both up, roll
    back only 002 (down), assert 002's tables vanish while 001's remain,
    then re-apply 002 and assert clean.
    """
    # Up: 001 + 002.
    rc = migrate.main(["--migrations-dir", str(foundation_dir), "up"])
    assert rc == 0, f"initial up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in ALL_FOUNDATION_TABLES:
            assert name in tables, f"initial up failed to create {name}"

    # Down: roll back to version 001 (i.e. drop 002 only).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(foundation_dir),
            "--allow-destructive",
            "--target",
            "001",
            "down",
        ]
    )
    assert rc == 0, f"rollback to 001 returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in TABLES_002:
            assert name not in tables, (
                f"002 down.sql failed to drop {name}; remaining tables: "
                f"{sorted(tables)}"
            )
        for name in TABLES_001:
            assert name in tables, (
                f"rolling back 002 also dropped {name} from 001 — "
                f"down.sql is too aggressive"
            )
        assert _applied_versions(conn) == {"001"}, (
            "schema_migrations should record only 001 after rolling back 002"
        )

    # Re-apply 002 — proves 002.down was clean and 002.up is idempotent
    # against the same starting state.
    rc = migrate.main(["--migrations-dir", str(foundation_dir), "up"])
    assert rc == 0, f"re-apply 002 returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        tables = set(_list_user_tables(conn))
        for name in TABLES_002:
            assert name in tables, (
                f"re-apply of 002 failed to create {name} — its down.sql "
                f"left residue that broke up.sql idempotency"
            )
        assert _applied_versions(conn) == {"001", "002"}
