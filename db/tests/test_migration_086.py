"""Migration 086 (reading_questions, F-205 Phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    086 is the storage half of AI-generated reading-comprehension checks: one
    row per (chapter, question_number) carrying the Korean question, exactly
    4 {text, correct} options (JSONB), and a bilingual explanation, plus the
    'reading_comprehension' claude_route enum value. The tests pin exactly
    the contract the route code builds on: the table exists with the right
    columns, rows CASCADE with their chapter (and, transitively, the source
    upload), the options CHECK rejects non-arrays and wrong arities, the
    kind CHECK rejects unknown kinds, UNIQUE (chapter_id, question_number)
    holds, the enum value exists, ships-empty holds (a fresh chapter has no
    questions), a manual re-apply of the up body is a no-op, and the
    destructive down drops the table cleanly then re-ups clean.

DETERMINISM:
    Mirrors test_migration_085.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import json
import pathlib
import shutil

import psycopg
import pytest
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

# The migration immediately before 086. `down --target PRE_086` rolls back
# ONLY 086 (its DROP TABLE down is destructive-marked).
PRE_086 = "085"

# A syntactically valid argon2id-shaped hash satisfying
# ck_users_password_hash_argon2id (LIKE '$argon2id$%', length 80..255).
FAKE_HASH = "$argon2id$" + "x" * 70

# A schema-valid option set: exactly 4, exactly one correct (the writer-side
# Zod contract; the DB CHECK pins array-ness + arity only).
GOOD_OPTIONS = [
    {"text": "호랑이", "correct": True},
    {"text": "토끼", "correct": False},
    {"text": "거북이", "correct": False},
    {"text": "여우", "correct": False},
]


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
# Seed helpers — users → book_uploads → reading_chapters (raw SQL, no app)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "f205@test.local") -> int:
    # Idempotent: the session-scoped container shares one database across this
    # module's tests, so re-seeding the same email must reuse the existing row
    # rather than violate the email UNIQUE. ON CONFLICT DO UPDATE (a no-op set)
    # so RETURNING still yields the id on the conflict path.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO users (email, password_hash) VALUES (%s, %s)
            ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
            RETURNING id
            """,
            (email, FAKE_HASH),
        )
        return cur.fetchone()[0]


def _seed_chapter(conn: psycopg.Connection, user_id: int, chapter_number: int = 1) -> int:
    """Minimal chain to a reading_chapters row; returns the chapter id."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO book_uploads (user_id, title, type, status, byte_size)
            VALUES (%s, '전래동화', 'literature'::book_upload_type,
                    'ready'::book_upload_status, 1024)
            ON CONFLICT (user_id, title) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
            """,
            (user_id,),
        )
        upload_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO reading_chapters (source_upload_id, user_id, chapter_number, title)
            VALUES (%s, %s, %s, '해와 달이 된 오누이')
            RETURNING id
            """,
            (upload_id, user_id, chapter_number),
        )
        return cur.fetchone()[0]


def _insert_question(
    conn: psycopg.Connection,
    chapter_id: int,
    question_number: int = 1,
    options: object = None,
    kind: str = "comprehension",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_questions
                (chapter_id, question_number, question_text, options, explanation, kind, model)
            VALUES (%s, %s, '이야기에서 누가 떡을 먹었습니까?', %s::jsonb,
                    '정답은 호랑이입니다. The tiger ate the rice cakes.', %s,
                    'claude-sonnet-4-6')
            RETURNING id
            """,
            (
                chapter_id,
                question_number,
                json.dumps(options if options is not None else GOOD_OPTIONS),
                kind,
            ),
        )
        return cur.fetchone()[0]


def _table_columns(conn: psycopg.Connection) -> dict[str, dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name='reading_questions'
            """
        )
        return {r["column_name"]: r for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. UP — table + columns exist; the enum value exists; ships EMPTY
# ---------------------------------------------------------------------------

def test_086_up_table_columns_enum_and_ships_empty(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        cols = _table_columns(conn)
        assert cols, "reading_questions must exist after 086"
        expected = {
            "id": "bigint",
            "chapter_id": "bigint",
            "question_number": "integer",
            "question_text": "text",
            "options": "jsonb",
            "explanation": "text",
            "kind": "text",
            "model": "text",
            "created_at": "timestamp with time zone",
            "updated_at": "timestamp with time zone",
            "version": "integer",
        }
        for name, data_type in expected.items():
            assert name in cols, f"column {name} missing"
            assert cols[name]["data_type"] == data_type, f"column {name} type drift"
        assert cols["model"]["is_nullable"] == "YES", "model is provenance — nullable"
        assert cols["chapter_id"]["is_nullable"] == "NO"

        # claude_route gained 'reading_comprehension' (the drift guard in
        # server/tests/db pins the full set; this pins 086's ADD VALUE alone).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                """
                SELECT 'reading_comprehension' = ANY(
                         ARRAY(SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e)
                       )
                """
            )
            assert cur.fetchone()[0] is True

        # Ships EMPTY: a fresh chapter has no questions until generated.
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT count(*) FROM reading_questions WHERE chapter_id = %s",
                (chapter_id,),
            )
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 2. UP — a full row round-trips; deleting the chapter CASCADEs its questions
# ---------------------------------------------------------------------------

def test_086_round_trip_and_chapter_cascade(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)
        other_chapter_id = _seed_chapter(conn, user_id, chapter_number=2)
        q1 = _insert_question(conn, chapter_id, 1)
        _insert_question(conn, chapter_id, 2)
        survivor = _insert_question(conn, other_chapter_id, 1)

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT question_text, options, explanation, kind, model, version"
                "  FROM reading_questions WHERE id = %s",
                (q1,),
            )
            row = cur.fetchone()
            assert row[0] == "이야기에서 누가 떡을 먹었습니까?"
            assert row[1] == GOOD_OPTIONS, "options JSONB round-trips verbatim"
            assert "호랑이" in row[2] and "tiger" in row[2]
            assert row[3] == "comprehension"
            assert row[4] == "claude-sonnet-4-6"
            assert row[5] == 1

            # CASCADE: deleting the chapter deletes ITS questions only.
            cur.execute("DELETE FROM reading_chapters WHERE id = %s", (chapter_id,))
            cur.execute(
                "SELECT count(*) FROM reading_questions WHERE chapter_id = %s",
                (chapter_id,),
            )
            assert cur.fetchone()[0] == 0, "questions must CASCADE with their chapter"
            cur.execute(
                "SELECT count(*) FROM reading_questions WHERE id = %s", (survivor,)
            )
            assert cur.fetchone()[0] == 1, "another chapter's questions must survive"


# ---------------------------------------------------------------------------
# 3. UP — the CHECKs and the UNIQUE hold
# ---------------------------------------------------------------------------

def test_086_options_check_rejects_wrong_shapes(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)

        # 3 options — arity violation.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=GOOD_OPTIONS[:3])
        # 5 options — arity violation.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(
                conn, chapter_id, 1, options=GOOD_OPTIONS + [GOOD_OPTIONS[1]]
            )
        # Non-array JSONB — typeof violation.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options={"text": "x", "correct": True})
        # Exactly 4 still inserts (the failures above did not poison the path).
        _insert_question(conn, chapter_id, 1)


def test_086_kind_check_and_unique(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)

        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, kind="discussion")

        _insert_question(conn, chapter_id, 1)
        # Same (chapter, question_number) — UNIQUE violation.
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_question(conn, chapter_id, 1)
        # Same slot on ANOTHER chapter is fine (the key is composite).
        other_chapter_id = _seed_chapter(conn, user_id, chapter_number=2)
        _insert_question(conn, other_chapter_id, 1)


# ---------------------------------------------------------------------------
# 4. UP — manual re-apply of the up body is a no-op (IF NOT EXISTS / ADD VALUE
#         IF NOT EXISTS / CREATE OR REPLACE TRIGGER)
# ---------------------------------------------------------------------------

def test_086_reapply_up_body_is_noop(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    up_sql = (REAL_MIGRATIONS_DIR / "086_reading_questions.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)
        qid = _insert_question(conn, chapter_id, 1)
        with conn.cursor() as cur:
            # Re-running the whole up body against an already-migrated DB must
            # not error AND must not clobber existing data.
            cur.execute(up_sql)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT question_text FROM reading_questions WHERE id = %s", (qid,)
            )
            assert cur.fetchone()[0] == "이야기에서 누가 떡을 먹었습니까?"


# ---------------------------------------------------------------------------
# 5. DOWN — table dropped, the reading tables intact, then a clean re-up
# ---------------------------------------------------------------------------

def test_086_down_drops_table_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)
        _insert_question(conn, chapter_id, 1)

    # --allow-destructive: 086's down contains DROP TABLE (destructive-marked;
    # the questions are re-derivable by re-generating — a paid call, 083's
    # posture).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_086,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_086} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert _table_columns(conn) == {}, "reading_questions must be gone after down"
        with conn.cursor() as cur:
            # The parent chain survives the down — 044 owns it.
            cur.execute("SELECT title FROM reading_chapters WHERE id = %s", (chapter_id,))
            row = cur.fetchone()
            assert row is not None, "the chapter must outlive the questions drop"
            assert row[0] == "해와 달이 된 오누이"
            # The enum value deliberately survives (Postgres cannot drop it).
            cur.execute(
                """
                SELECT 'reading_comprehension' = ANY(
                         ARRAY(SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e)
                       )
                """
            )
            assert cur.fetchone()[0] is True

    # Re-up: 086 applies cleanly again; the table is back and EMPTY (lossy by
    # design — the down discarded the sets; re-generating is the recovery path).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert "options" in _table_columns(conn)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM reading_questions WHERE chapter_id = %s",
                (chapter_id,),
            )
            assert cur.fetchone()[0] == 0
