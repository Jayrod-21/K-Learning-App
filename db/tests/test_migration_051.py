"""Migration 051 (reading_positions, ticket F-069) — real-chain tests.

WHY THIS FILE EXISTS:
    051's value is almost entirely in its CONSTRAINT TOPOLOGY: the composite
    owner-guard FK (source_upload_id, user_id) -> book_uploads(id, user_id)
    (the migration-044 pattern) that makes a cross-user position row
    structurally impossible, the composite chapter FK with the PG-15+
    column-list ``ON DELETE SET NULL (chapter_id)``, and the CHECKs that
    forbid an empty or chapter-less-passage position. The synthetic harness
    tests (test_migrations.py) never see the real file; these tests apply the
    REAL migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()`` and PROVE each guard by attempting the write it must
    reject.

SCOPE:
    - up: table + PK shape; the owner-guard FK REJECTS attaching a position
      to a foreign upload; the chapter FK REJECTS a chapter of a different
      book; deleting a chapter NULLs only chapter_id (row survives on its
      page fallback) — INCLUDING the chapter-only degradation case that is
      the reason the semantic "points somewhere" invariant must NOT be a
      table CHECK (Postgres re-checks CHECKs on the referential-action
      UPDATE, which would abort the chapter DELETE); deleting the upload
      cascades the position away; positivity CHECKs; updated_at trigger.
    - down: reading_positions dropped, reading_chapters restored to its 044
      shape (uq_reading_chapters_id_upload gone, table intact); re-up clean.

DETERMINISM:
    Mirrors test_migration_046.py — the real migration files are copied into
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

# The migration immediately before 051 in the merged Group-2 chain
# (050_hanja_cards). `down --target PRE_051` rolls back 052 then 051 —
# nothing below — so the 051 assertions stay focused. (052's DROP TABLE down
# is what makes the descent require --allow-destructive; 051's own down is
# gated in its own right too.)
PRE_051 = "050"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _seed_upload(conn: psycopg.Connection, user_id: int, title: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, %s, 'literature'::book_upload_type,
                    'ready'::book_upload_status, 1024)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _seed_chapter(
    conn: psycopg.Connection, user_id: int, upload_id: int, number: int = 1
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_chapters
                (source_upload_id, user_id, chapter_number, title)
            VALUES (%s, %s, %s, 'Chapter')
            RETURNING id
            """,
            (upload_id, user_id, number),
        )
        return cur.fetchone()[0]


def _insert_position(
    conn: psycopg.Connection,
    user_id: int,
    upload_id: int,
    chapter_id: int | None = None,
    passage_number: int | None = None,
    page_number: int | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO reading_positions
                (user_id, source_upload_id, chapter_id, passage_number, page_number)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (user_id, upload_id, chapter_id, passage_number, page_number),
        )


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


def _constraint_exists(conn: psycopg.Connection, conname: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_constraint WHERE conname = %s", (conname,)
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — schema shape + every guard proven by the write it must reject
# ---------------------------------------------------------------------------

def test_051_up_schema_shape(env, dsn: str, full_dir) -> None:
    """Full-chain up: the table exists with the (user_id, source_upload_id)
    PK, the owner-guard composite FK targets book_uploads(id, user_id) with
    CASCADE, the chapter FK is the PG-15+ column-list SET NULL (only
    chapter_id in confdelsetcols), and the backing UNIQUEs exist."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "reading_positions")
        assert _constraint_exists(conn, "uq_reading_chapters_id_upload"), (
            "051 must add UNIQUE(id, source_upload_id) on reading_chapters "
            "to back the composite chapter FK"
        )

        with conn.cursor() as cur:
            # PK = (user_id, source_upload_id) — one position per (user, book).
            cur.execute(
                """
                SELECT array_agg(a.attname ORDER BY k.ord) AS cols
                  FROM pg_constraint c
                  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                       ON TRUE
                  JOIN pg_attribute a
                       ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                 WHERE c.conname = 'pk_reading_positions' AND c.contype = 'p'
                """
            )
            row = cur.fetchone()
            assert row is not None and row["cols"] == [
                "user_id",
                "source_upload_id",
            ], f"unexpected PK columns: {row}"

            # Owner guard: composite FK -> book_uploads, ON DELETE CASCADE.
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target,
                       confdeltype, confupdtype
                  FROM pg_constraint
                 WHERE conname = 'fk_reading_positions_upload_owner'
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "owner-guard FK missing"
            assert fk["target"] == "book_uploads"
            assert fk["confdeltype"] == "c", "owner-guard FK must CASCADE"
            assert fk["confupdtype"] == "r", "owner-guard FK must be ON UPDATE RESTRICT"

            # Chapter FK: column-list SET NULL — confdelsetcols must name
            # EXACTLY chapter_id (plain SET NULL would also try to null the
            # NOT NULL PK member source_upload_id and break on delete).
            cur.execute(
                """
                SELECT confdeltype,
                       (SELECT array_agg(a.attname)
                          FROM pg_attribute a
                         WHERE a.attrelid = c.conrelid
                           AND a.attnum = ANY (c.confdelsetcols)) AS setcols
                  FROM pg_constraint c
                 WHERE c.conname = 'fk_reading_positions_chapter_of_upload'
                """
            )
            ch = cur.fetchone()
            assert ch is not None, "chapter FK missing"
            assert ch["confdeltype"] == "n", "chapter FK must be ON DELETE SET NULL"
            assert ch["setcols"] == ["chapter_id"], (
                f"SET NULL must target only chapter_id; got {ch['setcols']}"
            )


def test_051_up_owner_guard_rejects_foreign_upload(env, dsn: str, full_dir) -> None:
    """THE F-069 security property: a position row naming user B against
    user A's upload violates the composite FK — the DB itself refuses the
    cross-user attach, independent of any route-level filter."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_a = _seed_user(conn, "f069-owner@example.com")
        user_b = _seed_user(conn, "f069-attacker@example.com")
        upload_a = _seed_upload(conn, user_a, "A's book")

        # The owner's own write is fine.
        _insert_position(conn, user_a, upload_a, page_number=3)

        # user B + user A's upload: both FK halves exist individually
        # (user_b in users, upload_a in book_uploads) — ONLY the composite
        # (id, user_id) pairing check can reject this.
        with pytest.raises(errors.ForeignKeyViolation):
            _insert_position(conn, user_b, upload_a, page_number=1)


def test_051_up_row_lifecycle_and_checks(env, dsn: str, full_dir) -> None:
    """Chapter-scoped integrity + lifecycle: a chapter of a different book is
    rejected; one row per (user, book); deleting the chapter NULLs only
    chapter_id (row survives, both for a page-fallback row AND for the
    chapter-only degradation case); deleting the upload cascades the row
    away; positivity CHECKs hold; updated_at bumps."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f069-lifecycle@example.com")
        book_a = _seed_upload(conn, user, "book A")
        book_b = _seed_upload(conn, user, "book B")
        chapter_a = _seed_chapter(conn, user, book_a)

        # A chapter of book A cannot be pinned to a position on book B, even
        # for the SAME user — the composite chapter FK pairs (chapter_id,
        # source_upload_id).
        with pytest.raises(errors.ForeignKeyViolation):
            _insert_position(conn, user, book_b, chapter_id=chapter_a, page_number=1)

        # Positivity CHECKs (the only CHECKs 051 carries on the pointers —
        # the semantic invariants are API-side by design; see the up header).
        with pytest.raises(errors.CheckViolation):
            _insert_position(conn, user, book_a, page_number=0)
        with pytest.raises(errors.CheckViolation):
            _insert_position(
                conn, user, book_a, chapter_id=chapter_a, passage_number=-3
            )

        _insert_position(
            conn, user, book_a, chapter_id=chapter_a, passage_number=4, page_number=17
        )

        # One row per (user, book): a second insert hits the PK.
        with pytest.raises(errors.UniqueViolation):
            _insert_position(conn, user, book_a, page_number=1)

        # updated_at trigger fires on UPDATE (the upsert's DO UPDATE arm).
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM reading_positions WHERE source_upload_id = %s",
                (book_a,),
            )
            before = cur.fetchone()["updated_at"]
            cur.execute(
                """
                UPDATE reading_positions SET passage_number = 5
                 WHERE user_id = %s AND source_upload_id = %s
                """,
                (user, book_a),
            )
            cur.execute(
                "SELECT updated_at FROM reading_positions WHERE source_upload_id = %s",
                (book_a,),
            )
            after = cur.fetchone()["updated_at"]
        assert after > before, "set_updated_at trigger must bump updated_at"

        # Book re-load semantics: deleting the chapter clears ONLY the
        # chapter pointer; the position row survives on its page fallback.
        # (passage_number lingers too — SET NULL touches only chapter_id;
        # it's advisory and the API/reader ignore it without a chapter.)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM reading_chapters WHERE id = %s", (chapter_a,))
            cur.execute(
                """
                SELECT chapter_id, passage_number, page_number
                  FROM reading_positions
                 WHERE user_id = %s AND source_upload_id = %s
                """,
                (user, book_a),
            )
            row = cur.fetchone()
        assert row is not None, "position must SURVIVE its chapter's deletion"
        assert row["chapter_id"] is None
        assert row["page_number"] == 17

        # THE reason the "points somewhere" invariant is not a table CHECK:
        # a CHAPTER-ONLY position (no page fallback) must also survive its
        # chapter's deletion, degrading to all-NULL pointers. With such a
        # CHECK in place, Postgres would re-check it on the FK's SET NULL
        # update and ABORT the chapter DELETE (23514) — breaking book
        # re-load. Prove the delete succeeds and the degraded row remains.
        chapter_b = _seed_chapter(conn, user, book_b)
        _insert_position(conn, user, book_b, chapter_id=chapter_b, passage_number=2)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM reading_chapters WHERE id = %s", (chapter_b,))
            cur.execute(
                """
                SELECT chapter_id, page_number FROM reading_positions
                 WHERE user_id = %s AND source_upload_id = %s
                """,
                (user, book_b),
            )
            degraded = cur.fetchone()
        assert degraded is not None, (
            "a chapter-only position must survive its chapter's deletion "
            "(degraded, not dropped)"
        )
        assert degraded["chapter_id"] is None and degraded["page_number"] is None

        # Deleting the book cascades the position away (owner-guard FK rides
        # the CASCADE).
        with conn.cursor() as cur:
            cur.execute("DELETE FROM book_uploads WHERE id = %s", (book_a,))
            cur.execute(
                "SELECT 1 FROM reading_positions WHERE source_upload_id = %s",
                (book_a,),
            )
            assert cur.fetchone() is None, "position must CASCADE with its upload"


# ---------------------------------------------------------------------------
# 2. DOWN — clean reverse to the 044 reading_chapters shape, then a clean re-up
# ---------------------------------------------------------------------------

def test_051_down_drops_table_and_backing_unique_then_reups(
    env, dsn: str, full_dir
) -> None:
    """Rolling back 051 must drop reading_positions and the
    reading_chapters UNIQUE it added — leaving reading_chapters itself (044)
    intact — and a subsequent up must re-apply 051 cleanly."""
    _full_up(full_dir)

    # Live data in the table proves the down works on a non-empty table.
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f069-down@example.com")
        upload = _seed_upload(conn, user, "down-test book")
        _insert_position(conn, user, upload, page_number=9)

    # --allow-destructive: 051's down contains DROP TABLE (deliberate:
    # rollback = accepted loss of all resume positions).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_051,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_051} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _table_exists(conn, "reading_positions")
        assert not _constraint_exists(conn, "uq_reading_chapters_id_upload")
        # 044's objects are untouched by 051's down.
        assert _table_exists(conn, "reading_chapters")
        assert _constraint_exists(conn, "uq_book_uploads_id_user")

    # Re-up: 051 applies cleanly again (its guards are idempotent-safe).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "reading_positions")
        assert _constraint_exists(conn, "uq_reading_chapters_id_upload")
