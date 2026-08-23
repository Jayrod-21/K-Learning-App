"""Migration 086 (reading_questions, F-205 Phase 1) — real-chain tests.

WHY THIS FILE EXISTS:
    086 is the storage half of AI-generated reading-comprehension checks: one
    row per (chapter, question_number) carrying the Korean question, exactly
    4 {text, correct} options (JSONB), and a bilingual explanation, plus the
    'reading_comprehension' claude_route enum value. The tests pin exactly
    the contract the route code builds on: the table exists with the right
    columns (model as the closed claude_model enum, not free-form TEXT),
    rows CASCADE with their chapter (and, transitively, the source upload),
    the options CHECKs reject non-arrays, wrong arities, malformed elements,
    and zero/two-correct sets, the kind CHECK rejects unknown kinds, the
    scalar CHECKs (question_number, text/explanation length) hold their
    bounds, UNIQUE (chapter_id, question_number) holds, the enum value
    exists, ships-empty holds (a fresh chapter has no questions), a manual
    re-apply of the up body is a no-op, and the destructive down drops the
    table cleanly then re-ups clean.

DETERMINISM:
    Mirrors test_migration_085.py — the real migration files are copied into
    a tmp_path-scoped directory and the runner is pointed at it via
    ``--migrations-dir``; the ``dsn`` fixture gives each test a fresh schema.
"""

from __future__ import annotations

import json
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row, tuple_row

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

# The migration immediately before 086. `down --target PRE_086` rolls back
# ONLY 086 (its DROP TABLE down is destructive-marked).
PRE_086 = "085"


# A schema-valid option set: exactly 4, exactly one correct (the writer-side
# Zod contract; the DB CHECK pins array-ness + arity only).
GOOD_OPTIONS = [
    {"text": "호랑이", "correct": True},
    {"text": "토끼", "correct": False},
    {"text": "거북이", "correct": False},
    {"text": "여우", "correct": False},
]


# ---------------------------------------------------------------------------
# Seed helpers — users → book_uploads → reading_chapters (raw SQL, no app)
# ---------------------------------------------------------------------------

def _seed_user(conn: psycopg.Connection, email: str = "f205@test.local") -> int:
    # Idempotent, NOT because the DB is session-shared (it isn't — the `dsn`
    # fixture DROPs/CREATEs the public schema before every test, so each test
    # starts from a clean slate; `pg_container` is merely the underlying
    # Postgres PROCESS, reused for speed). ON CONFLICT DO UPDATE (a no-op
    # set, so RETURNING still fires on the conflict branch) guards a
    # WITHIN-test double-call on the same default email, matching the
    # pattern `_seed_chapter`'s upload upsert below actually exercises
    # (round_trip's two same-book chapters) — cheap, harmless insurance if a
    # future test ever seeds the same user twice.
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
        # ON CONFLICT (user_id, title) DO UPDATE (no-op set, RETURNING still
        # fires): `test_086_round_trip_and_chapter_cascade` calls this
        # helper TWICE with the same default title to put two SIBLING
        # chapters under ONE book_uploads row (needed to prove CASCADE
        # isolation between chapters of the SAME book, not just between
        # books) — a plain INSERT would 23505 on the second call's
        # UNIQUE(user_id, title). This is the actual reason idempotency is
        # needed here (see `_seed_user` above for the analogous, currently
        # dormant, guard on that side).
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
    question_text: str = "이야기에서 누가 떡을 먹었습니까?",
    explanation: str = "정답은 호랑이입니다. The tiger ate the rice cakes.",
    model: str | None = "claude-sonnet-4-6",
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO reading_questions
                (chapter_id, question_number, question_text, options, explanation, kind, model)
            VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s::claude_model)
            RETURNING id
            """,
            (
                chapter_id,
                question_number,
                question_text,
                json.dumps(options if options is not None else GOOD_OPTIONS),
                explanation,
                kind,
                model,
            ),
        )
        return cur.fetchone()[0]


def _table_columns(conn: psycopg.Connection) -> dict[str, dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT column_name, data_type, udt_name, is_nullable
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
            # claude_model is a USER-DEFINED enum (004) — information_schema
            # reports the generic 'USER-DEFINED' in data_type; udt_name is
            # the actual type name (071/054's exact pattern for enum cols).
            "model": "USER-DEFINED",
            "created_at": "timestamp with time zone",
            "updated_at": "timestamp with time zone",
            "version": "integer",
        }
        for name, data_type in expected.items():
            assert name in cols, f"column {name} missing"
            assert cols[name]["data_type"] == data_type, f"column {name} type drift"
        assert cols["model"]["udt_name"] == "claude_model", "model must be the shared enum, not free-form TEXT"
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


def test_086_options_element_shape_and_exactly_one_correct(
    env, dsn: str, full_dir
) -> None:
    """Defense-in-depth CHECKs added on top of the writer's Zod refine:
    every option must carry a genuine {text: non-empty string, correct:
    boolean} shape, and exactly one option's correct must be true. All of
    these are structurally valid 4-element arrays (they'd sail past
    ck_reading_questions_options_shape alone) — only the new element-shape /
    exactly-one-correct CHECKs catch them."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)

        # Two correct:true — ambiguous ground truth.
        two_correct = [dict(o) for o in GOOD_OPTIONS]
        two_correct[1] = {**two_correct[1], "correct": True}
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=two_correct)

        # Zero correct:true — no ground truth at all.
        zero_correct = [{**o, "correct": False} for o in GOOD_OPTIONS]
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=zero_correct)

        # Missing 'correct' key entirely on one element.
        missing_correct_key = [dict(o) for o in GOOD_OPTIONS]
        del missing_correct_key[2]["correct"]
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=missing_correct_key)

        # Missing 'text' key entirely on one element.
        missing_text_key = [dict(o) for o in GOOD_OPTIONS]
        del missing_text_key[0]["text"]
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=missing_text_key)

        # 'correct' present but the WRONG JSON type (a string, not a boolean)
        # — must be rejected as a clean CHECK violation, never a runtime
        # cast error (the whole point of the jsonb-equality/typeof design).
        wrong_type_correct = [dict(o) for o in GOOD_OPTIONS]
        wrong_type_correct[0] = {**wrong_type_correct[0], "correct": "true"}
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=wrong_type_correct)

        # Empty 'text' on one element.
        empty_text = [dict(o) for o in GOOD_OPTIONS]
        empty_text[3] = {**empty_text[3], "text": ""}
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, options=empty_text)

        # A genuinely valid set still inserts (the failures above left no
        # residue that would poison a subsequent valid insert).
        _insert_question(conn, chapter_id, 1)


def test_086_scalar_checks_reject_bad_values(env, dsn: str, full_dir) -> None:
    """The four scalar CHECKs the options/kind/UNIQUE tests above don't
    exercise: question_number > 0, question_text/explanation length bounds,
    and (now that model is the closed claude_model enum, not free-form TEXT)
    that an out-of-domain model id is rejected too."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn)
        chapter_id = _seed_chapter(conn, user_id)

        # question_number must be > 0.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, question_number=0)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, question_number=-1)

        # question_text: 1..2000 chars.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, question_text="")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 1, question_text="가" * 2001)
        # Boundary-exact (2000) still inserts.
        _insert_question(conn, chapter_id, 1, question_text="가" * 2000)

        # explanation: 1..4000 chars.
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 2, explanation="")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_question(conn, chapter_id, 2, explanation="나" * 4001)
        # Boundary-exact (4000) still inserts.
        _insert_question(conn, chapter_id, 2, explanation="나" * 4000)

        # model: NULL is fine (provenance-optional); an out-of-domain model
        # id is rejected by the enum ITSELF (a type/input error, not a table
        # CHECK — claude_model (004) is a closed set, so a malformed value
        # can never reach the column at all).
        _insert_question(conn, chapter_id, 3, model=None)
        with pytest.raises(psycopg.errors.InvalidTextRepresentation):
            _insert_question(conn, chapter_id, 4, model="claude-sonnett-4-6")


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
