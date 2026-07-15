"""Migration 060 (reading_attempts, ticket F-172) — real-chain tests.

WHY THIS FILE EXISTS:
    060 is the storage half of the reading daily-attempt log: an append-only
    table logging one row per "finished this chapter" / "finished this AI
    story" event. Its value is in the lifecycle + bounds topology: the users
    FK CASCADE (an attempt dies with its owner), the source_kind discriminator
    + soft SET-NULL FKs to reading_chapters/generated_stories, the
    title_snapshot length bound, the passage_number positivity bound, the
    (user_id, completed_at DESC) index the history route rides, and the
    updated_at trigger. Most importantly: the degraded-row behavior — a
    chapter (or story) DELETE must SET NULL the referencing column WITHOUT
    tripping ck_reading_attempts_target_not_both, exactly the failure mode
    migration 051 documents avoiding for reading_positions' own chapter FK.
    These tests apply the REAL migration chain against a real Postgres-16
    testcontainer via ``migrate.main()`` and PROVE each guard by attempting
    the write (or delete) it must reject or survive.

SCOPE:
    - up: table + identity PK shape; users FK CASCADEs on user delete;
      source_kind rejects a non-member value; ck_reading_attempts_target_not_both
      rejects a row with BOTH chapter_id and story_id set, but permits a
      degraded (both NULL) row surviving a chapter/story delete; title_snapshot
      length CHECK; passage_number positivity CHECK; updated_at trigger bumps;
      the history index exists with the expected key.
    - down: reading_attempts dropped (destructive gate) — everything else
      untouched; re-up clean.

DETERMINISM:
    Mirrors test_migration_054.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib
import shutil

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import dict_row, tuple_row

from db import migrate  # type: ignore[import-not-found]

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

# The migration immediately before 060. `down --target PRE_060` rolls back
# ONLY 060 (its DROP TABLE down is what requires --allow-destructive).
PRE_060 = "059"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70


# ---------------------------------------------------------------------------
# Fixtures — one container per session, a fresh DB + full migration dir per test
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture()
def dsn(pg_container) -> str:
    raw = pg_container.get_connection_url()
    raw = raw.replace("postgresql+psycopg2://", "postgres://")
    raw = raw.replace("postgresql://", "postgres://")
    with psycopg.connect(raw, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
    return raw


@pytest.fixture()
def env(monkeypatch, dsn) -> None:
    monkeypatch.setenv("DATABASE_URL", dsn)


@pytest.fixture()
def full_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """A tmp directory containing EVERY production migration file."""
    d = tmp_path / "migrations_full"
    d.mkdir(parents=True)
    copied = 0
    for src in REAL_MIGRATIONS_DIR.iterdir():
        if src.suffix == ".sql" and src.is_file():
            shutil.copy2(src, d / src.name)
            copied += 1
    assert copied > 0, f"no migration files found under {REAL_MIGRATIONS_DIR}"
    return d


def _full_up(full_dir: pathlib.Path) -> None:
    # --allow-destructive: migration 045 (hygiene_cleanup, DROP TABLE) sits in
    # the chain, so a full `up` trips migrate.py's destructive gate without it.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--allow-destructive", "up"])
    assert rc == 0, f"full up returned {rc}"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_book_upload(conn: psycopg.Connection, user_id: int, title: str = "테스트 책") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, %s, 'literature'::book_upload_type, 'ready'::book_upload_status, 1024)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _seed_chapter(
    conn: psycopg.Connection,
    user_id: int,
    upload_id: int,
    chapter_number: int = 1,
    title: str | None = "1장",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_chapters (source_upload_id, user_id, chapter_number, title)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (upload_id, user_id, chapter_number, title),
        )
        return cur.fetchone()[0]


def _seed_story(
    conn: psycopg.Connection,
    user_id: int,
    title: str = "모의 이야기",
    level: str = "L3",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level)
            VALUES (%s, %s, '옛날 옛적에 이야기가 있었습니다.', %s::proficiency_level)
            RETURNING id
            """,
            (user_id, title, level),
        )
        return cur.fetchone()[0]


def _insert_chapter_attempt(
    conn: psycopg.Connection,
    user_id: int,
    chapter_id: int | None,
    title_snapshot: str = "1장",
    passage_number: int | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_attempts
                (user_id, source_kind, chapter_id, title_snapshot, passage_number)
            VALUES (%s, 'chapter', %s, %s, %s)
            RETURNING id
            """,
            (user_id, chapter_id, title_snapshot, passage_number),
        )
        return cur.fetchone()[0]


def _insert_story_attempt(
    conn: psycopg.Connection,
    user_id: int,
    story_id: int | None,
    title_snapshot: str = "모의 이야기",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_attempts (user_id, source_kind, story_id, title_snapshot)
            VALUES (%s, 'story', %s, %s)
            RETURNING id
            """,
            (user_id, story_id, title_snapshot),
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

def test_060_up_schema_shape(env, dsn: str, full_dir) -> None:
    """Full-chain up: the table exists; the users FK CASCADEs; the chapter/
    story FKs SET NULL (never RESTRICT/CASCADE); the history index exists."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "reading_attempts")

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target,
                       confdeltype, confupdtype
                  FROM pg_constraint
                 WHERE conname = 'fk_reading_attempts_user'
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "users FK missing"
            assert fk["target"] == "users"
            assert fk["confdeltype"] == "c", "users FK must CASCADE"

            for conname, target in (
                ("fk_reading_attempts_chapter", "reading_chapters"),
                ("fk_reading_attempts_story", "generated_stories"),
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
                 WHERE indexname = 'ix_reading_attempts_user_completed'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "history index missing"
            assert "user_id" in idx["indexdef"] and "completed_at DESC" in idx["indexdef"]


# ---------------------------------------------------------------------------
# 2. UP — CHECK constraints + lifecycle
# ---------------------------------------------------------------------------

def test_060_up_checks_and_lifecycle(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-reading@example.com")
        upload = _seed_book_upload(conn, user)
        chapter = _seed_chapter(conn, user, upload)
        story = _seed_story(conn, user)

        # source_kind is a closed set.
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO reading_attempts
                        (user_id, source_kind, chapter_id, title_snapshot)
                    VALUES (%s, 'bogus', %s, 'x')
                    """,
                    (user, chapter),
                )
        conn.rollback()

        # Both targets set → rejected (ck_reading_attempts_target_not_both).
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO reading_attempts
                        (user_id, source_kind, chapter_id, story_id, title_snapshot)
                    VALUES (%s, 'chapter', %s, %s, 'x')
                    """,
                    (user, chapter, story),
                )
        conn.rollback()

        # title_snapshot length bound.
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO reading_attempts
                        (user_id, source_kind, chapter_id, title_snapshot)
                    VALUES (%s, 'chapter', %s, '')
                    """,
                    (user, chapter),
                )
        conn.rollback()

        # passage_number must be positive when present.
        with conn.cursor() as cur:
            with pytest.raises(errors.CheckViolation):
                cur.execute(
                    """
                    INSERT INTO reading_attempts
                        (user_id, source_kind, chapter_id, title_snapshot, passage_number)
                    VALUES (%s, 'chapter', %s, 'x', 0)
                    """,
                    (user, chapter),
                )
        conn.rollback()

        # A legal chapter attempt + a legal story attempt.
        chapter_attempt = _insert_chapter_attempt(conn, user, chapter, passage_number=3)
        story_attempt = _insert_story_attempt(conn, user, story)

        # updated_at trigger fires on UPDATE.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM reading_attempts WHERE id = %s", (chapter_attempt,)
            )
            before = cur.fetchone()["updated_at"]
            cur.execute(
                "UPDATE reading_attempts SET title_snapshot = '수정' WHERE id = %s",
                (chapter_attempt,),
            )
            cur.execute(
                "SELECT updated_at FROM reading_attempts WHERE id = %s", (chapter_attempt,)
            )
            after = cur.fetchone()["updated_at"]
        assert after > before, "set_updated_at trigger must bump updated_at"

        # Deleting the user CASCADEs both attempts away.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute(
                "SELECT count(*) FROM reading_attempts WHERE id IN (%s, %s)",
                (chapter_attempt, story_attempt),
            )
            assert cur.fetchone()[0] == 0, "attempts must CASCADE with their user"


# ---------------------------------------------------------------------------
# 3. UP — the degraded-row invariant: a source delete SET NULLs the FK
#    WITHOUT tripping ck_reading_attempts_target_not_both (the bug this table
#    exists to avoid — see migration 051's documented precedent).
# ---------------------------------------------------------------------------

def test_060_chapter_delete_degrades_without_violating_check(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-degrade-chapter@example.com")
        upload = _seed_book_upload(conn, user)
        chapter = _seed_chapter(conn, user, upload)
        attempt = _insert_chapter_attempt(conn, user, chapter, title_snapshot="사라질 장")

        # A book re-load deletes the chapter — must succeed (not abort on the
        # attempt row's own CHECK) and SET NULL chapter_id on the attempt.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM reading_chapters WHERE id = %s", (chapter,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT chapter_id, story_id, title_snapshot FROM reading_attempts WHERE id = %s",
                (attempt,),
            )
            row = cur.fetchone()
            assert row[0] is None, "chapter_id must SET NULL, not block the delete"
            assert row[1] is None
            assert row[2] == "사라질 장", "title_snapshot survives the chapter's removal"


def test_060_story_delete_degrades_without_violating_check(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f172-degrade-story@example.com")
        story = _seed_story(conn, user, title="사라질 이야기")
        attempt = _insert_story_attempt(conn, user, story, title_snapshot="사라질 이야기")

        with conn.cursor() as cur:
            cur.execute("DELETE FROM generated_stories WHERE id = %s", (story,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT chapter_id, story_id, title_snapshot FROM reading_attempts WHERE id = %s",
                (attempt,),
            )
            row = cur.fetchone()
            assert row[0] is None
            assert row[1] is None, "story_id must SET NULL, not block the delete"
            assert row[2] == "사라질 이야기"


# ---------------------------------------------------------------------------
# 4. DOWN — the table dropped, nothing else touched, then a clean re-up
# ---------------------------------------------------------------------------

def test_060_down_drops_table_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f172-down@example.com")
        upload = _seed_book_upload(conn, user)
        chapter = _seed_chapter(conn, user, upload)
        _insert_chapter_attempt(conn, user, chapter)

    # --allow-destructive: 060's down contains DROP TABLE (deliberate:
    # rollback = accepted loss of the reading-completion history).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_060,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_060} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert not _table_exists(conn, "reading_attempts")
        # Neighbors untouched.
        assert _table_exists(conn, "reading_chapters")
        assert _table_exists(conn, "generated_stories")
        assert _table_exists(conn, "users")

    # Re-up: 060 applies cleanly again (CREATE TABLE IF NOT EXISTS + fresh state).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "reading_attempts")
