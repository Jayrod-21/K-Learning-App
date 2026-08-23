"""Migration 061 (listening_attempts, ticket F-172) — real-chain tests.

WHY THIS FILE EXISTS:
    061 is the storage half of the listening daily-attempt log: an append-only
    table logging one row per "finished this TTMIK lesson" / "finished this
    Iyagi episode" event. Its value is in the lifecycle + bounds topology: the
    users FK CASCADE, the source_kind discriminator + soft SET-NULL FKs to
    ttmik_lessons/iyagi_episodes (a DELIBERATE departure from
    topik_responses' RESTRICT posture — the scoping doc's carve-out for
    corpus tables that can be reloaded/pruned), the title_snapshot length
    bound, the (user_id, completed_at DESC) index, and the updated_at
    trigger. Most importantly: the degraded-row behavior — a lesson (or
    episode) DELETE must SET NULL the referencing column WITHOUT tripping
    ck_listening_attempts_target_not_both, mirroring 060_reading_attempts'
    identical guard for its own chapter/story FKs. These tests apply the REAL
    migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()`` and PROVE each guard by attempting the write (or
    delete) it must reject or survive.

SCOPE:
    - up: table + identity PK shape; users FK CASCADEs on user delete;
      source_kind rejects a non-member value; ck_listening_attempts_target_not_both
      rejects a row with BOTH lesson_id and episode_id set, but permits a
      degraded (both NULL) row surviving a lesson/episode delete; title_snapshot
      length CHECK; updated_at trigger bumps; the history index exists with
      the expected key; the lesson/episode FKs are SET NULL, never RESTRICT.
    - down: listening_attempts dropped (destructive gate) — everything else
      untouched; re-up clean.

DETERMINISM:
    Mirrors test_migration_060.py / test_migration_054.py — the real
    migration files are copied into a tmp_path-scoped directory and the
    runner is pointed at it via ``--migrations-dir``; the ``dsn`` fixture
    gives each test a fresh schema.
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

# The migration immediately before 061. `down --target PRE_061` rolls back
# ONLY 061 (its DROP TABLE down is what requires --allow-destructive).
PRE_061 = "060"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _ensure_corpus_source(conn: psycopg.Connection, corpus: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT id FROM corpus_sources WHERE corpus = %s::corpus LIMIT 1", (corpus,)
        )
        row = cur.fetchone()
        if row is not None:
            return row[0]
        cur.execute(
            """
            INSERT INTO corpus_sources (corpus, title, level, source_path, default_proficiency)
            VALUES (%s::corpus, %s, 'intermediate'::book_level, %s, 'L3'::proficiency_level)
            RETURNING id
            """,
            (corpus, f"test-{corpus}", f"test/{corpus}.json"),
        )
        return cur.fetchone()[0]


def _seed_lesson(
    conn: psycopg.Connection, level: int = 1, number: int = 1, title: str = "레슨"
) -> int:
    corpus_source_id = _ensure_corpus_source(conn, "ttmik")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO ttmik_lessons
                (corpus_source_id, corpus, source_id, lesson_level, lesson_number, ordinal, title)
            VALUES (%s, 'ttmik'::corpus, %s, %s, %s, 1, %s)
            RETURNING id
            """,
            (corpus_source_id, f"ttmik-L{level}-{number}", level, number, title),
        )
        return cur.fetchone()[0]


def _seed_episode(conn: psycopg.Connection, number: int = 1, title: str = "에피소드") -> int:
    corpus_source_id = _ensure_corpus_source(conn, "iyagi")
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO iyagi_episodes
                (corpus_source_id, corpus, source_id, episode_number, ordinal, title)
            VALUES (%s, 'iyagi'::corpus, %s, %s, 1, %s)
            RETURNING id
            """,
            (corpus_source_id, f"iyagi-{number}", number, title),
        )
        return cur.fetchone()[0]


def _insert_lesson_attempt(
    conn: psycopg.Connection,
    user_id: int,
    lesson_id: int | None,
    title_snapshot: str = "Level 1 Lesson 1",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
            VALUES (%s, 'ttmik_lesson', %s, %s)
            RETURNING id
            """,
            (user_id, lesson_id, title_snapshot),
        )
        return cur.fetchone()[0]


def _insert_episode_attempt(
    conn: psycopg.Connection,
    user_id: int,
    episode_id: int | None,
    title_snapshot: str = "Iyagi #1",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO listening_attempts (user_id, source_kind, episode_id, title_snapshot)
            VALUES (%s, 'iyagi_episode', %s, %s)
            RETURNING id
            """,
            (user_id, episode_id, title_snapshot),
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


# ---------------------------------------------------------------------------
# 1. UP — schema shape
# ---------------------------------------------------------------------------

def test_061_up_schema_shape(env, dsn: str, full_dir) -> None:
    """Full-chain up: the table exists; the users FK CASCADEs; the lesson/
    episode FKs SET NULL (never RESTRICT/CASCADE — the scoping-doc carve-out);
    the history index exists."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "listening_attempts")

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target, confdeltype
                  FROM pg_constraint
                 WHERE conname = 'fk_listening_attempts_user'
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "users FK missing"
            assert fk["target"] == "users"
            assert fk["confdeltype"] == "c", "users FK must CASCADE"

            for conname, target in (
                ("fk_listening_attempts_lesson", "ttmik_lessons"),
                ("fk_listening_attempts_episode", "iyagi_episodes"),
            ):
                cur.execute(
                    """
                    SELECT confrelid::regclass::text AS target, confdeltype
                      FROM pg_constraint WHERE conname = %s
                    """,
                    (conname,),
                )
                soft_fk = cur.fetchone()
                assert soft_fk is not None, f"{conname} missing"
                assert soft_fk["target"] == target
                assert soft_fk["confdeltype"] == "n", f"{conname} must be ON DELETE SET NULL"

            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_listening_attempts_user_completed'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "history index missing"
            assert "user_id" in idx["indexdef"] and "completed_at DESC" in idx["indexdef"]


# ---------------------------------------------------------------------------
# 2. UP — CHECK constraints + lifecycle
# ---------------------------------------------------------------------------

def test_061_up_checks_and_lifecycle(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-listening@example.com")
        lesson = _seed_lesson(conn)
        episode = _seed_episode(conn)

        # source_kind is a closed set.
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
                    VALUES (%s, 'bogus', %s, 'x')
                    """,
                    (user, lesson),
                )
        conn.rollback()

        # Both targets set → rejected (ck_listening_attempts_target_not_both).
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO listening_attempts
                        (user_id, source_kind, lesson_id, episode_id, title_snapshot)
                    VALUES (%s, 'ttmik_lesson', %s, %s, 'x')
                    """,
                    (user, lesson, episode),
                )
        conn.rollback()

        # title_snapshot length bound.
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO listening_attempts (user_id, source_kind, lesson_id, title_snapshot)
                    VALUES (%s, 'ttmik_lesson', %s, '')
                    """,
                    (user, lesson),
                )
        conn.rollback()

        # A legal lesson attempt + a legal episode attempt.
        lesson_attempt = _insert_lesson_attempt(conn, user, lesson)
        episode_attempt = _insert_episode_attempt(conn, user, episode)

        # updated_at trigger fires on UPDATE.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM listening_attempts WHERE id = %s", (lesson_attempt,)
            )
            before = cur.fetchone()["updated_at"]
            cur.execute(
                "UPDATE listening_attempts SET title_snapshot = '수정' WHERE id = %s",
                (lesson_attempt,),
            )
            cur.execute(
                "SELECT updated_at FROM listening_attempts WHERE id = %s", (lesson_attempt,)
            )
            after = cur.fetchone()["updated_at"]
        assert after > before, "set_updated_at trigger must bump updated_at"

        # Deleting the user CASCADEs both attempts away.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute(
                "SELECT count(*) FROM listening_attempts WHERE id IN (%s, %s)",
                (lesson_attempt, episode_attempt),
            )
            assert cur.fetchone()[0] == 0, "attempts must CASCADE with their user"


# ---------------------------------------------------------------------------
# 3. UP — the degraded-row invariant: a source delete SET NULLs the FK
#    WITHOUT tripping ck_listening_attempts_target_not_both.
# ---------------------------------------------------------------------------

def test_061_lesson_delete_degrades_without_violating_check(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-degrade-lesson@example.com")
        lesson = _seed_lesson(conn, title="사라질 레슨")
        attempt = _insert_lesson_attempt(conn, user, lesson, title_snapshot="사라질 레슨")

        # A corpus reload prunes the lesson — must succeed (not abort on the
        # attempt row's own CHECK) and SET NULL lesson_id on the attempt.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ttmik_lessons WHERE id = %s", (lesson,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT lesson_id, episode_id, title_snapshot FROM listening_attempts WHERE id = %s",
                (attempt,),
            )
            row = cur.fetchone()
            assert row[0] is None, "lesson_id must SET NULL, not block the delete"
            assert row[1] is None
            assert row[2] == "사라질 레슨", "title_snapshot survives the lesson's removal"


def test_061_episode_delete_degrades_without_violating_check(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-degrade-episode@example.com")
        episode = _seed_episode(conn, title="사라질 에피소드")
        attempt = _insert_episode_attempt(conn, user, episode, title_snapshot="사라질 에피소드")

        with conn.cursor() as cur:
            cur.execute("DELETE FROM iyagi_episodes WHERE id = %s", (episode,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT lesson_id, episode_id, title_snapshot FROM listening_attempts WHERE id = %s",
                (attempt,),
            )
            row = cur.fetchone()
            assert row[0] is None
            assert row[1] is None, "episode_id must SET NULL, not block the delete"
            assert row[2] == "사라질 에피소드"


# ---------------------------------------------------------------------------
# 4. DOWN — the table dropped, nothing else touched, then a clean re-up
# ---------------------------------------------------------------------------

def test_061_down_drops_table_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f172-down-listening@example.com")
        lesson = _seed_lesson(conn)
        _insert_lesson_attempt(conn, user, lesson)

    # --allow-destructive: 061's down contains DROP TABLE (deliberate:
    # rollback = accepted loss of the listening-completion history).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_061,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_061} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert not _table_exists(conn, "listening_attempts")
        # Neighbors untouched (including 060, one level below the target).
        assert _table_exists(conn, "reading_attempts")
        assert _table_exists(conn, "ttmik_lessons")
        assert _table_exists(conn, "iyagi_episodes")
        assert _table_exists(conn, "users")

    # Re-up: 061 applies cleanly again (CREATE TABLE IF NOT EXISTS + fresh state).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "listening_attempts")
