"""pytest config for the audio_stt worker tests.

Adds the repo root to sys.path so ``tools.audio_stt`` and ``db.migrate``
import without a package install (db/tests/conftest.py's stance), and
provides the Postgres-16 testcontainer harness:

  - ONE container + ONE full real-chain migration run per session (the
    worker exercises 073..077 behavior, not migration mechanics — those are
    db/tests/test_migration_07x.py's job, which re-migrates per test);
  - per-test isolation via ``DELETE FROM users`` — every audio row
    (sources -> tracks -> segments) and every job row CASCADEs from its
    user, so this one statement resets the whole worker surface.

faster-whisper is NEVER imported: worker tests inject fake transcribe
functions; the mapping tests monkeypatch sys.modules.
"""

from __future__ import annotations

import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pytest  # noqa: E402

# psycopg (and db.migrate, which imports it) are guarded so the PURE tests
# (mapping/blobstore/config) still collect and run in an environment without
# the driver — only the DB-backed worker tests skip. [T-N4]
try:
    import psycopg  # noqa: E402

    from db import migrate  # noqa: E402  type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]
    migrate = None  # type: ignore[assignment]

try:
    from testcontainers.postgres import PostgresContainer  # noqa: E402  type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment]

REAL_MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"

requires_pg = pytest.mark.skipif(
    psycopg is None or PostgresContainer is None,
    reason=(
        "psycopg + testcontainers required — "
        "`pip install 'psycopg[binary]' 'testcontainers[postgres]'`"
    ),
)


@pytest.fixture(scope="session")
def dsn(request) -> str:
    """A migrated Postgres-16 container DSN, shared across the session."""
    if psycopg is None or PostgresContainer is None:  # pragma: no cover
        pytest.skip("psycopg + testcontainers not installed")
    with PostgresContainer("postgres:16-alpine") as pg:
        raw = pg.get_connection_url()
        raw = raw.replace("postgresql+psycopg2://", "postgres://")
        raw = raw.replace("postgresql://", "postgres://")
        # migrate.py reads DATABASE_URL; --allow-destructive because 045
        # (hygiene_cleanup) sits in the chain (db/tests' stance).
        mp = pytest.MonkeyPatch()
        request.addfinalizer(mp.undo)
        mp.setenv("DATABASE_URL", raw)
        rc = migrate.main(
            ["--migrations-dir", str(REAL_MIGRATIONS_DIR), "--allow-destructive", "up"]
        )
        assert rc == 0, f"full migration up returned {rc}"
        yield raw


@pytest.fixture()
def conn(dsn: str):
    """Autocommit connection with a clean slate (users CASCADE-reset)."""
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("DELETE FROM users")
        yield c


@pytest.fixture()
def pool(dsn: str):
    """A small sync pool, the worker's runtime connection source."""
    from psycopg_pool import ConnectionPool

    p = ConnectionPool(dsn, min_size=1, max_size=3, open=False)
    p.open(wait=True, timeout=30)
    try:
        yield p
    finally:
        p.close()
