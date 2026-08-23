"""Migration 054 (generated_stories, ticket F-068) — real-chain tests.

WHY THIS FILE EXISTS:
    054 is the storage half of the story-generation feature: a user-owned
    table the reading page lists and re-opens. Its value is in the lifecycle
    + bounds topology: the users FK CASCADE (stories die with their owner),
    the proficiency_level-typed level column (a closed set, not free text),
    the length/positivity CHECKs that floor the route's Zod caps, the
    (user_id, created_at DESC) index the ONLY list query rides, and the
    updated_at trigger. The synthetic harness tests (test_migrations.py)
    never see the real file; these tests apply the REAL migration chain
    against a real Postgres-16 testcontainer via ``migrate.main()`` and PROVE
    each guard by attempting the write it must reject.

SCOPE:
    - up: table + identity PK shape; users FK CASCADEs on user delete; level
      rejects a non-enum value; title/body/prompt length CHECKs; prompt is
      nullable; updated_at trigger bumps; the list index exists with the
      expected key.
    - down: generated_stories dropped (destructive gate) — everything else
      untouched; re-up clean.

DETERMINISM:
    Mirrors test_migration_051.py — the real migration files are copied into
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

# The migration immediately before 054. `down --target PRE_054` rolls back
# ONLY 054 (its DROP TABLE down is what requires --allow-destructive).
PRE_054 = "053"


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _insert_story(
    conn: psycopg.Connection,
    user_id: int,
    title: str = "모의 이야기",
    body: str = "옛날 옛적에 이야기가 있었습니다.",
    level: str = "L3",
    prompt: str | None = None,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level, prompt)
            VALUES (%s, %s, %s, %s::proficiency_level, %s)
            RETURNING id
            """,
            (user_id, title, body, level, prompt),
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
# 1. UP — schema shape + every guard proven by the write it must reject
# ---------------------------------------------------------------------------

def test_054_up_schema_shape(env, dsn: str, full_dir) -> None:
    """Full-chain up: the table exists with an identity BIGINT PK, the users
    FK CASCADEs, level is the proficiency_level enum, and the list index
    (user_id, created_at DESC) exists."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        assert _table_exists(conn, "generated_stories")

        with conn.cursor() as cur:
            # users FK: ON DELETE CASCADE, ON UPDATE RESTRICT.
            cur.execute(
                """
                SELECT confrelid::regclass::text AS target,
                       confdeltype, confupdtype
                  FROM pg_constraint
                 WHERE conname = 'fk_generated_stories_user'
                """
            )
            fk = cur.fetchone()
            assert fk is not None, "users FK missing"
            assert fk["target"] == "users"
            assert fk["confdeltype"] == "c", "users FK must CASCADE"
            assert fk["confupdtype"] == "r", "users FK must be ON UPDATE RESTRICT"

            # level is the shared proficiency_level enum, NOT free text.
            cur.execute(
                """
                SELECT udt_name FROM information_schema.columns
                 WHERE table_name = 'generated_stories' AND column_name = 'level'
                """
            )
            col = cur.fetchone()
            assert col is not None and col["udt_name"] == "proficiency_level"

            # The one list query's index: leading user_id, created_at DESC.
            cur.execute(
                """
                SELECT indexdef FROM pg_indexes
                 WHERE indexname = 'ix_generated_stories_user_created'
                """
            )
            idx = cur.fetchone()
            assert idx is not None, "list index missing"
            assert "user_id, created_at DESC" in idx["indexdef"]


def test_054_up_row_lifecycle_and_checks(env, dsn: str, full_dir) -> None:
    """Bounds + lifecycle: garbage level rejected at the enum; empty title /
    empty body / empty-string prompt rejected by the CHECKs; NULL prompt
    fine; updated_at bumps on UPDATE; deleting the user cascades the story
    away."""
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        user = _seed_user(conn, "f068-lifecycle@example.com")

        # level is a closed enum: a non-member is rejected at the cast.
        with pytest.raises(errors.InvalidTextRepresentation):
            _insert_story(conn, user, level="L9")

        # Length CHECKs (the DB floor under the route's Zod caps).
        with pytest.raises(errors.CheckViolation):
            _insert_story(conn, user, title="")
        with pytest.raises(errors.CheckViolation):
            _insert_story(conn, user, body="")
        with pytest.raises(errors.CheckViolation):
            _insert_story(conn, user, prompt="")  # NULL ok, empty string not
        with pytest.raises(errors.CheckViolation):
            _insert_story(conn, user, title="x" * 301)

        # A legal row: NULL prompt, in-bounds text, enum level.
        story_id = _insert_story(conn, user, prompt=None)
        # And one with a prompt (the topic).
        _insert_story(conn, user, title="두 번째", prompt="고양이 카페")

        # updated_at trigger fires on UPDATE.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM generated_stories WHERE id = %s", (story_id,)
            )
            before = cur.fetchone()["updated_at"]
            cur.execute(
                "UPDATE generated_stories SET title = '수정된 제목' WHERE id = %s",
                (story_id,),
            )
            cur.execute(
                "SELECT updated_at FROM generated_stories WHERE id = %s", (story_id,)
            )
            after = cur.fetchone()["updated_at"]
        assert after > before, "set_updated_at trigger must bump updated_at"

        # Deleting the user cascades every story away.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user,))
            cur.execute(
                "SELECT count(*) FROM generated_stories WHERE user_id = %s", (user,)
            )
            assert cur.fetchone()[0] == 0, "stories must CASCADE with their user"


# ---------------------------------------------------------------------------
# 2. DOWN — the table dropped, nothing else touched, then a clean re-up
# ---------------------------------------------------------------------------

def test_054_down_drops_table_then_reups(env, dsn: str, full_dir) -> None:
    """Rolling back 054 must drop generated_stories (and nothing else — the
    users table and the 053 enum values are untouched), and a subsequent up
    must re-apply 054 cleanly."""
    _full_up(full_dir)

    # Live data in the table proves the down works on a non-empty table.
    with psycopg.connect(dsn, autocommit=True) as conn:
        user = _seed_user(conn, "f068-down@example.com")
        _insert_story(conn, user)

    # --allow-destructive: 054's down contains DROP TABLE (deliberate:
    # rollback = accepted loss of the regenerable story library).
    rc = migrate.main(
        [
            "--migrations-dir",
            str(full_dir),
            "--target",
            PRE_054,
            "--allow-destructive",
            "down",
        ]
    )
    assert rc == 0, f"down --target {PRE_054} returned {rc}"

    with psycopg.connect(dsn, autocommit=True, row_factory=tuple_row) as conn:
        assert not _table_exists(conn, "generated_stories")
        # Neighbors untouched: users intact, 053's enum values still present.
        assert _table_exists(conn, "users")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e"
            )
            values = {row[0] for row in cur.fetchall()}
        assert "generate_story" in values

    # Re-up: 054 applies cleanly again (CREATE TABLE IF NOT EXISTS + fresh state).
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_exists(conn, "generated_stories")
