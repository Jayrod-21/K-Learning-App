"""Migration 058 (tickets.source_page, F-127) — real-chain tests.

WHY THIS FILE EXISTS:
    058 adds ONE nullable TEXT column with a 1..200-char CHECK to `tickets`
    (installed by 048), the same "add-only expand" shape as 055's
    conversations.title. These tests apply the REAL migration chain against
    a Postgres-16 testcontainer via ``migrate.main()`` and prove: the column
    shape, the CHECK boundaries (empty / 200 / 201 chars, NULL exempt),
    pre-058 rows' back-compat, and the down/re-up cycle (column + CHECK
    gone, then cleanly restored).

DETERMINISM:
    Mirrors test_migration_055.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user, _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 058 in the chain. 058's own down is
# DROP COLUMN, which does not itself trip the destructive gate — but the
# chain has since grown 059/060/061 above 058 (each a destructive DROP TABLE
# down), and `down --target` rolls back everything strictly above the
# target, so this invocation now requires --allow-destructive too (see the
# down test below).
PRE_058 = "057"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _seed_ticket(
    conn: psycopg.Connection, user_id: int, source_id: str, source_page: str | None = None
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO tickets (user_id, type, title, body, source_page)
            VALUES (%s, 'bug', %s, 'seed body', %s)
            RETURNING id
            """,
            (user_id, source_id, source_page),
        )
        return cur.fetchone()[0]


def _column_info(conn: psycopg.Connection, table: str, column: str):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = %s AND column_name = %s
            """,
            (table, column),
        )
        return cur.fetchone()


def _constraint_exists(conn: psycopg.Connection, conname: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_constraint WHERE conname = %s",
            (conname,),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — column shape, CHECK boundaries, back-compat
# ---------------------------------------------------------------------------

def test_058_up_schema_shape(env, dsn: str, full_dir) -> None:
    """source_page column (TEXT NULL, no default) and its CHECK."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        col = _column_info(conn, "tickets", "source_page")
        assert col is not None, "tickets.source_page missing after 058"
        assert col["data_type"] == "text"
        assert col["is_nullable"] == "YES"
        assert col["column_default"] is None
        assert _constraint_exists(conn, "ck_tickets_source_page_length")


def test_058_up_lifecycle_and_check_boundaries(env, dsn: str, full_dir) -> None:
    """A fresh ticket (pre-058 insert shape) has NULL source_page; valid
    paths store; the CHECK rejects an empty string and one over 200 chars,
    and accepts exactly 200. NULL stays exempt (unset-context tickets)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f127@example.com")

        with conn.cursor(row_factory=tuple_row) as cur:
            # Back-compat: a ticket filed without page context is NULL.
            no_ctx_id = _seed_ticket(conn, user, "058-no-context")
            cur.execute(
                "SELECT source_page FROM tickets WHERE id = %s", (no_ctx_id,)
            )
            assert cur.fetchone()[0] is None

            # A real app pathname stores and reads back.
            with_ctx_id = _seed_ticket(
                conn, user, "058-with-context", "/learn/writing"
            )
            cur.execute(
                "SELECT source_page FROM tickets WHERE id = %s", (with_ctx_id,)
            )
            assert cur.fetchone()[0] == "/learn/writing"

            # Exactly 200 chars is legal (boundary inclusive).
            cur.execute(
                "UPDATE tickets SET source_page = %s WHERE id = %s",
                ("/" + "a" * 199, with_ctx_id),
            )

            # Back to NULL is legal — NULL is exempt from the CHECK.
            cur.execute(
                "UPDATE tickets SET source_page = NULL WHERE id = %s", (with_ctx_id,)
            )

        # Empty string → CHECK violation (empty is NOT the same as unset).
        with pytest.raises(errors.CheckViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE tickets SET source_page = '' WHERE id = %s",
                    (with_ctx_id,),
                )
        assert exc.value.diag.constraint_name == "ck_tickets_source_page_length"

    with psycopg.connect(dsn, autocommit=True) as conn:
        # 201 chars → CHECK violation.
        with pytest.raises(errors.CheckViolation) as exc:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE tickets SET source_page = %s WHERE id = %s",
                    ("/" + "a" * 200, with_ctx_id),
                )
        assert exc.value.diag.constraint_name == "ck_tickets_source_page_length"


def test_058_reapply_is_idempotent(env, dsn: str, full_dir) -> None:
    """Re-running the 058 body against an applied DB is a no-op (IF NOT
    EXISTS + guarded CHECK) — the house idempotence bar."""
    _full_up(full_dir)
    body = (REAL_MIGRATIONS_DIR / "058_ticket_source_page.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(body)  # must not raise
        col = _column_info(conn, "tickets", "source_page")
        assert col is not None
        assert _constraint_exists(conn, "ck_tickets_source_page_length")


# ---------------------------------------------------------------------------
# 2. DOWN — column + CHECK gone, ticket row survives, clean re-up
# ---------------------------------------------------------------------------

def test_058_down_drops_column_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    # Live data proves the down works on a non-empty, source_page-carrying table.
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f127-down@example.com")
        ticket_id = _seed_ticket(conn, user, "058-down-test", "/learn/writing")

    # 058's own down is DROP COLUMN — not covered by the destructive gate
    # (DROP TABLE/SCHEMA/DATABASE/TRUNCATE) in isolation. But the chain has
    # since grown 059/060/061 above 058, each a destructive DROP TABLE down,
    # and `down --target` rolls back everything strictly above the target —
    # so --allow-destructive is now required for this invocation to reach
    # 058's own down at all. This no longer doubles as a pure classification
    # probe on 058's own down body (which is still just DROP COLUMN); it's
    # now also traversing 059/060/061's destructive downs to get there.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_058,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_058} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_info(conn, "tickets", "source_page") is None
        assert not _constraint_exists(conn, "ck_tickets_source_page_length")
        # The ticket row itself survives (only the column is lossy).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT title FROM tickets WHERE id = %s", (ticket_id,))
            assert cur.fetchone()[0] == "058-down-test"

    # Re-up: 058 applies cleanly again (the column + CHECK come back).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        col = _column_info(conn, "tickets", "source_page")
        assert col is not None and col["is_nullable"] == "YES"
        assert _constraint_exists(conn, "ck_tickets_source_page_length")
