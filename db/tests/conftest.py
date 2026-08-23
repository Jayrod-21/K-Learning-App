"""Pytest config + shared fixtures for db/tests.

Makes `db/migrate.py` importable as `db.migrate`, and hosts the
`pg_container` / `dsn` / `env` / `full_dir` fixtures that used to be
byte-identical (or cosmetically-different-only) copies pasted into every
one of the ~48 db/tests/test_*.py files.

`pg_container` is session-scoped, which is the whole point of hoisting it
here: pytest resolves session-scoped fixtures once per session and shares
them across every module that requests them, so this turns 48 separate
`PostgresContainer` boots into ONE for the whole db/tests run.

`dsn` / `env` / `full_dir` stay function-scoped. Isolation between tests
does NOT depend on how many files share the container: `dsn` drops and
recreates the `public` schema before every single test, so each test still
starts from a byte-for-byte clean database regardless of which module ran
before it.

A few files need MORE than this plain `dsn` (e.g. also dropping the
cluster-wide `km_app` role, which — unlike a schema — is not reset by
`DROP SCHEMA public CASCADE`). Those files (test_km_app_role.py,
test_migration_062.py, test_migration_064.py) keep their own local `dsn`
fixture, which pytest lets a test module define to override the conftest
version for that module only; they still share this module's
`pg_container`, so the container count is unaffected.
"""

from __future__ import annotations

import pathlib
import shutil
import sys

import psycopg
import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Also expose `db` itself as a package by giving it an __init__.py at import time
# if one doesn't exist. We don't write to disk here — sys.path covers it.

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]

REAL_MIGRATIONS_DIR: pathlib.Path = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations"
)


@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    raw = pg_container.get_connection_url()
    # testcontainers returns a SQLAlchemy URL (postgresql+psycopg2://…) — strip
    # the driver suffix for psycopg.
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
def full_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """A tmp directory containing EVERY production migration file."""
    d = tmp_path / "migrations_full"
    d.mkdir(parents=True)
    copied = 0
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file():
            shutil.copy2(src, d / src.name)
            copied += 1
    assert copied > 0, f"no migration files found under {REAL_MIGRATIONS_DIR}"
    return d
