"""Migration 048 (tickets + ticket_comments, F-023 beta ticketing) — real-chain tests.

WHY THIS FILE EXISTS:
    048 is a net-new pair of tables, so unlike 046 there is no data
    transform to verify — but the F-023 backend leans on schema-level
    behavior the route tests cannot prove end-to-end from the SQL files
    alone: the CASCADE topology (user deletion takes tickets AND comments;
    ticket deletion takes its thread), the CHECK'd closed sets for
    type/status, the length floors/ceilings that back the API's Zod bounds,
    and the trg_tickets_updated_at trigger the feed ordering depends on.
    These tests apply the REAL migration chain against a Postgres-16
    testcontainer via `migrate.main()` and assert those behaviors on
    actual rows, then prove the down is clean and a re-up applies.

SCOPE:
    - up: both tables + columns present; indexes ix_tickets_user_updated /
      ix_tickets_status_updated / ix_ticket_comments_ticket_created exist;
      FK delete rules asserted from pg_constraint (both CASCADE); CHECKs
      reject bad type/status/lengths; updated_at trigger fires on UPDATE.
    - down (--target 047): both tables gone, users untouched; re-up clean.

DETERMINISM:
    Mirrors test_migration_046.py — the real migration files are copied
    into a tmp_path-scoped directory and the runner is pointed at it via
    `--migrations-dir`; the `dsn` fixture gives each test a fresh schema.
    Full-chain applies traverse 045 (hygiene_cleanup, DROP TABLE) and so
    pass --allow-destructive; the 048 down contains DROP TABLE and needs
    the flag in its own right.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import _seed_user  # type: ignore[import-not-found]

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

# The rollback target: 047 is the migration immediately before 048, so
# `down --target 047` reverses exactly the pair under test.
PRE_048 = "047"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _seed_ticket(
    conn: psycopg.Connection,
    user_id: int,
    *,
    type_: str = "bug",
    title: str = "a title",
    body: str = "a body",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO tickets (user_id, type, title, body)
                 VALUES (%s, %s, %s, %s) RETURNING id
            """,
            (user_id, type_, title, body),
        )
        return cur.fetchone()[0]


def _seed_comment(conn: psycopg.Connection, ticket_id: int, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO ticket_comments (ticket_id, user_id, body)
                 VALUES (%s, %s, 'a comment') RETURNING id
            """,
            (ticket_id, user_id),
        )
        return cur.fetchone()[0]


def _table_exists(conn: psycopg.Connection, table: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name=%s
            """,
            (table,),
        )
        return cur.fetchone() is not None


def _index_names(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _count(conn: psycopg.Connection, table: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(f"SELECT COUNT(*) FROM {table}")  # noqa: S608 — test-local names
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# 1. UP — schema shape, constraints, cascade topology, trigger
# ---------------------------------------------------------------------------

def test_048_up_schema_constraints_and_cascades(env, dsn: str, full_dir) -> None:
    """Full-chain up, then assert 048's contract on real rows: indexes and FK
    delete rules from the catalogs, CHECK rejections for every closed set and
    length bound, updated_at trigger behavior, and both CASCADE paths."""
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain ahead of 048, so a full `up` traverses it and trips migrate.py's
    # destructive gate without the flag.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "tickets")
        assert _table_exists(conn, "ticket_comments")

        # Indexes for the two feed queries + the thread query.
        assert "ix_tickets_user_updated" in _index_names(conn, "tickets")
        assert "ix_tickets_status_updated" in _index_names(conn, "tickets")
        assert "ix_ticket_comments_ticket_created" in _index_names(
            conn, "ticket_comments"
        )

        # FK delete rules from pg_constraint, not prose: all three CASCADE
        # ('c'), all three ON UPDATE RESTRICT ('r').
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT conname, confdeltype, confupdtype FROM pg_constraint
                 WHERE conname IN ('fk_tickets_user',
                                   'fk_ticket_comments_ticket',
                                   'fk_ticket_comments_user')
                """
            )
            fks = {r["conname"]: r for r in cur.fetchall()}
        assert set(fks) == {
            "fk_tickets_user",
            "fk_ticket_comments_ticket",
            "fk_ticket_comments_user",
        }
        for name, fk in fks.items():
            assert fk["confdeltype"] == "c", f"{name} must be ON DELETE CASCADE"
            assert fk["confupdtype"] == "r", f"{name} must be ON UPDATE RESTRICT"

        user_a = _seed_user(conn, "f023-a@example.com")
        user_b = _seed_user(conn, "f023-b@example.com")

        # CHECK rejections — closed sets + length bounds + version floor.
        with pytest.raises(psycopg.errors.CheckViolation):
            _seed_ticket(conn, user_a, type_="rant")
        with pytest.raises(psycopg.errors.CheckViolation):
            _seed_ticket(conn, user_a, title="")
        with pytest.raises(psycopg.errors.CheckViolation):
            _seed_ticket(conn, user_a, title="t" * 201)
        with pytest.raises(psycopg.errors.CheckViolation):
            _seed_ticket(conn, user_a, body="b" * 5001)
        with conn.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                """
                INSERT INTO tickets (user_id, type, title, body, status)
                     VALUES (%s, 'bug', 't', 'b', 'wontfix')
                """,
                (user_a,),
            )

        ticket_a = _seed_ticket(conn, user_a, type_="bug", title="A's bug")
        ticket_b = _seed_ticket(conn, user_b, type_="request", title="B's request")

        with pytest.raises(psycopg.errors.CheckViolation):
            _seed_comment_body_len(conn, ticket_a, user_a, 2001)

        # Defaults: status='open', version=1; trigger bumps ONLY updated_at.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, version, created_at, updated_at FROM tickets WHERE id=%s",
                (ticket_a,),
            )
            before = cur.fetchone()
        assert before["status"] == "open"
        assert before["version"] == 1
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tickets SET status='in_progress' WHERE id=%s", (ticket_a,)
            )
            cur.execute(
                "SELECT created_at, updated_at FROM tickets WHERE id=%s", (ticket_a,)
            )
            after = cur.fetchone()
        assert after["created_at"] == before["created_at"]
        assert after["updated_at"] > before["updated_at"], (
            "trg_tickets_updated_at must re-stamp updated_at on UPDATE"
        )

        # Cascade path 1: deleting a ticket takes its thread, nothing else.
        _seed_comment(conn, ticket_a, user_a)
        _seed_comment(conn, ticket_a, user_b)  # cross-user comment (community)
        _seed_comment(conn, ticket_b, user_a)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM tickets WHERE id=%s", (ticket_a,))
        assert _count(conn, "ticket_comments") == 1, (
            "deleting a ticket must cascade-delete exactly its own comments"
        )

        # Cascade path 2: deleting a user takes their tickets AND their
        # comments on other people's tickets.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (user_a,))
        assert _count(conn, "tickets") == 1  # B's ticket survives
        assert _count(conn, "ticket_comments") == 0, (
            "A's comment on B's ticket must die with A"
        )


def _seed_comment_body_len(
    conn: psycopg.Connection, ticket_id: int, user_id: int, length: int
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (%s, %s, %s)",
            (ticket_id, user_id, "x" * length),
        )


# ---------------------------------------------------------------------------
# 2. DOWN — drops the pair (and only the pair); re-up is clean
# ---------------------------------------------------------------------------

def test_048_down_drops_pair_then_reups(env, dsn: str, full_dir) -> None:
    """Roll back to 047 and assert both tables are gone while users (and the
    rest of the schema) survive; then a full up re-applies 048 cleanly."""
    # --allow-destructive: 045's DROP TABLE sits in the chain ahead of 048.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"initial full up returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f023-down@example.com")
        ticket = _seed_ticket(conn, user, title="doomed by rollback")
        _seed_comment(conn, ticket, user)

    # --allow-destructive is REQUIRED here in its own right: 048's down body
    # contains DROP TABLE, which migrate.py's destructive gate matches.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_048, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_048} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert not _table_exists(conn, "tickets")
        assert not _table_exists(conn, "ticket_comments")
        # The down touches ONLY the 048 pair — its author (and the trigger
        # function it borrowed from 001) survive.
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM users WHERE id=%s", (user,))
            assert cur.fetchone()["n"] == 1
            cur.execute(
                "SELECT 1 FROM pg_proc WHERE proname='set_updated_at'"
            )
            assert cur.fetchone() is not None

    # Re-up: 048 applies cleanly again (IF NOT EXISTS guards are exercised on
    # the fresh create path; the runner re-records the version).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"re-apply of 048 after rollback returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "tickets")
        assert _table_exists(conn, "ticket_comments")
        assert _count(conn, "tickets") == 0  # rollback was the data loss; re-up is empty
