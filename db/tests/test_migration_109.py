"""Migration 109 (generated_story_publish, #45 public reuse library) —
real-chain tests.

WHY THIS FILE EXISTS:
    109 is the schema half of #45 (opt-in publish + clone-by-reference for
    user-generated stories): `is_shared BOOLEAN NOT NULL DEFAULT false` on
    `generated_stories` — the app's FIRST user-settable shared flag (079's
    audio_sources/book_uploads.is_shared is operator-set-only; this one is
    written by the caller's own owner-gated publish route) — plus
    `source_story_id BIGINT NULL REFERENCES generated_stories(id) ON DELETE
    SET NULL` (clone provenance, a deliberately PLAIN — not composite/
    owner-pinned — self-FK, since a clone's source is by construction
    another account's row) and a partial browse index. The load-bearing
    behaviors mirror 079's: the default must leave every EXISTING story
    private (a row silently becoming shared would be a cross-account
    exposure), NOT NULL must close the three-state gap, and the FK must
    accept a genuine cross-owner reference (the whole point of the column)
    while still rejecting a dangling id and degrading to NULL — never
    RESTRICT — if the referenced row disappears. These tests apply the REAL
    migration chain against a real Postgres-16 testcontainer via
    ``migrate.main()``.

SCOPE:
    - markers: up is non-destructive, down destructive (DROP COLUMN — the
      shape the legacy sniff misses; F-088's point).
    - up: applies on the full real chain; both columns + the FK + the
      partial index exist with the right shape; re-driving the body is a
      no-op (IF NOT EXISTS / DO-guarded ADD CONSTRAINT everywhere).
    - populated-table upgrade: seed two users + a story pre-109, apply 109
      over them — the existing story survives and reads is_shared = false,
      source_story_id = NULL (nothing becomes shared/linked by migrating).
    - post-109 writes: a plain INSERT lands private with no provenance; an
      owner-gated UPDATE (the publish route's shape) flips is_shared; a
      source_story_id CAN reference ANOTHER user's story (the FK is
      deliberately not owner-pinned) but a dangling id is rejected
      (ForeignKeyViolation); deleting the referenced story SETs NULL rather
      than blocking or cascading; NOT NULL rejects a NULL is_shared.
    - down: refused without --allow-destructive; with it, both columns (and
      the FK/index) are gone, the underlying story rows survive; re-up
      restores the columns at their private/NULL defaults.

DETERMINISM:
    Mirrors test_migration_079.py / test_migration_108.py — the real
    migration files are copied into a tmp_path-scoped directory and the
    runner is pointed at it via ``--migrations-dir``; the ``dsn`` fixture
    gives each test a fresh schema.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import tuple_row

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

MIGRATION_NUM = "109"


def _pre_109_target(full_dir: pathlib.Path) -> str:
    """The version immediately before 109 in the chain actually present
    (numbering may have gaps while sibling branches are in flight)."""
    versions = sorted(
        {f.name[:3] for f in full_dir.iterdir() if f.suffix == ".sql"}
    )
    idx = versions.index(MIGRATION_NUM)
    assert idx > 0, "109 cannot be the first migration"
    return versions[idx - 1]


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


def _seed_story(conn: psycopg.Connection, user_id: int, title: str = "모의 이야기") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level, prompt)
            VALUES (%s, %s, '옛날 옛적에 이야기가 있었습니다.', 'L3'::proficiency_level, NULL)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _column_shape(
    conn: psycopg.Connection, column: str
) -> tuple[str, str, str | None] | None:
    """(data_type, is_nullable, column_default) or None if absent."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name='generated_stories'
               AND column_name=%s
            """,
            (column,),
        )
        row = cur.fetchone()
        return (row[0], row[1], row[2]) if row is not None else None


def _constraint_exists(conn: psycopg.Connection, conname: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_constraint "
            "WHERE conname = %s AND conrelid = 'generated_stories'::regclass",
            (conname,),
        )
        return cur.fetchone() is not None


def _index_exists(conn: psycopg.Connection, indexname: str) -> bool:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT 1 FROM pg_indexes WHERE tablename = 'generated_stories' "
            "AND indexname = %s",
            (indexname,),
        )
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_109_marker_classification() -> None:
    up_sql = (
        REAL_MIGRATIONS_DIR / "109_generated_story_publish.up.sql"
    ).read_text(encoding="utf-8")
    down_sql = (
        REAL_MIGRATIONS_DIR / "109_generated_story_publish.down.sql"
    ).read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's data drop is a DROP COLUMN — the exact shape the legacy
    # keyword-sniff misses, so the explicit marker must carry it.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shape (boolean NOT NULL default false / nullable bigint), the FK,
#    the partial index; body re-runnable.
# ---------------------------------------------------------------------------

def test_109_up_shape_and_reapply_is_idempotent(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    up_sql = (
        REAL_MIGRATIONS_DIR / "109_generated_story_publish.up.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        shared_shape = _column_shape(conn, "is_shared")
        assert shared_shape is not None, "generated_stories.is_shared missing"
        data_type, is_nullable, default = shared_shape
        assert data_type == "boolean"
        # NOT NULL is load-bearing: a NULL flag in an authorization
        # predicate is a three-state bug waiting to happen (079's exact
        # reasoning).
        assert is_nullable == "NO", "is_shared must be NOT NULL"
        assert default == "false", (
            f"is_shared default must be false (private), got {default!r}"
        )

        source_shape = _column_shape(conn, "source_story_id")
        assert source_shape is not None, "generated_stories.source_story_id missing"
        data_type, is_nullable, default = source_shape
        assert data_type == "bigint"
        assert is_nullable == "YES", "source_story_id must be nullable (originals)"

        assert _constraint_exists(conn, "fk_generated_stories_source_story")
        assert _index_exists(conn, "ix_generated_stories_shared")

        # Drive the body a second time directly (the runner skips an applied
        # version): every ADD COLUMN/DO-guarded ADD CONSTRAINT/CREATE INDEX
        # must be re-runnable.
        with conn.cursor() as cur:
            cur.execute(up_sql)
        assert _column_shape(conn, "is_shared") == ("boolean", "NO", "false")
        assert _constraint_exists(conn, "fk_generated_stories_source_story")
        assert _index_exists(conn, "ix_generated_stories_shared")


# ---------------------------------------------------------------------------
# 3. UP over a POPULATED table — the real upgrade path AND the security
#    property: an existing story must come out PRIVATE, with no provenance
#    link fabricated.
# ---------------------------------------------------------------------------

def test_109_up_over_populated_table_leaves_every_story_private(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    pre_target = _pre_109_target(full_dir)
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", pre_target,
         "--allow-destructive", "up"]
    )
    assert rc == 0, f"up --target {pre_target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "is_shared") is None
        assert _column_shape(conn, "source_story_id") is None
        user_id = _seed_user(conn, "f45-owner@example.com")
        story_id = _seed_story(conn, user_id)

    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT is_shared, source_story_id, user_id "
                "FROM generated_stories WHERE id = %s",
                (story_id,),
            )
            row = cur.fetchone()
            assert row is not None, "the story row must survive the widen"
            assert row[0] is False, "a pre-109 story must stay PRIVATE"
            assert row[1] is None, "no provenance link may be fabricated"
            assert row[2] == user_id, "the owner must be untouched (never re-owned)"


# ---------------------------------------------------------------------------
# 4. Post-109 writes: default private/no-provenance; owner-gated UPDATE
#    (the publish route's shape) sticks; source_story_id may reference
#    ANOTHER user's story (deliberately not owner-pinned) but not a dangling
#    id; deleting the referenced story SETs NULL; NOT NULL rejects NULL.
# ---------------------------------------------------------------------------

def test_109_insert_defaults_and_publish_update_sticks(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f45-a@example.com")
        story_id = _seed_story(conn, user_id)

        with conn.cursor(row_factory=tuple_row) as cur:
            # The INSERT above never mentioned is_shared/source_story_id —
            # both land at their defaults.
            cur.execute(
                "SELECT is_shared, source_story_id FROM generated_stories WHERE id = %s",
                (story_id,),
            )
            row = cur.fetchone()
            assert row[0] is False
            assert row[1] is None

            # The publish route's exact shape: an owner-scoped UPDATE.
            cur.execute(
                "UPDATE generated_stories SET is_shared = true "
                "WHERE id = %s AND user_id = %s",
                (story_id, user_id),
            )
            cur.execute(
                "SELECT is_shared FROM generated_stories WHERE id = %s", (story_id,)
            )
            assert cur.fetchone()[0] is True

            # NOT NULL holds: the three-state flag is impossible at rest.
            with pytest.raises(errors.NotNullViolation):
                cur.execute(
                    "UPDATE generated_stories SET is_shared = NULL WHERE id = %s",
                    (story_id,),
                )


def test_109_source_story_id_is_cross_owner_but_not_dangling(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        owner_a = _seed_user(conn, "f45-clone-a@example.com")
        owner_b = _seed_user(conn, "f45-clone-b@example.com")
        source_story = _seed_story(conn, owner_a, title="원작 이야기")

        with conn.cursor(row_factory=tuple_row) as cur:
            # The clone route's exact shape: B's NEW story references A's
            # story as its source_story_id — deliberately NOT owner-pinned,
            # since a clone's source is by construction another account's
            # row. This must succeed (the whole point of a plain, not
            # composite, FK).
            cur.execute(
                """
                INSERT INTO generated_stories
                    (user_id, title, body_ko, level, prompt, source_story_id)
                VALUES (%s, '원작 이야기', '옛날 옛적에 이야기가 있었습니다.',
                        'L3'::proficiency_level, NULL, %s)
                RETURNING id
                """,
                (owner_b, source_story),
            )
            clone_id = cur.fetchone()[0]

            cur.execute(
                "SELECT source_story_id FROM generated_stories WHERE id = %s",
                (clone_id,),
            )
            assert cur.fetchone()[0] == source_story

            # A dangling id is rejected — referential integrity is the FK's
            # only job here.
            with pytest.raises(errors.ForeignKeyViolation):
                cur.execute(
                    "UPDATE generated_stories SET source_story_id = 999999999 "
                    "WHERE id = %s",
                    (clone_id,),
                )

        # Deleting the referenced (source) story SETs NULL on the clone —
        # never blocks, never cascades. No story-DELETE route exists today
        # (this action is unreachable from the app), but the FK's shape must
        # already be correct for when one ships.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM generated_stories WHERE id = %s", (source_story,))
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT source_story_id FROM generated_stories WHERE id = %s",
                (clone_id,),
            )
            row = cur.fetchone()
            assert row is not None, "the clone itself must survive its source's deletion"
            assert row[0] is None, "the dangling provenance link degrades to NULL"


# ---------------------------------------------------------------------------
# 5. DOWN — destructive gate; columns/FK/index gone, story rows survive;
#    re-up clean.
# ---------------------------------------------------------------------------

def test_109_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    pre_target = _pre_109_target(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f45-down@example.com")
        story_id = _seed_story(conn, user_id)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE generated_stories SET is_shared = true WHERE id = %s",
                (story_id,),
            )

    # Refused without the flag (DROP COLUMN + explicit marker).
    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", pre_target, "down"]
    )
    assert rc != 0, "109.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", pre_target,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {pre_target} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "is_shared") is None
        assert _column_shape(conn, "source_story_id") is None
        assert not _constraint_exists(conn, "fk_generated_stories_source_story")
        assert not _index_exists(conn, "ix_generated_stories_shared")
        # Lossy on the FLAG/PROVENANCE only: the story row itself survives.
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT user_id FROM generated_stories WHERE id = %s", (story_id,)
            )
            row = cur.fetchone()
            assert row is not None, "the story row must survive the rollback"
            assert row[0] == user_id

    # Round trip: re-up restores both columns at their private/NULL
    # defaults — including on the row that was shared before the rollback.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _column_shape(conn, "is_shared") == ("boolean", "NO", "false")
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT is_shared, source_story_id FROM generated_stories WHERE id = %s",
                (story_id,),
            )
            row = cur.fetchone()
            assert row[0] is False, (
                "after down+up the previously-shared story must be PRIVATE "
                "again — publishing state is genuinely lost, not hidden"
            )
            assert row[1] is None
