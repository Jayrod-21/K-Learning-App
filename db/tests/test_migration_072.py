"""Migration 072 (book_upload_type 'comic' value, Track P) — real-chain tests.

WHY THIS FILE EXISTS:
    072 is a value-only ``ALTER TYPE book_upload_type ADD VALUE`` (mirroring
    053/031/032 and the 021/016 split pattern). Its entire contract is: after
    a full up, the enum accepts 'comic' (so a ``POST /uploads`` insert with
    ``type = 'comic'`` — Track P's display-only picture/comic/manga upload —
    succeeds instead of failing with `invalid input value for enum
    book_upload_type`), and its down is a DOCUMENTED no-op (PG cannot drop
    enum values), so a rollback below 072 leaves the value in place harmlessly
    and a re-up is clean (ADD VALUE IF NOT EXISTS).

SCOPE:
    - up: 'comic' present in the migrated enum AND usable as a cast from a
      separate transaction (values added in migrate.py's tx are only usable
      post-commit — prove the commit happened).
    - up: re-apply is idempotent (ADD VALUE IF NOT EXISTS).
    - down: rolling back below 072 leaves the value in the enum (no-op down,
      by design) and does not error; a subsequent full up re-applies cleanly.

DETERMINISM:
    Mirrors test_migration_053.py — the real migration files are copied into
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

# The migration immediately before 072 in the chain. `down --target PRE_072`
# rolls back just 072 (the no-op down under test — 072 is the chain head).
PRE_072 = "071"

NEW_VALUE = "comic"


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
            "SELECT e::text FROM unnest(enum_range(NULL::book_upload_type)) AS e"
        )
        return {row[0] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. UP — the value is present AND usable post-commit
# ---------------------------------------------------------------------------

def test_072_up_adds_comic(env, dsn: str, full_dir) -> None:
    """Full-chain up: 'comic' is a member of book_upload_type, and it is
    usable as a cast from a NEW connection/tx — ADD VALUE inside migrate.py's
    transaction is only usable after commit, so a successful cast here proves
    the migration committed the value."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        assert NEW_VALUE in values, (
            f"book_upload_type is missing {NEW_VALUE!r} after full up"
        )

        # Usability: the cast a `POST /uploads` insert with type='comic'
        # performs must succeed (this is what would fail with `invalid input
        # value for enum book_upload_type` were 072 missing or uncommitted).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT %s::book_upload_type::text", (NEW_VALUE,))
            assert cur.fetchone()[0] == NEW_VALUE


def test_072_up_is_idempotent_on_reapply(env, dsn: str, full_dir) -> None:
    """ADD VALUE IF NOT EXISTS: running the chain up when everything is
    already applied is a no-op, and a hand re-apply of 072's statement
    against the migrated DB does not error (the IF NOT EXISTS guard)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            f"ALTER TYPE book_upload_type ADD VALUE IF NOT EXISTS '{NEW_VALUE}'"
        )
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert NEW_VALUE in _enum_values(conn)


# ---------------------------------------------------------------------------
# 2. DOWN — documented no-op; the value persists harmlessly; re-up clean
# ---------------------------------------------------------------------------

def test_072_down_is_noop_and_reup_clean(env, dsn: str, full_dir) -> None:
    """Rolling back below 072 succeeds (072's no-op down), the enum value
    REMAINS (PG cannot drop enum values — 072's down documents this, same
    posture as 053/031/032), and a subsequent full up re-applies 072
    cleanly."""
    _full_up(full_dir)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_072,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_072} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # The no-op down leaves the value in place — harmless if unused.
        assert NEW_VALUE in _enum_values(conn), (
            f"{NEW_VALUE!r} vanished on down — 072's down must be a no-op "
            "(PG cannot drop enum values)"
        )

    # Re-up: IF NOT EXISTS makes 072 idempotent against the surviving value.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert NEW_VALUE in _enum_values(conn)
