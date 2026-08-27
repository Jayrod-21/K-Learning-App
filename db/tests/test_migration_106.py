"""Migration 106 (claude_route 'generate_paired_reading_item' +
'generate_paired_listening_item', F-220 P1) — real-chain tests.

WHY THIS FILE EXISTS:
    106 is a value-only ``ALTER TYPE claude_route ADD VALUE`` pair (mirroring
    031/032/053/055/057/102/104). Its entire contract is: after a full up, the
    enum accepts BOTH 'generate_paired_reading_item' and
    'generate_paired_listening_item' (so the proxy's claude_cache/claude_usage
    writes for the two new paired-item generators — F-220 P1 — succeed
    instead of failing with `invalid input value for enum claude_route`, the
    exact defect 031/032 fixed for earlier routes), and its down is a
    DOCUMENTED no-op (PG cannot drop enum values), so a rollback below 106
    leaves both values in place harmlessly and a re-up is clean (ADD VALUE IF
    NOT EXISTS).

SCOPE:
    - up: both values are present in the migrated enum AND usable as a cast +
      a claude_usage / claude_cache write from a separate transaction (values
      added in migrate.py's tx are only usable post-commit — proving the
      commit happened, exactly test_migration_104's shape).
    - down: rolling back below 106 leaves both values in the enum (no-op
      down, by design) and does not error; a subsequent full up re-applies
      cleanly.

DETERMINISM:
    Mirrors test_migration_104.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
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

# The migration immediately before 106. `down --target PRE_106` rolls back only
# 106's own no-op down (105 and everything below stays applied).
PRE_106 = "105"

NEW_VALUES = ["generate_paired_reading_item", "generate_paired_listening_item"]


def _enum_values(conn: psycopg.Connection) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e"
        )
        return {row[0] for row in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. UP — both values present AND usable post-commit (cast + claude_usage/cache write)
# ---------------------------------------------------------------------------


def test_106_up_adds_both_paired_item_routes(env, dsn: str, full_dir) -> None:
    """Full-chain up: both values are members of claude_route, and usable as
    a cast from a NEW connection/tx — ADD VALUE inside migrate.py's
    transaction is only usable after commit, so a successful cast here proves
    the migration committed the values."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values, f"claude_route is missing {v!r} after full up"

        with conn.cursor(row_factory=tuple_row) as cur:
            for v in NEW_VALUES:
                cur.execute("SELECT %s::claude_route::text", (v,))
                assert cur.fetchone()[0] == v


def test_106_up_enum_values_usable_for_cache_and_usage(env, dsn: str, full_dir) -> None:
    """Both new values must be WRITABLE to the claude tables post-commit —
    the exact failure mode 031/032 fixed for earlier routes (invalid input
    value for enum claude_route on every cache/usage write)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            for i, v in enumerate(NEW_VALUES):
                # A usage row — the proxy's per-call tracking write.
                cur.execute(
                    """
                    INSERT INTO claude_usage
                        (request_id, user_id, route, model, was_cache_hit,
                         input_tokens, output_tokens, latency_ms)
                    VALUES (%s, NULL, %s::claude_route,
                            'claude-sonnet-4-6', FALSE, 10, 5, 42)
                    RETURNING route::text
                    """,
                    (f"t-106-{i}", v),
                )
                assert cur.fetchone()[0] == v

                # A cache row — the proxy's Layer-B cache write. prompt_hash
                # must satisfy ck_claude_cache_hash_shape (64 lowercase hex
                # chars).
                cur.execute(
                    """
                    INSERT INTO claude_cache
                        (route, model, prompt_hash, response, expires_at)
                    VALUES (%s::claude_route, 'claude-sonnet-4-6',
                            %s, '{"questions": []}'::jsonb,
                            now() + interval '1 day')
                    RETURNING route::text
                    """,
                    (v, (f"{i}eefdead" * 8)[:64]),
                )
                assert cur.fetchone()[0] == v


def test_106_up_is_idempotent_on_reapply(env, dsn: str, full_dir) -> None:
    """ADD VALUE IF NOT EXISTS: a hand re-apply of 106's statements against
    the migrated DB does not error (the IF NOT EXISTS guard)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        for v in NEW_VALUES:
            cur.execute(f"ALTER TYPE claude_route ADD VALUE IF NOT EXISTS '{v}'")
    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values


# ---------------------------------------------------------------------------
# 2. DOWN — documented no-op; values persist harmlessly; re-up clean
# ---------------------------------------------------------------------------


def test_106_down_is_noop_and_reup_clean(env, dsn: str, full_dir) -> None:
    """Rolling back 106 alone succeeds (its no-op down), the enum values
    REMAIN (PG cannot drop enum values — 106's down documents this, same
    posture as 031/032/053/055/057/102/104's downs), and a subsequent full up
    re-applies cleanly."""
    _full_up(full_dir)

    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_106,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_106} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # The no-op down leaves both values in place — harmless if unused.
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values, (
                f"{v!r} vanished on down — 106's down must be a no-op "
                "(PG cannot drop enum values)"
            )

    # Re-up: IF NOT EXISTS makes 106 idempotent against the surviving values.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        values = _enum_values(conn)
        for v in NEW_VALUES:
            assert v in values
