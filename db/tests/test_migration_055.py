"""Migration 055 (conversation_titles, F-036) — real-chain tests.

WHY THIS FILE EXISTS:
    055 carries two independent guarantees the synthetic harness never sees:
    (1) `conversations.title` — nullable TEXT with a 1..200-char CHECK, added
    WITHOUT disturbing existing rows (add-only expand), and (2) the
    `claude_route` enum gains 'name_conversation' in the SAME migration as the
    column, which is only legal because nothing USES the value in-migration
    (the 021/016 same-transaction enum gotcha). These tests apply the REAL
    migration chain against a Postgres-16 testcontainer via ``migrate.main()``
    and prove: the column shape, the CHECK boundaries (empty / 200 / 201
    chars), that the enum value is USABLE post-commit (a cast + a
    claude_cache-style write), the pre-055 rows' back-compat (NULL titles),
    and the down/re-up cycle (column gone, enum value deliberately retained —
    the 031/032 posture).

DETERMINISM:
    Mirrors test_migration_051.py — the real migration files are copied into
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

# The migration immediately before 055 in the merged chain is 054
# (generated_stories). 055's own down is DROP COLUMN, which does not itself
# trip the destructive gate — but the chain has since grown 059/060/061
# above 055 (each a destructive DROP TABLE down), and `down --target` rolls
# back everything strictly above the target, so this invocation now requires
# --allow-destructive too (see the down test below).
PRE_055 = "054"

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


def _seed_conversation(conn: psycopg.Connection, user_id: int) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO conversations (user_id, mode)
            VALUES (%s, 'casual'::conversation_mode)
            RETURNING id
            """,
            (user_id,),
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


def _enum_has_value(conn: psycopg.Connection, enum: str, value: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            f"SELECT %s = ANY(ARRAY(SELECT e::text FROM unnest(enum_range(NULL::{enum})) AS e))",
            (value,),
        )
        return bool(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# 1. UP — column shape, CHECK boundaries, enum value usable, back-compat
# ---------------------------------------------------------------------------

def test_055_up_schema_shape(env, dsn: str, full_dir) -> None:
    """title column (TEXT NULL, no default), its CHECK, and the enum value."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        col = _column_info(conn, "conversations", "title")
        assert col is not None, "conversations.title missing after 055"
        assert col["data_type"] == "text"
        assert col["is_nullable"] == "YES"
        assert col["column_default"] is None
        assert _constraint_exists(conn, "ck_conversations_title_length")
        assert _enum_has_value(conn, "claude_route", "name_conversation")


def test_055_up_title_lifecycle_and_check_boundaries(env, dsn: str, full_dir) -> None:
    """Rows start unnamed (NULL); valid titles store; the CHECK rejects an
    empty title and one over 200 chars, and accepts exactly 200."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f036@example.com")
        conv = _seed_conversation(conn, user)

        with conn.cursor(row_factory=tuple_row) as cur:
            # Back-compat: a fresh row (the pre-055 insert shape) is unnamed.
            cur.execute("SELECT title FROM conversations WHERE id = %s", (conv,))
            assert cur.fetchone()[0] is None

            # A real content-derived title stores and reads back (Korean OK).
            cur.execute(
                "UPDATE conversations SET title = %s WHERE id = %s RETURNING title",
                ("면접 연습 — job interview", conv),
            )
            assert cur.fetchone()[0] == "면접 연습 — job interview"

            # Exactly 200 chars is legal (boundary inclusive).
            cur.execute(
                "UPDATE conversations SET title = %s WHERE id = %s",
                ("가" * 200, conv),
            )

            # Back to NULL (un-naming) is legal — NULL is exempt from the CHECK.
            cur.execute(
                "UPDATE conversations SET title = NULL WHERE id = %s", (conv,)
            )

        # Empty string → CHECK violation (empty is NOT the same as unnamed).
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET title = '' WHERE id = %s", (conv,)
                )
        # 201 chars → CHECK violation.
        with pytest.raises(errors.CheckViolation):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET title = %s WHERE id = %s",
                    ("가" * 201, conv),
                )


def test_055_up_enum_value_usable_for_cache_and_usage(env, dsn: str, full_dir) -> None:
    """'name_conversation' must be WRITABLE to the claude tables post-commit —
    the exact failure mode 031/032 fixed for earlier routes (invalid input
    value for enum claude_route on every cache/usage write)."""
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT 'name_conversation'::claude_route::text")
            assert cur.fetchone()[0] == "name_conversation"
            # A usage row — the proxy's per-call tracking write.
            cur.execute(
                """
                INSERT INTO claude_usage
                    (request_id, user_id, route, model, was_cache_hit,
                     input_tokens, output_tokens, latency_ms)
                VALUES ('t-055', NULL, 'name_conversation'::claude_route,
                        'claude-haiku-4-5', FALSE, 10, 5, 42)
                RETURNING route::text
                """,
            )
            assert cur.fetchone()[0] == "name_conversation"


def test_055_reapply_is_idempotent(env, dsn: str, full_dir) -> None:
    """Re-running the 055 body against an applied DB is a no-op (IF NOT
    EXISTS + guarded CHECK) — the house idempotence bar."""
    _full_up(full_dir)
    body = (REAL_MIGRATIONS_DIR / "055_conversation_titles.up.sql").read_text(
        encoding="utf-8"
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(body)  # must not raise
        col = _column_info(conn, "conversations", "title")
        assert col is not None
        assert _constraint_exists(conn, "ck_conversations_title_length")


# ---------------------------------------------------------------------------
# 2. DOWN — column + CHECK gone, enum value retained, clean re-up
# ---------------------------------------------------------------------------

def test_055_down_drops_column_keeps_enum_then_reups(env, dsn: str, full_dir) -> None:
    _full_up(full_dir)

    # Live data proves the down works on a non-empty, titled table.
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f036-down@example.com")
        conv = _seed_conversation(conn, user)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE conversations SET title = %s WHERE id = %s",
                ("down-test title", conv),
            )

    # 055's own down is DROP COLUMN — not covered by the destructive gate
    # (DROP TABLE/SCHEMA/DATABASE/TRUNCATE) in isolation. But the chain has
    # since grown 059/060/061 above 055, each a destructive DROP TABLE down,
    # and `down --target` rolls back everything strictly above the target —
    # so --allow-destructive is now required for this invocation to reach
    # 055's own down at all. This no longer doubles as a pure classification
    # probe on 055's own down body (which is still just DROP COLUMN); it's
    # now also traversing 059/060/061's destructive downs to get there.
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_055,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_055} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_info(conn, "conversations", "title") is None
        assert not _constraint_exists(conn, "ck_conversations_title_length")
        # The enum value is DELIBERATELY retained (irreversible in PG without
        # a type rewrite — 031/032 posture).
        assert _enum_has_value(conn, "claude_route", "name_conversation")
        # The conversation row itself survives (only the column is lossy).
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM conversations")
            assert cur.fetchone()[0] == 1

    # Re-up: 055 applies cleanly again (ADD VALUE IF NOT EXISTS is a no-op on
    # the retained enum value; the column + CHECK come back).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        col = _column_info(conn, "conversations", "title")
        assert col is not None and col["is_nullable"] == "YES"
        assert _constraint_exists(conn, "ck_conversations_title_length")
