"""Migration 095 (user_role, Phase 2.2 admin-role foundation) — real-chain
tests.

WHY THIS FILE EXISTS:
    095 is the storage behind the admin-role foundation: a closed
    `user_role` enum ('user', 'admin') and a NOT NULL `users.role` column
    defaulting to 'user'. This is the LOAD-BEARING privilege column that
    `requireAdmin` (server/src/middleware/auth.ts) gates on — proven here
    against a real Postgres-16 testcontainer via ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (F-088 classification).
    - up: applies on the full real chain; column + enum exist with the
      correct default; a pre-existing row (inserted before 095 runs) is
      backfilled 'user', NOT left NULL or promoted; re-driving the body is
      a no-op.
    - down: refused without --allow-destructive; with it, both the column
      and the enum type are gone, in the right order; re-up is clean.

DETERMINISM:
    Mirrors test_migration_094.py — the real migration files are copied into
    tmp_path-scoped directories and the runner is pointed at them via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import FAKE_HASH  # type: ignore[import-not-found]

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

MIGRATION_NUM = "095"


def _pre_095_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 095 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "095 cannot be the first migration"
    return versions[idx - 1]


def _up(directory: pathlib.Path, target: str | None = None) -> None:
    args = ["--migrations-dir", str(directory), "--allow-destructive"]
    if target is not None:
        args += ["--target", target]
    args.append("up")
    rc = migrate.main(args)
    assert rc == 0, f"up returned {rc}"


def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------


def test_095_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "095_user_role.up.sql").read_text(encoding="utf-8")
    down_sql = (REAL_MIGRATIONS_DIR / "095_user_role.down.sql").read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — column + enum exist, default backfills pre-existing rows, re-driving
#    the body is a no-op.
# ---------------------------------------------------------------------------


def test_095_up_adds_role_defaulted_to_user(env, dsn: str, full_dir: pathlib.Path) -> None:
    # Seed a user BEFORE 095 runs, on the migration immediately prior, so the
    # backfill-via-DEFAULT behavior is actually exercised (not just a fresh
    # insert after the column already exists).
    pre_target = _pre_095_target(full_dir)
    _up(full_dir, target=pre_target)
    with psycopg.connect(dsn, autocommit=True) as conn:
        pre_user_id = _seed_user(conn, "pre-095@test.dev")

    _up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            # Enum type exists with exactly the two expected labels.
            cur.execute(
                """
                SELECT e.enumlabel
                  FROM pg_type t
                  JOIN pg_enum e ON e.enumtypid = t.oid
                 WHERE t.typname = 'user_role'
                 ORDER BY e.enumsortorder
                """
            )
            labels = [r[0] for r in cur.fetchall()]
            assert labels == ["user", "admin"]

            # Column exists, NOT NULL, default 'user'.
            cur.execute(
                """
                SELECT is_nullable, column_default
                  FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'role'
                """
            )
            row = cur.fetchone()
            assert row is not None, "users.role must exist after up"
            is_nullable, column_default = row
            assert is_nullable == "NO"
            assert column_default is not None and "user" in column_default

            # The pre-existing row was backfilled 'user' by the DEFAULT — not
            # left NULL, and NOT promoted to 'admin'.
            cur.execute("SELECT role::text FROM users WHERE id = %s", (pre_user_id,))
            assert cur.fetchone()[0] == "user"

        # Re-driving the up body directly (the runner skips an applied
        # version): CREATE TYPE guard + ADD COLUMN IF NOT EXISTS must both be
        # re-runnable.
        up_sql = (REAL_MIGRATIONS_DIR / "095_user_role.up.sql").read_text(encoding="utf-8")
        with conn.cursor() as cur:
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT role::text FROM users WHERE id = %s", (pre_user_id,))
            assert cur.fetchone()[0] == "user"

        # A fresh insert with no explicit role also defaults to 'user'.
        new_user_id = _seed_user(conn, "post-095@test.dev")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT role::text FROM users WHERE id = %s", (new_user_id,))
            assert cur.fetchone()[0] == "user"

        # An explicit 'admin' insert is accepted — the enum is usable both ways.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash, role) "
                "VALUES (%s, %s, 'admin') RETURNING role::text",
                ("admin-095@test.dev", FAKE_HASH),
            )
            assert cur.fetchone()[0] == "admin"

        # An out-of-set value is rejected by the enum's closed value set.
        with pytest.raises(errors.InvalidTextRepresentation):
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (email, password_hash, role) "
                    "VALUES (%s, %s, 'superadmin')",
                    ("bad-095@test.dev", FAKE_HASH),
                )


# ---------------------------------------------------------------------------
# 3. DOWN — destructive gate; column AND type gone, in order; re-up clean.
# ---------------------------------------------------------------------------


def test_095_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _up(full_dir)
    target = _pre_095_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        _seed_user(conn, "down-095@test.dev")

    # Refused without the flag (destructive marker on the down file).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", target, "down"])
    assert rc != 0, "095.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", target, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'role'
                """
            )
            assert cur.fetchone()[0] == 0, "users.role must be gone after down"
            cur.execute("SELECT count(*) FROM pg_type WHERE typname = 'user_role'")
            assert cur.fetchone()[0] == 0, "user_role enum must be gone after down"

    # Round trip: re-up rebuilds both cleanly.
    _up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM pg_type WHERE typname = 'user_role'")
            assert cur.fetchone()[0] == 1
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'role'
                """
            )
            assert cur.fetchone()[0] == 1
