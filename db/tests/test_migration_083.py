"""Migration 083 (story illustrations, F-211) — real-chain tests.

WHY THIS FILE EXISTS:
    083 wires generated_stories into an image pipeline mirroring 081's
    story-audio shape: `story_images` (one row per (story, image_number),
    generate-once UNIQUE, owner-pinned composite FK riding 081's
    UNIQUE(id, user_id)) + `story_image_jobs` (the in-server runner's
    claim/settle/ledger table — one live job per story, per-user daily
    job-count cap with an image_count cost snapshot) + the
    'story_image_prompts' claude_route enum value. The load-bearing
    behaviors are the integrity rails the routes and runner lean on: the
    owner guards (cross-user image/job rows must be impossible), the
    generate-once unique, the live-job partial unique, the CHECKs, and the
    CASCADE lifecycles.

SCOPE:
    - markers: up non-destructive, down destructive (two DROP TABLEs —
      the explicit-marker posture, F-088).
    - up: full-chain apply; new tables have the expected shapes;
      well-formed rows insert; the enum value exists.
    - CHECKs: job status; image_count >= 0; image_number >= 1;
      prompt length; width/height >= 1; error length.
    - UNIQUEs: one live (pending|running) job per story — settled rows
      don't collide; one image per (story, image_number) — other slots and
      other stories unaffected.
    - Owner guards: an image or job pairing story A's id with user B is
      rejected (composite FK).
    - Lifecycles: deleting a story CASCADE-deletes its jobs AND its images;
      deleting a user CASCADE-deletes both.
    - down: refused without --allow-destructive; with it, both tables are
      gone, stories survive, the enum value REMAINS (Postgres cannot drop
      enum values — documented in the down header); re-up round-trips.

DETERMINISM:
    Mirrors test_migration_081.py — real migration files copied into a
    tmp_path dir, runner pointed via --migrations-dir, fresh schema per test.
"""

from __future__ import annotations

import pathlib

import psycopg
import pytest
from psycopg.rows import tuple_row

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

# The migration immediately before 083. `down --target PRE_083` rolls back
# ONLY 083 (its DROP TABLE down requires the flag).
PRE_083 = "082"


EXPECTED_IMAGE_COLUMNS = {
    "id",
    "generated_story_id",
    "user_id",
    "image_number",
    "blob_ref",
    "prompt",
    "width",
    "height",
    "created_at",
    "updated_at",
    "version",
}

EXPECTED_JOB_COLUMNS = {
    "id",
    "generated_story_id",
    "user_id",
    "status",
    "image_count",
    "cost_estimate_usd",
    "error",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
    "version",
}


# ---------------------------------------------------------------------------
# Seed helpers — raw SQL, no app layer involved
# ---------------------------------------------------------------------------


def _seed_story(conn: psycopg.Connection, user_id: int, title: str = "모의 이야기") -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO generated_stories (user_id, title, body_ko, level)
            VALUES (%s, %s, '옛날 옛적에 이야기가 있었습니다.', 'L3'::proficiency_level)
            RETURNING id
            """,
            (user_id, title),
        )
        return cur.fetchone()[0]


def _insert_job(
    conn: psycopg.Connection,
    story_id: int,
    user_id: int,
    *,
    status: str = "pending",
    image_count: int = 3,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO story_image_jobs (generated_story_id, user_id, status, image_count)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (story_id, user_id, status, image_count),
        )
        return cur.fetchone()[0]


def _insert_image(
    conn: psycopg.Connection,
    story_id: int,
    user_id: int,
    *,
    image_number: int = 1,
    prompt: str = "a webtoon-style scene, no text in image",
    width: int = 1024,
    height: int = 1024,
) -> int:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            INSERT INTO story_images
                    (generated_story_id, user_id, image_number, blob_ref,
                     prompt, width, height)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                story_id,
                user_id,
                image_number,
                f"{user_id}/00000000-0000-4000-8000-0000000000{image_number:02d}.png",
                prompt,
                width,
                height,
            ),
        )
        return cur.fetchone()[0]


def _table_columns(conn: psycopg.Connection, table: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_schema='public' AND table_name=%s
            """,
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def _enum_values(conn: psycopg.Connection) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT e::text FROM unnest(enum_range(NULL::claude_route)) AS e"
        )
        return {r[0] for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# 1. F-088 marker classification.
# ---------------------------------------------------------------------------

def test_083_marker_classification() -> None:
    up_sql = (REAL_MIGRATIONS_DIR / "083_story_images.up.sql").read_text(encoding="utf-8")
    down_sql = (REAL_MIGRATIONS_DIR / "083_story_images.down.sql").read_text(encoding="utf-8")
    assert migrate.explicit_destructiveness(up_sql) is False
    # The down's two DROP TABLEs are a data drop.
    assert migrate.explicit_destructiveness(down_sql) is True
    assert migrate.contains_destructive(down_sql)


# ---------------------------------------------------------------------------
# 2. UP — shapes on the full chain; well-formed rows insert; enum widened.
# ---------------------------------------------------------------------------

def test_083_up_shapes_and_happy_path(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_images") == EXPECTED_IMAGE_COLUMNS
        assert _table_columns(conn, "story_image_jobs") == EXPECTED_JOB_COLUMNS
        assert "story_image_prompts" in _enum_values(conn)

        user_id = _seed_user(conn, "f211-shape@example.com")
        story_id = _seed_story(conn, user_id)

        # The whole illustrated shape lands: a job that settles done + the
        # ordered image rows.
        job_id = _insert_job(conn, story_id, user_id, image_count=3)
        for n in (1, 2, 3):
            _insert_image(conn, story_id, user_id, image_number=n)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "UPDATE story_image_jobs SET status = 'done' WHERE id = %s",
                (job_id,),
            )
            cur.execute(
                "SELECT status, image_count FROM story_image_jobs WHERE id = %s",
                (job_id,),
            )
            assert cur.fetchone() == ("done", 3)
            cur.execute(
                """
                SELECT image_number, width, height
                  FROM story_images
                 WHERE generated_story_id = %s
                 ORDER BY image_number
                """,
                (story_id,),
            )
            assert cur.fetchall() == [(1, 1024, 1024), (2, 1024, 1024), (3, 1024, 1024)]


# ---------------------------------------------------------------------------
# 3. Integrity rails — CHECKs.
# ---------------------------------------------------------------------------

def test_083_job_status_and_image_count_checks(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-jobck@example.com")
        story_id = _seed_story(conn, user_id)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_job(conn, story_id, user_id, status="queued")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_job(conn, story_id, user_id, image_count=-1)
        # Boundary: 0 is legal (ledger floor decoupled — 076/081's stance).
        _insert_job(conn, story_id, user_id, image_count=0)


def test_083_image_row_checks(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-imgck@example.com")
        story_id = _seed_story(conn, user_id)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_image(conn, story_id, user_id, image_number=0)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_image(conn, story_id, user_id, prompt="")
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_image(conn, story_id, user_id, prompt="x" * 4001)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_image(conn, story_id, user_id, width=0)
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert_image(conn, story_id, user_id, height=0)
        # Boundary: the proxy's 3800-char scene-prompt cap fits under the
        # 4000 DB ceiling.
        _insert_image(conn, story_id, user_id, prompt="x" * 3800)


def test_083_job_error_length_check(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-errck@example.com")
        story_id = _seed_story(conn, user_id)
        job_id = _insert_job(conn, story_id, user_id)
        with conn.cursor() as cur:
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "UPDATE story_image_jobs SET status='failed', error=%s WHERE id=%s",
                    ("x" * 2001, job_id),
                )
            cur.execute(
                "UPDATE story_image_jobs SET status='failed', error=%s WHERE id=%s",
                ("x" * 2000, job_id),
            )


# ---------------------------------------------------------------------------
# 4. UNIQUEs — one live job per story; one image per (story, slot).
# ---------------------------------------------------------------------------

def test_083_one_live_job_per_story(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-live@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_job(conn, story_id, user_id, status="pending")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_job(conn, story_id, user_id, status="pending")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_job(conn, story_id, user_id, status="running")
        # Settled rows never collide — the cap ledger can stack freely.
        _insert_job(conn, story_id, user_id, status="failed")
        _insert_job(conn, story_id, user_id, status="failed")
        # And another STORY's live job is unaffected.
        other_story = _seed_story(conn, user_id, title="다른 이야기")
        _insert_job(conn, other_story, user_id, status="pending")


def test_083_one_image_per_story_slot(env, dsn: str, full_dir: pathlib.Path) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-once@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_image(conn, story_id, user_id, image_number=1)
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert_image(conn, story_id, user_id, image_number=1)
        # Other slots and other stories are unaffected.
        _insert_image(conn, story_id, user_id, image_number=2)
        other_story = _seed_story(conn, user_id, title="다른 이야기")
        _insert_image(conn, other_story, user_id, image_number=1)


# ---------------------------------------------------------------------------
# 5. Owner guards — cross-user image/job rows are structurally impossible.
# ---------------------------------------------------------------------------

def test_083_composite_owner_fks_reject_cross_user_rows(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        owner = _seed_user(conn, "f211-owner@example.com")
        attacker = _seed_user(conn, "f211-attacker@example.com")
        story_id = _seed_story(conn, owner)
        # A job charging the ATTACKER for the OWNER's story → FK violation.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            _insert_job(conn, story_id, attacker)
        # An image hanging the OWNER's story into the ATTACKER's library
        # → FK violation.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            _insert_image(conn, story_id, attacker)


# ---------------------------------------------------------------------------
# 6. Lifecycles — CASCADE with the story AND the user.
# ---------------------------------------------------------------------------

def test_083_story_delete_cascades_jobs_and_images(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-cascade@example.com")
        story_id = _seed_story(conn, user_id)
        job_id = _insert_job(conn, story_id, user_id, status="failed")
        image_id = _insert_image(conn, story_id, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM generated_stories WHERE id = %s", (story_id,))
            for table, row_id in (
                ("story_image_jobs", job_id),
                ("story_images", image_id),
            ):
                cur.execute(f"SELECT 1 FROM {table} WHERE id = %s", (row_id,))  # noqa: S608
                assert cur.fetchone() is None, f"{table} row must CASCADE with the story"


def test_083_user_delete_cascades_jobs_and_images(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-usercas@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_job(conn, story_id, user_id, status="failed")
        _insert_image(conn, story_id, user_id)
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cur.execute("SELECT count(*) FROM story_image_jobs")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM story_images")
            assert cur.fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 7. DOWN — destructive gate; reversal drops the tables; re-up works.
# ---------------------------------------------------------------------------

def test_083_down_requires_allow_destructive_then_reverses_cleanly(
    env, dsn: str, full_dir: pathlib.Path
) -> None:
    _full_up(full_dir)

    with psycopg.connect(dsn, autocommit=True) as conn:
        user_id = _seed_user(conn, "f211-down@example.com")
        story_id = _seed_story(conn, user_id)
        _insert_job(conn, story_id, user_id, status="failed")
        _insert_image(conn, story_id, user_id)

    # Refused without the flag.
    rc = migrate.main(["--migrations-dir", str(full_dir), "--target", PRE_083, "down"])
    assert rc != 0, "083.down is destructive — the gate must refuse it without the flag"

    rc = migrate.main(
        ["--migrations-dir", str(full_dir), "--target", PRE_083,
         "--allow-destructive", "down"]
    )
    assert rc == 0, f"down --target {PRE_083} returned {rc}"

    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_images") == set()
        assert _table_columns(conn, "story_image_jobs") == set()
        with conn.cursor(row_factory=tuple_row) as cur:
            # The story itself survives the rollback (only the image layer is
            # lossy).
            cur.execute("SELECT 1 FROM generated_stories WHERE id = %s", (story_id,))
            assert cur.fetchone() is not None
        # Postgres cannot drop enum values — 'story_image_prompts' remains
        # (documented in the down header; harmless once the route code is
        # gone).
        assert "story_image_prompts" in _enum_values(conn)

    # Round trip: re-up restores the full 083 shape.
    _full_up(full_dir)
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert _table_columns(conn, "story_images") == EXPECTED_IMAGE_COLUMNS
        assert _table_columns(conn, "story_image_jobs") == EXPECTED_JOB_COLUMNS
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute("SELECT count(*) FROM story_image_jobs")
            assert cur.fetchone()[0] == 0
