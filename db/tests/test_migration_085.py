"""Migration 085 (topik_items.image_ref, F-120 Phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    085 is the storage half of TOPIK question images: one nullable TEXT
    column carrying a corpus-relative image key (the 035/078 contract,
    per-item). The migration is deliberately tiny, so the tests pin exactly
    the contract the route/loader code builds on: the column exists and is
    nullable (ships EMPTY — every pre-existing row must read NULL), a value
    round-trips verbatim, a manual re-apply of the up body is a no-op
    (ADD COLUMN IF NOT EXISTS), and the destructive down drops the column
    cleanly without touching the rest of topik_items, then re-ups clean.

DETERMINISM:
    Mirrors test_migration_084.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row, tuple_row

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

# The migration immediately before 085. `down --target PRE_085` rolls back
# ONLY 085 (its DROP COLUMN down is destructive-marked).
PRE_085 = "084"

# A realistic corpus-relative key (the 035/078 contract this column mirrors).
IMAGE_REF = "TOPIK IMAGES/60 - 60th TOPIK/TOPIK-II/listening/q01.png"


# ---------------------------------------------------------------------------
# Seed helper — corpus_sources → topik_tests → topik_items (raw SQL, no app)
# ---------------------------------------------------------------------------

def _seed_topik_item(conn: psycopg.Connection) -> int:
    """Minimal chain to a topik_items row; returns the item id."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO corpus_sources (corpus, title, source_path)
            VALUES ('topik', 'TOPIK test corpus', '/f120/topik.json')
            ON CONFLICT (corpus) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """
        )
        source_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_tests (corpus_source_id, test_number, topik_level, section)
            VALUES (%s, 60, 'TOPIK II', 'listening'::topik_section)
            RETURNING id
            """,
            (source_id,),
        )
        test_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO topik_items
                (topik_test_id, corpus_source_id, source_id, item_number, section,
                 item_type, proficiency, stem, options, answer)
            VALUES (%s, %s, 'f120-topik60-listen-001', 1, 'listening'::topik_section,
                    'multiple_choice'::topik_item_type, 'L3'::proficiency_level,
                    '알맞은 그림을 고르십시오.', '["a","b","c","d"]'::jsonb, '1'::jsonb)
            RETURNING id
            """,
            (test_id, source_id),
        )
        return cur.fetchone()[0]


def _column_info(conn: psycopg.Connection) -> dict | None:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name='topik_items'
               AND column_name='image_ref'
            """
        )
        return cur.fetchone()


# ---------------------------------------------------------------------------
# 1. UP — column exists, TEXT, nullable, no default; ships EMPTY
# ---------------------------------------------------------------------------

def test_085_up_column_exists_nullable_and_ships_empty(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        info = _column_info(conn)
        assert info is not None, "topik_items.image_ref must exist after 085"
        assert info["data_type"] == "text"
        assert info["is_nullable"] == "YES", "NULL = no image mapped is the contract"
        assert info["column_default"] is None, "no default — rows ship NULL"

        # A row inserted WITHOUT naming the column reads NULL — the ships-empty
        # posture every pre-085 row lands in.
        item_id = _seed_topik_item(conn)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT image_ref FROM topik_items WHERE id = %s", (item_id,))
            assert cur.fetchone()[0] is None


# ---------------------------------------------------------------------------
# 2. UP — a corpus-relative key round-trips verbatim (and NULLs back out)
# ---------------------------------------------------------------------------

def test_085_value_round_trips(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        item_id = _seed_topik_item(conn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE topik_items SET image_ref = %s WHERE id = %s",
                (IMAGE_REF, item_id),
            )
            cur.execute("SELECT image_ref FROM topik_items WHERE id = %s", (item_id,))
            assert cur.fetchone()[0] == IMAGE_REF, "spaces and all — verbatim"

            # The loader's convergence clear writes NULL back — legal.
            cur.execute(
                "UPDATE topik_items SET image_ref = NULL WHERE id = %s", (item_id,)
            )
            cur.execute("SELECT image_ref FROM topik_items WHERE id = %s", (item_id,))
            assert cur.fetchone()[0] is None


# ---------------------------------------------------------------------------
# 3. UP — manual re-apply of the up body is a no-op (IF NOT EXISTS)
# ---------------------------------------------------------------------------

def test_085_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "085_topik_item_images.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _seed_topik_item(conn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE topik_items SET image_ref = %s WHERE id = %s",
                (IMAGE_REF, item_id),
            )
            # Re-running the whole up body against an already-migrated DB must
            # not error AND must not clobber existing data.
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT image_ref FROM topik_items WHERE id = %s", (item_id,))
            assert cur.fetchone()[0] == IMAGE_REF, "re-apply must not touch data"


# ---------------------------------------------------------------------------
# 4. DOWN — column dropped, the rest of topik_items intact, then a clean re-up
# ---------------------------------------------------------------------------

def test_085_down_drops_column_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        item_id = _seed_topik_item(conn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE topik_items SET image_ref = %s WHERE id = %s",
                (IMAGE_REF, item_id),
            )

    # --allow-destructive: 085's down contains DROP COLUMN (destructive-marked;
    # the mapping is recoverable from the extraction manifests — 078's posture).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_085,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_085} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert _column_info(conn) is None, "image_ref must be gone after the down"
        # The item row itself (and its neighbors' columns) survive the down.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stem, has_image FROM topik_items WHERE id = %s", (item_id,)
            )
            row = cur.fetchone()
            assert row is not None, "the item row must outlive the column drop"
            assert row[0] == "알맞은 그림을 고르십시오."

    # Re-up: 085 applies cleanly again; the column is back and NULL (lossy by
    # design — the down discarded the mapping, the loader is the recovery path).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        info = _column_info(conn)
        assert info is not None and info["is_nullable"] == "YES"
        with conn.cursor() as cur:
            cur.execute("SELECT image_ref FROM topik_items WHERE id = %s", (item_id,))
            assert cur.fetchone()[0] is None
