"""Migration 092 (dead_schema_removal, audit §4.3) — real-chain tests.

WHY THIS FILE EXISTS:
    092 drops confirmed-dead schema: 2 tables (lets_check_exercises,
    hanja_extensions), 2 redundant indexes (ix_hanja_compounds_character,
    ix_topik_dependencies_item — each prefix-subsumed by a UNIQUE index), and
    18 all-NULL columns across vocab_entries, krdict_entries, krdict_senses,
    topik_items, book_pages, conversations, corpus_sources. The tests pin the
    contract in both directions, which is what makes the "non-destructive"
    classification honest:
      * UP removes every one of the 22 objects.
      * DOWN restores every one of them (structural restore only — every
        dropped object held 0 rows / all-NULL, so there is nothing to
        backfill, unlike 091's tsvector backfill).
      * A re-applied UP body is a no-op (every DROP is IF EXISTS).
      * topik_items.skill_tag (NOT in the drop list — kept deliberately,
        see the migration header) survives untouched throughout.

DETERMINISM:
    Mirrors test_migration_091.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

from db import migrate  # type: ignore[import-not-found]
from db.tests._helpers import FAKE_HASH, _full_up, _seed_user  # type: ignore[import-not-found]

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

# The migration immediately before 092. `down --target PRE_092` rolls back
# ONLY 092.
PRE_092 = "091"

DROPPED_TABLES = ["lets_check_exercises", "hanja_extensions"]
DROPPED_INDEXES = ["ix_hanja_compounds_character", "ix_topik_dependencies_item"]

# (table, column) pairs dropped by 092.
DROPPED_COLUMNS = [
    ("vocab_entries", "audio_track"),
    ("vocab_entries", "japanese"),
    ("vocab_entries", "case_marker"),
    ("vocab_entries", "irregular_class"),
    ("vocab_entries", "passive_form"),
    ("vocab_entries", "causative_form"),
    ("vocab_entries", "basic_form"),
    ("vocab_entries", "honorific_form"),
    ("vocab_entries", "humble_form"),
    ("vocab_entries", "contracted_form"),
    ("krdict_entries", "register"),
    ("krdict_senses", "sense_domain"),
    ("krdict_senses", "sense_register"),
    ("topik_items", "skill_tag_raw"),
    ("book_pages", "width"),
    ("book_pages", "height"),
    ("conversations", "last_grading"),
    ("corpus_sources", "version_tag"),
]

# CHECK constraints that cascade-drop with their column and must come back
# with the column on DOWN.
DROPPED_COLUMN_CHECKS = [
    ("book_pages", "ck_book_pages_width_positive"),
    ("book_pages", "ck_book_pages_height_positive"),
    ("conversations", "ck_conversations_grading_object"),
]


def _down_to_pre_092(full_dir: pathlib.Path) -> None:
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_092, "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_092} returned {rc}"


# ---------------------------------------------------------------------------
# Object-presence predicates
# ---------------------------------------------------------------------------

def _table_exists(conn: psycopg.Connection, table: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = %s",
            (table,),
        )
        return cur.fetchone() is not None


def _column_exists(conn: psycopg.Connection, table: str, column: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s AND column_name = %s",
            (table, column),
        )
        return cur.fetchone() is not None


def _index_exists(conn: psycopg.Connection, index: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT 1 FROM pg_indexes WHERE indexname = %s", (index,))
        return cur.fetchone() is not None


def _constraint_exists(conn: psycopg.Connection, table: str, constraint: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = %s AND c.conname = %s",
            (table, constraint),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — every dead object is gone; the kept skill_tag column survives.
# ---------------------------------------------------------------------------

def test_092_up_removes_all_dead_objects(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in DROPPED_TABLES:
            assert not _table_exists(conn, table), f"{table} still present"
        for index in DROPPED_INDEXES:
            assert not _index_exists(conn, index), f"{index} still present"
        for table, column in DROPPED_COLUMNS:
            assert not _column_exists(conn, table, column), f"{table}.{column} still present"
        for table, constraint in DROPPED_COLUMN_CHECKS:
            assert not _constraint_exists(conn, table, constraint), (
                f"{table}.{constraint} still present"
            )
        # Deliberately KEPT — skill_tag has a live reader
        # (tools/ingest/link_topik_dependencies.py). Must survive 092.
        assert _column_exists(conn, "topik_items", "skill_tag"), (
            "topik_items.skill_tag was dropped — it must be kept (live reader)"
        )
        # The subsuming UNIQUE indexes that justified the two index drops
        # must themselves still be present.
        assert _index_exists(conn, "uq_hanja_compounds_character_word")
        assert _index_exists(conn, "uq_topik_dependencies_natural_key")
        # topik_dependencies the TABLE is explicitly kept (only its
        # redundant index was dropped).
        assert _table_exists(conn, "topik_dependencies")


# ---------------------------------------------------------------------------
# 2. DOWN — every dead object is restored.
# ---------------------------------------------------------------------------

def test_092_down_restores_all_dead_objects(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    _down_to_pre_092(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in DROPPED_TABLES:
            assert _table_exists(conn, table), f"{table} not restored"
        for index in DROPPED_INDEXES:
            assert _index_exists(conn, index), f"{index} not restored"
        for table, column in DROPPED_COLUMNS:
            assert _column_exists(conn, table, column), f"{table}.{column} not restored"
        for table, constraint in DROPPED_COLUMN_CHECKS:
            assert _constraint_exists(conn, table, constraint), (
                f"{table}.{constraint} not restored"
            )

    # Re-up: 092 re-applies cleanly, the objects are gone again.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in DROPPED_TABLES:
            assert not _table_exists(conn, table), f"{table} back after re-up"
        for table, column in DROPPED_COLUMNS:
            assert not _column_exists(conn, table, column), (
                f"{table}.{column} back after re-up"
            )


# ---------------------------------------------------------------------------
# 3. UP — re-applying the up body is a no-op (every DROP is IF EXISTS).
# ---------------------------------------------------------------------------

def test_092_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    up_sql = (REAL_MIGRATIONS_DIR / "092_dead_schema_removal.up.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(up_sql)  # must not raise on already-dropped objects
        for table in DROPPED_TABLES:
            assert not _table_exists(conn, table), f"{table} reappeared on reapply"
        for table, column in DROPPED_COLUMNS:
            assert not _column_exists(conn, table, column), (
                f"{table}.{column} reappeared on reapply"
            )


# ---------------------------------------------------------------------------
# 4. DOWN restored structures accept inserts matching the original CHECKs
#    (proves the restored CHECK constraints are byte-faithful, not just the
#    bare column).
# ---------------------------------------------------------------------------

def test_092_down_restored_checks_enforce_original_constraints(
    env, dsn: str, full_dir
) -> None:
    _full_up(full_dir)
    _down_to_pre_092(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "dead-schema-092@example.test")
        with conn.cursor(row_factory=tuple_row) as cur:
            # book_pages.width CHECK (width IS NULL OR width > 0) — restored
            # verbatim by the down migration.
            cur.execute(
                "INSERT INTO book_uploads (user_id, title, type, byte_size) "
                "VALUES (%s, 't', 'vocab'::book_upload_type, 100) "
                "RETURNING id",
                (user_id,),
            )
            upload_id = cur.fetchone()[0]
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "INSERT INTO book_pages (upload_id, page_number, blob_ref, width) "
                    "VALUES (%s, 1, 'x.jpg', 0)",
                    (upload_id,),
                )
        with conn.cursor(row_factory=tuple_row) as cur:
            # conversations.last_grading CHECK (jsonb_typeof(...) = 'object')
            cur.execute(
                "INSERT INTO conversations (user_id, mode) "
                "VALUES (%s, 'casual'::conversation_mode) RETURNING id",
                (user_id,),
            )
            conv_id = cur.fetchone()[0]
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "UPDATE conversations SET last_grading = '[1,2,3]'::jsonb WHERE id = %s",
                    (conv_id,),
                )
