"""Migration 062 (revoke km_app TEMP privilege, ticket F-089) — real-chain tests.

WHY THIS FILE EXISTS:
    062 completes B-030's least-privilege posture: Postgres grants every role
    TEMPORARY on every database by default (via the implicit PUBLIC
    pseudo-role), so `km_app` (047) has always been able to create session-
    local temp tables even though nothing in the app uses them. This file
    proves both REVOKEs actually land (km_app AND PUBLIC), that the migration
    applies WITHOUT --allow-destructive (F-088's explicit `-- migrate:
    non-destructive` marker on 062 must be honored — a REVOKE is not data
    loss), and that the down migration restores the cluster's default.

SCOPE:
    - 062's own SQL files classify as non-destructive via F-088's marker
      (not the legacy keyword-sniff — there is no DROP/TRUNCATE here for the
      sniff to catch, so this is really pinning that the marker mechanism
      works end-to-end on a real migration, not just the unit-level
      migrate.py tests).
    - up: has_database_privilege('km_app', ..., 'TEMP') flips to false, and
      so does PUBLIC's (checked via a throwaway probe role that has never
      been explicitly granted anything, so its only TEMP source is PUBLIC).
    - up applies cleanly even when 047 (km_app) is ABSENT from the chain (the
      guard around step 1 must not error).
    - down: both privileges are restored.

DETERMINISM:
    Mirrors test_migration_061.py — real migration files copied into a
    tmp_path-scoped dir, runner pointed at it via --migrations-dir, fresh
    schema+cluster state per test.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Iterable

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]


pytestmark = pytest.mark.skipif(
    PostgresContainer is None,
    reason="testcontainers not installed — `pip install testcontainers[postgres]`",
)

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)

KM_APP_TEST_PASSWORD = "km-app-testcontainer-only"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    """Fresh schema AND a clean cluster (roles are cluster-wide) per test —
    same discipline as test_km_app_role.py's dsn fixture."""
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'km_app'")
        if cur.fetchone() is not None:
            cur.execute("DROP OWNED BY km_app")
            cur.execute("DROP ROLE km_app")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


def _copy_real_migrations(dest: pathlib.Path, versions: Iterable[str]) -> None:
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


@pytest.fixture()
def role_and_temp_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 (foundation) + 047 (km_app) + 062 (the TEMP revoke)."""
    d = tmp_path / "migrations_temp"
    _copy_real_migrations(d, versions={"001", "047", "062"})
    return d


@pytest.fixture()
def temp_only_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """001 + 062 WITHOUT 047 — proves the km_app-existence guard doesn't
    error when the role was never created."""
    d = tmp_path / "migrations_temp_only"
    _copy_real_migrations(d, versions={"001", "062"})
    return d


def _current_db(cur: psycopg.Cursor) -> str:
    cur.execute("SELECT current_database()")
    return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker: 062 classifies as non-destructive, applies WITHOUT
#    --allow-destructive.
# ---------------------------------------------------------------------------

def test_062_files_are_marked_non_destructive() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "062_revoke_km_app_temp.up.sql").read_text(
        encoding="utf-8"
    )
    down_sql = (REAL_MIGRATIONS_DIR / "062_revoke_km_app_temp.down.sql").read_text(
        encoding="utf-8"
    )
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is False
    assert not migrate.contains_destructive(up_sql)
    assert not migrate.contains_destructive(down_sql)


def test_062_up_and_down_apply_without_allow_destructive(
    env, dsn: str, role_and_temp_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(role_and_temp_dir), "up"])
    assert rc == 0, "062 up must not require --allow-destructive (F-088 marker)"

    rc = migrate.main(
        ["--migrations-dir", str(role_and_temp_dir), "--target", "047", "down"]
    )
    assert rc == 0, "062 down must not require --allow-destructive (F-088 marker)"


# ---------------------------------------------------------------------------
# 2. The real privilege change: km_app AND PUBLIC lose TEMP; a probe role
#    with nothing explicitly granted (so PUBLIC is its only TEMP source)
#    proves the PUBLIC-wide revoke, not just km_app's own.
# ---------------------------------------------------------------------------

def test_062_revokes_temp_from_km_app_and_public(
    env, dsn: str, role_and_temp_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(role_and_temp_dir), "up"])
    assert rc == 0

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        dbname = _current_db(cur)

        cur.execute("SELECT has_database_privilege('km_app', %s, 'TEMP')", (dbname,))
        assert cur.fetchone()[0] is False, "km_app must lose TEMP after 062"

        # A throwaway role with NOTHING explicitly granted — its only possible
        # TEMP source is the PUBLIC default. If PUBLIC still has it, this
        # comes back True even though we only intended to test km_app.
        cur.execute("CREATE ROLE f089_probe_role LOGIN")
        try:
            cur.execute(
                "SELECT has_database_privilege('f089_probe_role', %s, 'TEMP')",
                (dbname,),
            )
            assert cur.fetchone()[0] is False, (
                "PUBLIC must lose its default TEMP grant after 062 — a fresh "
                "role must not silently inherit it"
            )
        finally:
            cur.execute("DROP ROLE f089_probe_role")


def test_062_down_restores_temp_defaults(
    env, dsn: str, role_and_temp_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(role_and_temp_dir), "up"])
    assert rc == 0

    rc = migrate.main(
        ["--migrations-dir", str(role_and_temp_dir), "--target", "047", "down"]
    )
    assert rc == 0, "062 down failed"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        dbname = _current_db(cur)
        cur.execute("SELECT has_database_privilege('km_app', %s, 'TEMP')", (dbname,))
        assert cur.fetchone()[0] is True, "down must restore km_app's TEMP privilege"

        cur.execute("CREATE ROLE f089_probe_role_2 LOGIN")
        try:
            cur.execute(
                "SELECT has_database_privilege('f089_probe_role_2', %s, 'TEMP')",
                (dbname,),
            )
            assert cur.fetchone()[0] is True, "down must restore PUBLIC's TEMP default"
        finally:
            cur.execute("DROP ROLE f089_probe_role_2")


# ---------------------------------------------------------------------------
# 3. The km_app-existence guard: 062 applies cleanly even when 047 was never
#    run (defence in depth — an isolated chain, or a future reordering, must
#    not error on "role km_app does not exist").
# ---------------------------------------------------------------------------

def test_062_up_without_047_does_not_error(
    env, dsn: str, temp_only_dir: pathlib.Path
) -> None:
    rc = migrate.main(["--migrations-dir", str(temp_only_dir), "up"])
    assert rc == 0, "062 must apply cleanly even when km_app was never created"

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor(
        row_factory=tuple_row
    ) as cur:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'km_app'")
        assert cur.fetchone() is None, "062 must not itself create km_app"
