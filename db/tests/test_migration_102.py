"""Migration 102 (claude_route 'generate_reading_item', F-220 slice 2) — real-chain tests.

WHY THIS FILE EXISTS:
    102 is a value-only ``ALTER TYPE claude_route ADD VALUE`` (mirroring
    031/032/053/055/057). Its entire contract is: after a full up, the enum
    accepts 'generate_reading_item' (so the proxy's claude_cache/claude_usage
    writes for the new reading-item generator — F-220 slice 2 — succeed instead
    of failing with `invalid input value for enum claude_route`, the exact
    defect 031/032 fixed for earlier routes), and its down is a DOCUMENTED
    no-op (PG cannot drop enum values), so a rollback below 102 leaves the
    value in place harmlessly and a re-up is clean (ADD VALUE IF NOT EXISTS).

SCOPE:
    - up: the value is present in the migrated enum AND usable as a cast +
      a claude_usage / claude_cache write from a separate transaction (values
      added in migrate.py's tx are only usable post-commit — proving the
      commit happened, exactly test_migration_053/055/057's shape).
    - down: rolling back below 102 leaves the value in the enum (no-op down,
      by design) and does not error; a subsequent full up re-applies cleanly.

DETERMINISM:
    Mirrors test_migration_057.py — the real migration files are copied into a
    tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 102. `down --target PRE_102` rolls back only
# 102's own no-op down (101 and everything below stays applied).
PRE_102 = "101"

NEW_VALUE = "generate_reading_item"


def _enum_values(conn: psycopg.Connection) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e"
        )
        return {row[0] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. UP — value present AND usable post-commit (cast + claude_usage/cache write)
# ---------------------------------------------------------------------------

def test_102_up_adds_generate_reading_item(env, dsn: str, full_dir) -> None:
    """Full-chain up: the value is a member of claude_route, and usable as a
    cast from a NEW connection/tx — ADD VALUE inside migrate.py's transaction
    is only usable after commit, so a successful cast here proves the
    migration committed the value."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        assert NEW_VALUE in values, f"claude_route is missing {NEW_VALUE!r} after full up"

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT %s::claude_route::text", (NEW_VALUE,))
            assert cur.fetchone()[0] == NEW_VALUE


def test_102_up_enum_value_usable_for_cache_and_usage(env, dsn: str, full_dir) -> None:
    """'generate_reading_item' must be WRITABLE to the claude tables post-commit
    — the exact failure mode 031/032 fixed for earlier routes (invalid input
    value for enum claude_route on every cache/usage write)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            # A usage row — the proxy's per-call tracking write.
            cur.execute(
                """
                INSERT INTO claude_usage
                    (request_id, user_id, route, model, was_cache_hit,
                     input_tokens, output_tokens, latency_ms)
                VALUES ('t-102', NULL, 'generate_reading_item'::claude_route,
                        'claude-sonnet-4-6', FALSE, 10, 5, 42)
                RETURNING route::text
                """,
            )
            assert cur.fetchone()[0] == "generate_reading_item"

            # A cache row — the proxy's Layer-B cache write. prompt_hash must
            # satisfy ck_claude_cache_hash_shape (64 lowercase hex chars).
            cur.execute(
                """
                INSERT INTO claude_cache
                    (route, model, prompt_hash, response, expires_at)
                VALUES ('generate_reading_item'::claude_route, 'claude-sonnet-4-6',
                        %s, '{"passage": "mock"}'::jsonb,
                        now() + interval '1 day')
                RETURNING route::text
                """,
                ("deadbeef" * 8,),
            )
            assert cur.fetchone()[0] == "generate_reading_item"


def test_102_up_is_idempotent_on_reapply(env, dsn: str, full_dir) -> None:
    """ADD VALUE IF NOT EXISTS: a hand re-apply of 102's statement against the
    migrated DB does not error (the IF NOT EXISTS guard)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(f"ALTER TYPE claude_route ADD VALUE IF NOT EXISTS '{NEW_VALUE}'")
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert NEW_VALUE in _enum_values(conn)


# ---------------------------------------------------------------------------
# 2. DOWN — documented no-op; value persists harmlessly; re-up clean
# ---------------------------------------------------------------------------

def test_102_down_is_noop_and_reup_clean(env, dsn: str, full_dir) -> None:
    """Rolling back 102 alone succeeds (its no-op down), the enum value
    REMAINS (PG cannot drop enum values — 102's down documents this, same
    posture as 031/032/053/055/057), and a subsequent full up re-applies
    cleanly."""
    _full_up(full_dir)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_102,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_102} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # The no-op down leaves the value in place — harmless if unused.
        values = _enum_values(conn)
        assert NEW_VALUE in values, (
            f"{NEW_VALUE!r} vanished on down — 102's down must be a no-op "
            "(PG cannot drop enum values)"
        )

    # Re-up: IF NOT EXISTS makes 102 idempotent against the surviving value.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert NEW_VALUE in _enum_values(conn)
