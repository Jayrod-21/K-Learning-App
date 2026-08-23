"""Migration 079 (shared-corpus flag, F-207 phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    079 is the schema half of the shared-corpus model: an operator-set
    `is_shared BOOLEAN NOT NULL DEFAULT false` on `audio_sources` and
    `book_uploads` that opens READ access across accounts while every
    mutation path stays owner-only. The load-bearing behaviors are (a) the
    default — applying the migration over a populated DB must leave EVERY
    existing row private (is_shared = false), because a row that silently
    became shared would be a cross-account data exposure; and (b) the
    NOT NULL — a three-state flag (true/false/NULL) would reopen the exact
    NULL-propagation ambiguity the audio-span CHECK tests (078) exist to
    close, this time in an authorization predicate. These tests apply the
    REAL migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (DROP COLUMN — the
      shape the legacy sniff misses; F-088's point).
    - up: applies on the full real chain; both columns exist, boolean,
      NOT NULL, default false; re-driving the body is a no-op
      (ADD COLUMN IF NOT EXISTS).
    - populated-table upgrade: up to 078, seed a user + book + audio set,
      apply 079 over them — every pre-existing row survives and reads
      is_shared = false (nothing becomes shared by migrating).
    - default on INSERT: a post-079 INSERT that never mentions the column
      lands false (new uploads are private); an explicit true write (the
      phase-2 cutover script's shape — keyed UPDATE) sticks.
    - down: refused without --allow-destructive; with it, both columns are
      gone, the underlying rows survive (only the flag is lossy — the
      idempotent cutover script re-establishes it), and re-up restores the
      columns at their default.

DETERMINISM:
    Mirrors test_migration_078.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import FAKE_HASH, _full_up  # type: ignore[import-not-found]

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

# The migration immediately before 079. `down --target PRE_079` rolls back
# ONLY 079 (its DROP COLUMN down is what requires --allow-destructive).
PRE_079 = "078"

TABLES = ("audio_sources", "book_uploads")


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            ("f207-owner@example.com", FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_book_upload(conn: psycopg.Connection, user_id: int) -> int:
    # Post-041 shape: blob_ref lives on book_pages now, byte_size is the
    # original upload's size (073's test seeds the same columns).
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, 'Folktales (book)', 'literature'::book_upload_type,
                    'ready'::book_upload_status, 1024)
            RETURNING id
            """,
            (user_id,),
        )
        return cur.fetchone()[0]


def _seed_audio_source(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO audio_sources (user_id, slug, title, kind,
                                       source_upload_id, status)
            VALUES (%s, 'korean-folktales', 'Korean Folktales',
                    'standalone_listening', NULL, 'ready')
            RETURNING id
            """,
            (user_id,),
        )
        return cur.fetchone()[0]


def _column_shape(
    conn: psycopg.Connection, table: str, column: str
) -> tuple[str, str, str | None] | None:
    """(data_type, is_nullable, column_default) or None if absent."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s AND column_name=%s
            """,
            (table, column),
        )
        row = cur.fetchone()
        return (row[0], row[1], row[2]) if row is not None else None


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_079_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "079_audio_shared_flag.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "079_audio_shared_flag.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's data drop is a DROP COLUMN — the exact shape the legacy
    # keyword-sniff misses, so the explicit marker must carry it.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shape (boolean, NOT NULL, default false) on BOTH tables; body
#    re-runnable.
# ---------------------------------------------------------------------------

def test_079_up_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "079_audio_shared_flag.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            shape = _column_shape(conn, table, "is_shared")
            assert shape is not None, f"{table}.is_shared missing"
            data_type, is_nullable, default = shape
            assert data_type == "boolean", f"{table}.is_shared: {data_type}"
            # NOT NULL is load-bearing: a NULL flag in an authorization
            # predicate is a three-state bug waiting to happen.
            assert is_nullable == "NO", f"{table}.is_shared must be NOT NULL"
            assert default == "false", (
                f"{table}.is_shared default must be false (private), got {default!r}"
            )

        # Drive the body a second time directly (the runner skips an applied
        # version): ADD COLUMN IF NOT EXISTS must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        for table in TABLES:
            assert _column_shape(conn, table, "is_shared") == (
                "boolean", "NO", "false",
            )


# ---------------------------------------------------------------------------
# 3. UP over POPULATED tables — the real upgrade path AND the security
#    property: km-db holds Jared's real sets/books before 079 lands, and
#    every one of them must come out PRIVATE (is_shared = false). A row that
#    silently became shared here would be a cross-account exposure.
# ---------------------------------------------------------------------------

def test_079_up_over_populated_tables_leaves_every_row_private(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    # Stop the chain at 078 — audio_sources/book_uploads still pre-079.
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_079,
         "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {PRE_079} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            assert _column_shape(conn, table, "is_shared") is None
        user_id = _seed_user(conn)
        upload_id = _seed_book_upload(conn, user_id)
        source_id = _seed_audio_source(conn, user_id)

    # Apply 079 OVER the populated tables.
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT is_shared, user_id FROM book_uploads WHERE id = %s",
                (upload_id,),
            )
            row = cur.fetchone()
            assert row is not None, "the book row must survive the widen"
            assert row[0] is False, "a pre-079 book must stay PRIVATE"
            assert row[1] == user_id, "the owner must be untouched (never re-owned)"

            cur.execute(
                "SELECT is_shared, user_id FROM audio_sources WHERE id = %s",
                (source_id,),
            )
            row = cur.fetchone()
            assert row is not None, "the audio-set row must survive the widen"
            assert row[0] is False, "a pre-079 set must stay PRIVATE"
            assert row[1] == user_id, "the owner must be untouched (never re-owned)"


# ---------------------------------------------------------------------------
# 4. Post-079 writes — new rows default private; the cutover script's keyed
#    UPDATE shape sticks; NOT NULL rejects a NULL flag.
# ---------------------------------------------------------------------------

def test_079_insert_defaults_private_and_cutover_update_sticks(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        source_id = _seed_audio_source(conn, user_id)
        upload_id = _seed_book_upload(conn, user_id)

        with conn.cursor(row_factory=tuple_row) as cur:
            # INSERTs above never mentioned is_shared — both land false.
            cur.execute(
                "SELECT is_shared FROM audio_sources WHERE id = %s", (source_id,)
            )
            assert cur.fetchone()[0] is False
            cur.execute(
                "SELECT is_shared FROM book_uploads WHERE id = %s", (upload_id,)
            )
            assert cur.fetchone()[0] is False

            # The phase-2 cutover shape: an operator keyed UPDATE to true.
            cur.execute(
                "UPDATE audio_sources SET is_shared = true WHERE id = %s",
                (source_id,),
            )
            cur.execute(
                "SELECT is_shared FROM audio_sources WHERE id = %s", (source_id,)
            )
            assert cur.fetchone()[0] is True

            # NOT NULL holds: the three-state flag is impossible at rest.
            with pytest.raises(psycopg.errors.NotNullViolation):
                cur.execute(
                    "UPDATE audio_sources SET is_shared = NULL WHERE id = %s",
                    (source_id,),
                )


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; both columns gone, rows survive; re-up clean.
# ---------------------------------------------------------------------------

def test_079_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        source_id = _seed_audio_source(conn, user_id)
        upload_id = _seed_book_upload(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE audio_sources SET is_shared = true WHERE id = %s",
                (source_id,),
            )

    # Refused without the flag (DROP COLUMN + explicit marker).
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_079, "down"])
    assert rc != 0, "079.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_079,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_079} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            assert _column_shape(conn, table, "is_shared") is None
        # Lossy on the FLAG only: the set and book rows survive — the
        # idempotent phase-2 cutover script re-establishes the flags after a
        # re-up (035/078's posture, with operator booleans instead of corpus
        # files as the system of record).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT user_id FROM audio_sources WHERE id = %s", (source_id,)
            )
            row = cur.fetchone()
            assert row is not None, "audio-set rows must survive the rollback"
            assert row[0] == user_id
            cur.execute(
                "SELECT user_id FROM book_uploads WHERE id = %s", (upload_id,)
            )
            row = cur.fetchone()
            assert row is not None, "book rows must survive the rollback"
            assert row[0] == user_id

    # Round trip: re-up restores both columns at their private default —
    # including on the row that was shared before the rollback.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            assert _column_shape(conn, table, "is_shared") == (
                "boolean", "NO", "false",
            )
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT is_shared FROM audio_sources WHERE id = %s", (source_id,)
            )
            assert cur.fetchone()[0] is False, (
                "after down+up the previously-shared set must be PRIVATE again "
                "until the cutover script re-flags it"
            )
