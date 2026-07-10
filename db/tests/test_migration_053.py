"""Migration 053 (claude_route generation values, F-027/F-073/F-068) —
real-chain tests.

WHY THIS FILE EXISTS:
    053 is a value-only ``ALTER TYPE claude_route ADD VALUE`` pair (mirroring
    031/032). Its entire contract is: after a full up, the enum accepts
    'generate_writing_prompt' and 'generate_story' (so the proxy's
    claude_cache/claude_usage writes for the new generation routes succeed
    instead of failing with `invalid input value for enum claude_route` — the
    exact defect 031/032 fixed for earlier routes), and its down is a
    DOCUMENTED no-op (PG cannot drop enum values), so a rollback below 053
    leaves the values in place harmlessly and a re-up is clean
    (ADD VALUE IF NOT EXISTS).

SCOPE:
    - up: both values present in the migrated enum; both are USABLE as casts
      from a separate transaction (values added in migrate.py's tx are only
      usable post-commit — prove the commit happened).
    - down: rolling back below 053 leaves the values in the enum (no-op down,
      by design) and does not error; a subsequent full up re-applies cleanly.

DETERMINISM:
    Mirrors test_migration_051.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

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

# The migration immediately before 053 in the chain. `down --target PRE_053`
# rolls back 054 (DROP TABLE — destructive) then 053 (no-op down).
PRE_053 = "052"

NEW_VALUES = ("generate_writing_prompt", "generate_story")


# ---------------------------------------------------------------------------
# Fixtures — one container per session, a fresh DB + full migration dir per test
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
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


def _full_up(full_dir: pathlib.Path) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain, so a full `up` trips migrate.py's destructive gate without it.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"


def _enum_values(conn: psycopg.Connection) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e"
        )
        return {row[0] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. UP — both values present AND usable post-commit
# ---------------------------------------------------------------------------

def test_053_up_adds_both_generation_routes(env, dsn: str, full_dir) -> None:
    """Full-chain up: both generation route values are members of
    claude_route, and each is usable as a cast from a NEW connection/tx —
    ADD VALUE inside migrate.py's transaction is only usable after commit,
    so a successful cast here proves the migration committed the values."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values, f"claude_route is missing {v!r} after full up"

        # Usability: the cast the proxy's claude_cache/claude_usage writes
        # perform must succeed (this is exactly what failed pre-031 for the
        # drift 031/032 repaired).
        with conn.cursor(row_factory=tuple_row) as cur:
            for v in NEW_VALUES:
                cur.execute("SELECT %s::claude_route::text", (v,))
                assert cur.fetchone()[0] == v


def test_053_up_is_idempotent_on_reapply(env, dsn: str, full_dir) -> None:
    """ADD VALUE IF NOT EXISTS: running the chain up when everything is
    already applied is a no-op, and a hand re-apply of 053's statements
    against the migrated DB does not error (the IF NOT EXISTS guard)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        for v in NEW_VALUES:
            cur.execute(
                f"ALTER TYPE claude_route ADD VALUE IF NOT EXISTS '{v}'"
            )
    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        assert set(NEW_VALUES) <= values


# ---------------------------------------------------------------------------
# 2. DOWN — documented no-op; values persist harmlessly; re-up clean
# ---------------------------------------------------------------------------

def test_053_down_is_noop_and_reup_clean(env, dsn: str, full_dir) -> None:
    """Rolling back below 053 succeeds (054's destructive DROP + 053's no-op
    down), the enum values REMAIN (PG cannot drop enum values — 053's down
    documents this, same posture as 031/032), and a subsequent full up
    re-applies 053/054 cleanly."""
    _full_up(full_dir)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_053,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_053} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # The no-op down leaves the values in place — harmless if unused.
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values, (
                f"{v!r} vanished on down — 053's down must be a no-op "
                "(PG cannot drop enum values)"
            )

    # Re-up: IF NOT EXISTS makes 053 idempotent against the surviving values.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert set(NEW_VALUES) <= _enum_values(conn)
