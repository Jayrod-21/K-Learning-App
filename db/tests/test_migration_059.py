"""Migration 059 (hanja_attempts, F-171) — real-chain tests.

WHY THIS FILE EXISTS:
    059 adds ONE new table, `hanja_attempts` — an append-only log of completed
    hanja FSRS card reviews (written by services/cardReview.ts inside the SAME
    transaction as POST /hanja/cards/:cardId/reviews). These tests apply the
    REAL migration chain against a Postgres-16 testcontainer via
    ``migrate.main()`` and prove: the table shape, the two FK behaviors (user
    CASCADE, card SET NULL — deliberately DIFFERENT, mirroring
    writing_attempts' prompt_id precedent), the char-length CHECK, the shared
    fsrs_rating enum constraint, and the down/re-up cycle (table gone, then
    cleanly restored).

DETERMINISM:
    Mirrors test_migration_058.py — the real migration files are copied into
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

# The migration immediately before 059 in the chain. `down --target PRE_059`
# rolls back 059 alone — its down is DROP TABLE, which DOES trip the
# destructive gate (unlike 058's DROP COLUMN), so the down invocation below
# passes --allow-destructive explicitly.
PRE_059 = "058"

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


def _seed_hanja_character(conn: psycopg.Connection, char: str) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_characters (char, sound, gloss_en, strokes, level)
            VALUES (%s, 'test', 'test gloss', 5, 'L3')
            RETURNING id
            """,
            (char,),
        )
        return cur.fetchone()[0]


def _seed_hanja_card(conn: psycopg.Connection, user_id: int, character_id: int) -> int:
    """A live vocab_cards row on the hanja XOR leg (mirrors POST /hanja/:char/card)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO vocab_cards (user_id, face, hanja_character_id)
            VALUES (%s, 'recognition'::card_face, %s)
            RETURNING id
            """,
            (user_id, character_id),
        )
        return cur.fetchone()[0]


def _seed_attempt(
    conn: psycopg.Connection,
    user_id: int,
    char: str,
    rating: str = "good",
    correct: bool = True,
    card_id: int | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO hanja_attempts (user_id, card_id, char, rating, correct)
            VALUES (%s, %s, %s, %s::fsrs_rating, %s)
            RETURNING id
            """,
            (user_id, card_id, char, rating, correct),
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


def _index_exists(conn: psycopg.Connection, indexname: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_indexes WHERE indexname = %s",
            (indexname,),
        )
        return cur.fetchone() is not None


def _table_exists(conn: psycopg.Connection, table: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = %s",
            (table,),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. UP — table shape, constraints, index
# ---------------------------------------------------------------------------

def test_059_up_schema_shape(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "hanja_attempts")

        user_id_col = _column_info(conn, "hanja_attempts", "user_id")
        assert user_id_col is not None
        assert user_id_col["is_nullable"] == "NO"

        card_id_col = _column_info(conn, "hanja_attempts", "card_id")
        assert card_id_col is not None
        assert card_id_col["is_nullable"] == "YES"  # soft FK, SET NULL target

        char_col = _column_info(conn, "hanja_attempts", "char")
        assert char_col is not None
        assert char_col["data_type"] == "text"
        assert char_col["is_nullable"] == "NO"

        correct_col = _column_info(conn, "hanja_attempts", "correct")
        assert correct_col is not None
        assert correct_col["data_type"] == "boolean"
        assert correct_col["is_nullable"] == "NO"

        created_col = _column_info(conn, "hanja_attempts", "created_at")
        assert created_col is not None
        assert created_col["is_nullable"] == "NO"
        assert created_col["column_default"] is not None  # DEFAULT now()

        assert _constraint_exists(conn, "fk_hanja_attempts_user")
        assert _constraint_exists(conn, "fk_hanja_attempts_card")
        assert _constraint_exists(conn, "ck_hanja_attempts_char_single")
        assert _index_exists(conn, "ix_hanja_attempts_user_created")


def test_059_reapply_is_idempotent(env, dsn: str, full_dir) -> None:
    """Re-running the 059 body against an applied DB is a no-op (IF NOT
    EXISTS on both the table and the index) — the house idempotence bar."""
    _full_up(full_dir)
    body = (REAL_MIGRATIONS_DIR / "059_hanja_attempts.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(body)  # must not raise
        assert _table_exists(conn, "hanja_attempts")
        assert _index_exists(conn, "ix_hanja_attempts_user_created")


# ---------------------------------------------------------------------------
# 2. FK behavior — user CASCADE vs. card SET NULL (deliberately different)
# ---------------------------------------------------------------------------

def test_059_user_fk_cascades(env, dsn: str, full_dir) -> None:
    """Deleting the owning user purges their attempts (mirrors every other
    attempt-log table in this codebase — an attempt has no standalone value
    once its owner is gone)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-cascade@example.com")
        attempt_id = _seed_attempt(conn, user_id, "學")

        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT 1 FROM hanja_attempts WHERE id = %s", (attempt_id,)
            )
            assert cur.fetchone() is None


def test_059_card_fk_sets_null_on_delete(env, dsn: str, full_dir) -> None:
    """Deleting the reviewed card does NOT erase the attempt — the soft FK
    (ON DELETE SET NULL) mirrors writing_attempts.prompt_id: history survives
    the target row's removal."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-cardnull@example.com")
        character_id = _seed_hanja_character(conn, "學")
        card_id = _seed_hanja_card(conn, user_id, character_id)
        attempt_id = _seed_attempt(conn, user_id, "學", card_id=card_id)

        with conn.cursor() as cur:
            cur.execute("DELETE FROM vocab_cards WHERE id = %s", (card_id,))

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT card_id, char FROM hanja_attempts WHERE id = %s",
                (attempt_id,),
            )
            row = cur.fetchone()
            assert row is not None, "attempt row must survive the card's deletion"
            assert row[0] is None  # card_id nulled
            assert row[1] == "學"  # the char snapshot is untouched


# ---------------------------------------------------------------------------
# 3. CHECK / enum domains
# ---------------------------------------------------------------------------

def test_059_char_single_codepoint_check(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-charcheck@example.com")

        with pytest.raises(errors.CheckViolation) as exc:
            _seed_attempt(conn, user_id, "學校")  # two codepoints
        assert exc.value.diag.constraint_name == "ck_hanja_attempts_char_single"


def test_059_rating_enum_rejects_unknown_value(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-ratingcheck@example.com")

        with pytest.raises(errors.InvalidTextRepresentation):
            _seed_attempt(conn, user_id, "學", rating="super-easy")


def test_059_rating_enum_accepts_every_fsrs_value(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-ratingvalues@example.com")
        for rating in ("again", "hard", "good", "easy"):
            _seed_attempt(conn, user_id, "學", rating=rating, correct=rating != "again")

        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT rating, correct FROM hanja_attempts WHERE user_id = %s ORDER BY id",
                (user_id,),
            )
            rows = cur.fetchall()
        assert [r[0] for r in rows] == ["again", "hard", "good", "easy"]
        assert [r[1] for r in rows] == [False, True, True, True]


# ---------------------------------------------------------------------------
# 4. DOWN — table gone, clean re-up
# ---------------------------------------------------------------------------

def test_059_down_drops_table_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    # Live data proves the down works on a non-empty table.
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f171-down@example.com")
        _seed_attempt(conn, user_id, "學")

    # 059's down is DROP TABLE — DOES trip the destructive gate (unlike 058's
    # DROP COLUMN), so --allow-destructive is required here.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--allow-destructive",
            "--target",
            PRE_059,
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_059} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert not _table_exists(conn, "hanja_attempts")
        # Nothing else in the chain regressed — users survives untouched.
        assert _table_exists(conn, "users")

    # Re-up: 059 applies cleanly again (table + constraints + index restored).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "hanja_attempts")
        assert _constraint_exists(conn, "fk_hanja_attempts_user")
        assert _constraint_exists(conn, "fk_hanja_attempts_card")
        assert _index_exists(conn, "ix_hanja_attempts_user_created")
